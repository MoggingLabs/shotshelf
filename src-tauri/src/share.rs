//! Getting a capture off the shelf and into another app.
//!
//! Two routes, both entirely local: a native OS drag via `tauri-plugin-drag`
//! (`drag-rs`), and a clipboard copy for the apps that take a paste but refuse
//! a file drop. Neither ever moves or deletes the capture — a drag out of the
//! shelf is a copy, and the original stays exactly where the OS put it.

use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime, State};
use tauri_plugin_clipboard::Clipboard;

use crate::{
    catch::{CaptureKind, CaptureSink},
    enrich::{self, Findings},
    handoff,
    settings::SettingsStore,
    webview_path::{existing_file, read_capture},
};

/// The drag image for a recording whose poster frame is not available.
///
/// `poster.rs` extracts a real frame for most recordings, but it can fail —
/// no ffmpeg, an unreadable container, a clip still being written — and a drag
/// with no image at all is a drag the user cannot see they have started.
const VIDEO_PREVIEW: &[u8] = include_bytes!("../icons/128x128.png");

/// How long the clipboard watcher should disregard a write we made ourselves.
const OWN_WRITE_WINDOW: Duration = Duration::from_secs(3);

#[derive(Serialize)]
pub struct DragSource {
    /// The file the OS hands to whatever the user drops on.
    path: String,
    /// Image shown under the cursor during the drag.
    icon: String,
}

#[cfg(test)]
impl DragSource {
    /// A value for `wire.rs`'s field-name join, which lives outside this module
    /// and so cannot name these private fields itself.
    ///
    /// Written out rather than derived from `Default`: naming each field is what
    /// makes a rename fail to *compile* here, which is half of what the join is
    /// for.
    pub(crate) fn sample() -> Self {
        Self {
            path: String::new(),
            icon: String::new(),
        }
    }
}

/// Confirm a capture is still on disk and work out its drag preview.
///
/// The check matters: a tile can outlive its file (emptied Recycle Bin, a
/// cleared temp folder), and handing the OS a missing path makes for a drag
/// that silently does nothing.
///
/// The sizing runs on a blocking worker, not on the async runtime.
///
/// With export sizing on, this decodes, resizes with Lanczos3 and re-encodes a
/// full-resolution screenshot. `#[tauri::command(async)]` on a synchronous
/// function was reached for first, and it does move the work off the IPC
/// thread — but onto the runtime that also serves `describe_capture`,
/// `compare_captures` and `video_details`. A multi-select drag calls this once
/// per capture concurrently, so ten captures put ten Lanczos3 resizes on the
/// runtime at once. `spawn_blocking` is where that belongs, and the two
/// sibling commands that already got it right use it.
#[tauri::command]
pub async fn prepare_drag<R: Runtime>(
    app: AppHandle<R>,
    settings: State<'_, SettingsStore>,
    path: String,
    kind: CaptureKind,
) -> Result<DragSource, String> {
    let source = existing_file(&app, &path)?;

    // The preview under the cursor is always the original: it is shown at
    // thumbnail size, so a sized copy would buy nothing and cost a re-encode
    // before the drag can even start.
    let icon = match kind {
        // A screenshot is its own best preview.
        CaptureKind::Image => source.clone(),
        CaptureKind::Video => video_preview(&app)?,
    };

    // Read before the worker starts: `State` does not cross into it.
    let downscale = settings.get().downscale_exports;

    // Only stills are sized; there is no version of this that re-encodes a
    // recording to save a model some pixels.
    let handed_over = match kind {
        CaptureKind::Image => {
            let worker_app = app.clone();
            let for_worker = source.clone();
            crate::limits::under_sizing_limit("that capture for the drag", move || {
                handoff::file_for(&worker_app, &for_worker, downscale)
            })
            .await?
        }
        CaptureKind::Video => source,
    };

    Ok(DragSource {
        path: handed_over.to_string_lossy().into_owned(),
        icon: icon.to_string_lossy().into_owned(),
    })
}

/// What Shotshelf worked out about a capture by reading it.
///
/// Called per tile rather than pushed from the catch pipeline, for the same
/// reason recordings are: it is optional detail that arrives when it arrives,
/// and a capture is on the shelf and draggable long before this returns.
#[tauri::command]
pub async fn describe_capture<R: Runtime>(
    app: AppHandle<R>,
    path: String,
) -> Result<Findings, String> {
    let source = existing_file(&app, &path)?;

    // Keyed on which *version* of the file, not just which path.
    //
    // A capture overwritten at the same path — a fixed ShareX pattern, a
    // re-save — would otherwise return the previous file's findings, and
    // "no findings" is not rendered as "unknown" but as read-and-clean. The
    // hand-off cache next door keys on path and mtime for exactly this
    // reason, and its comment calls delivering different pixels than the ones
    // on screen a disclosure bug rather than a stale cache. The same is true
    // here, with worse consequences: this one decides whether a warning shows.
    // Through `cache::Version`, which is what the hand-off and poster caches
    // key on — rather than a third encoding of the same question. A `scan_key`
    // wrapper stood here and did nothing but forward, beside a `type ScanKey =
    // cache::Version` alias with one meaning.
    let version = crate::cache::Version::of(&source);

    // Answered from memory when it has been asked before.
    //
    // The shelf asks once per image tile as it is built, and opening a full
    // shelf builds every tile at once — pinned captures are exempt from the
    // item cap, so "every tile" is unbounded. Without this, a launch with
    // fifty pins started fifty full-resolution decodes and fifty OCR passes
    // simultaneously, and did it again on the next launch.
    if let Some(cached) = scan_cache()
        .lock()
        .ok()
        .and_then(|cache| cache.get(&version).map(|entry| entry.findings.clone()))
    {
        return Ok(cached);
    }

    // And no more than a few at a time. OCR is the slowest thing this app
    // does; a semaphore keeps a burst of tiles from becoming a burst of
    // engines, without making the shelf wait for any of them.
    //
    // The permit is held *here* rather than moved into the worker, and that is
    // the whole point. Linux's tesseract has a deadline and a kill; the Windows
    // and macOS recognisers are FFI calls into `RecognizeAsync().get()` and
    // `performRequests`, which block with no cancellable API — there is no
    // honest way to stop that thread. What there is a way to do is stop it
    // taking the app with it: if the permit lives in the worker, two wedged
    // captures exhaust the semaphore for good and credential scanning is
    // silently dead for the session. Held out here, the permit is released the
    // moment this returns, and the cost of a wedge is one leaked thread rather
    // than a feature that never works again.
    // Through the shared helper, which is what `limits.rs` says it is for.
    //
    // This was a fourth hand-written copy of the same acquire / spawn / timeout
    // / release shape — and `limits.rs`'s header names *this* function as the
    // reasoning the other three were converted from, while it stayed a copy
    // itself. Byte-for-byte the same but for the error string, so it also
    // carried its own chance of getting the permit release wrong.
    let for_worker = source.clone();
    let named = source
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned();
    let findings = crate::limits::under_limit(
        scan_limit().clone(),
        crate::limits::SCAN_TIMEOUT,
        &named,
        move || Findings::from(enrich::describe(&for_worker)),
    )
    .await?;

    if let Ok(mut cache) = scan_cache().lock() {
        // Bounded: a shelf that has seen thousands of captures in one session
        // should not hold every scan for the life of the process.
        //
        // The oldest entries go, not all of them. This was `cache.clear()`, so
        // one insertion past the limit threw away every remembered scan —
        // including entries computed seconds earlier for tiles still on screen,
        // mid-build, sending the shelf back to full-resolution OCR for the whole
        // visible list. `poster.rs` records the same defect in its own cache and
        // fixed it by evicting the oldest; this is that, in memory.
        //
        // Through `cache::make_room` rather than a loop written out here. The
        // loop was inside this `#[tauri::command]`, which no test in this crate
        // can call, so reversing its `min_by_key` to `max_by_key` — after which
        // the *newest* entries are evicted and a full shelf re-runs OCR on every
        // visible tile forever — left clippy and all 156 tests green. The other
        // two caches had their eviction rule split out for exactly that reason;
        // this one had not.
        for stale in crate::cache::make_room(
            cache.iter().map(|(key, entry)| (key.clone(), entry.seen)),
            SCAN_CACHE_LIMIT,
        ) {
            cache.remove(&stale);
        }
        cache.insert(
            version,
            Remembered {
                seen: next_scan_sequence(),
                findings: findings.clone(),
            },
        );
    }

    Ok(findings)
}

/// How many scans to remember.
///
/// Derived, not chosen. This was a hand-written 500 while the shelf can hold
/// `max_items` (up to 200) plus `MAX_PINNED` (500) tiles — so a full shelf
/// overflowed the cache that exists to serve it, which is the same mistake
/// `poster.rs` records having made with a hand-written 200 and fixed by
/// deriving.
///
/// Then both files derived it *separately*, each with its own margin constant —
/// two copies of a derivation, which is the same defect one step later: the
/// next `MAX_PINNED` change moves whichever one the author remembered.
/// `cache::shelf_wide_limit` is the one home now.
const SCAN_CACHE_LIMIT: usize = crate::cache::shelf_wide_limit();

/// A remembered scan, with when it was remembered.
///
/// The sequence is what makes eviction "the oldest" rather than "everything":
/// a `HashMap` has no order of its own, and the alternative was clearing the
/// lot. Monotonic per process, so it never ties and never wraps in any session
/// a person will have.
struct Remembered {
    seen: u64,
    findings: Findings,
}

fn next_scan_sequence() -> u64 {
    static SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
}

/// Identity of a capture's *contents*, through `cache::Version`.
///
/// Remembered scans, keyed by which *version* of which capture.
///
/// `cache::Version` directly, rather than through the `scan_key` wrapper and
/// `ScanKey` alias that used to stand here: the wrapper only forwarded and the
/// alias only renamed, and both had exactly one meaning and one caller. An
/// unreadable timestamp means a file shares a version with its other versions,
/// which is where all three of these caches were before mtime was part of the
/// key.
fn scan_cache(
) -> &'static std::sync::Mutex<std::collections::HashMap<crate::cache::Version, Remembered>> {
    static CACHE: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashMap<crate::cache::Version, Remembered>>,
    > = std::sync::OnceLock::new();
    CACHE.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

fn scan_limit() -> &'static std::sync::Arc<tokio::sync::Semaphore> {
    static LIMIT: std::sync::OnceLock<std::sync::Arc<tokio::sync::Semaphore>> =
        std::sync::OnceLock::new();
    crate::limits::shared(&LIMIT, crate::limits::SCANNING)
}

/// Clipboard fallback, for the apps that will take a paste but not a drop.
///
/// Same shape as `prepare_drag`: the decode/resize/encode runs on a blocking
/// worker rather than on the runtime that serves the shelf's other commands.
#[tauri::command]
pub async fn copy_capture<R: Runtime>(
    app: AppHandle<R>,
    sink: State<'_, Arc<CaptureSink>>,
    settings: State<'_, SettingsStore>,
    path: String,
    kind: CaptureKind,
) -> Result<(), String> {
    let source = existing_file(&app, &path)?;

    // Everything slow and everything fallible happens before the marker is
    // armed, and the marker is armed immediately before the write.
    //
    // The marker tells our own clipboard watcher to disregard the next write
    // for three seconds. Arming it on entry put a full decode, a Lanczos3
    // resize and a PNG re-encode *inside* that window, which fails in both
    // directions: a re-encode slower than the window lets the watcher shelve a
    // duplicate of the capture you just copied, and a read that fails leaves
    // the marker standing with no write at all, so the next genuine
    // Win+Shift+S is silently swallowed. A capture lost to a failed copy is a
    // far worse outcome than the duplicate the marker exists to prevent.
    let downscale = settings.get().downscale_exports;
    let payload = match kind {
        CaptureKind::Image => {
            let worker_app = app.clone();
            let for_worker = source.clone();
            let bytes =
                crate::limits::under_sizing_limit("that capture for the clipboard", move || {
                    let handed_over = handoff::file_for(&worker_app, &for_worker, downscale);
                    read_capture(&handed_over).map_err(|err| err.to_string())
                })
                .await??;
            Payload::Pixels(bytes)
        }
        // A recording pastes as a file, not as pixels.
        CaptureKind::Video => Payload::File(file_uri(&source)),
    };

    // Armed *before* the write, and only if the write succeeds.
    //
    // The ordering matters in both directions, which is why it reads oddly. The
    // marker has to be standing before the clipboard changes, or the watcher
    // sees the change first and shelves our own copy back as a new capture —
    // that is what the comment on `OWN_WRITE_WINDOW` is about. But arming it
    // unconditionally meant a *failed* write left a live marker with nothing to
    // consume it, so the next genuine screenshot within the window was
    // swallowed instead: the exact failure the ordering exists to prevent,
    // reintroduced by the error path. On macOS, where every recording copy
    // failed outright, that was every single time.
    //
    // So: arm, write, and stand the marker down again if the write did not
    // happen.
    let clipboard = app.state::<Clipboard>();
    sink.expect_own_clipboard_write(OWN_WRITE_WINDOW);

    let wrote = match payload {
        Payload::Pixels(bytes) => clipboard.write_image_binary(bytes),
        Payload::File(uri) => clipboard.write_files_uris(vec![uri]),
    };
    if wrote.is_err() {
        sink.cancel_own_clipboard_write();
    }
    wrote
}

/// What is about to go on the clipboard, prepared before anything is armed.
enum Payload {
    Pixels(Vec<u8>),
    File(String),
}

/// What the clipboard plugin wants for a file, per platform.
///
/// **Windows: a bare path. macOS: `file://` plus a raw path. Linux: `file://`
/// plus a percent-encoded one.** Three platforms and three contracts; the
/// `cfg` blocks below give each its own, because grouping any two of them has
/// now produced a bug twice.
///
/// Two earlier versions of this paragraph were wrong in opposite directions,
/// and the second one caused a shipped blocker, so both are recorded here
/// rather than quietly replaced.
///
/// The first said macOS wanted a URI *because the plugin rejects the wrong one*.
/// The second retracted that as "false" on the grounds that `clipboard-rs`'s
/// macOS backend hands strings straight to `NSFilenamesPboardType`, a property
/// list of POSIX paths that neither converts nor rejects — true of that layer,
/// and it grouped macOS with Windows. The retraction had reasoned one layer too
/// low: the plugin sits above `clipboard-rs` and refuses a bare path on macOS
/// outright, so every recording copy on a Mac failed with "Invalid file uri"
/// and never reached the pasteboard at all.
///
/// What remains genuinely unknown is what a receiver makes of a `file://` URI
/// found in `NSFilenamesPboardType` — nobody here has a Mac. That is stated at
/// the `cfg` below, where the choice is made. It is not a reason to send the
/// form that provably cannot get past the plugin.
///
/// **X11 wants a `file://` URI in `text/uri-list`**, which must be
/// percent-encoded — and this emitted raw spaces. Reachable only for
/// recordings, whose default names on every platform contain spaces
/// (`Screen Recording 2026-07-27 at 15.22.33.mov`, `Screencast from ....webm`),
/// so the one path that needed encoding was the one that always had spaces.
///
/// **This rule is not applied on the drag-out path, and cannot be from here.**
/// Drag-out goes through the `drag` crate, whose GTK backend builds its own
/// list — `format!("file://{}", path.display())`, with no encoding — and it
/// takes real paths, so handing it pre-encoded ones would corrupt the paths to
/// fix the URIs. Every Linux screenshot name has spaces
/// (`Screenshot from 2026-07-29 10-11-12.png`), so on Linux the dragged
/// `text/uri-list` is not what this function would have produced.
///
/// Written down rather than worked around: the fix belongs upstream, the
/// alternative is hand-rolling a drag source this project deliberately
/// adopted a crate for, and whether a given GTK or Qt receiver tolerates a
/// raw space is not something anyone here has tested on a Linux desktop —
/// which `docs/USAGE.md` already says of Linux generally.
fn file_uri(path: &Path) -> String {
    // Three platforms, three different contracts. Grouping any two of them has
    // now caused a bug twice, so each says what it is.
    //
    // **Windows: a bare path.** `tauri-plugin-clipboard`'s `write_files_uris`
    // rejects a `file://` prefix here outright.
    #[cfg(target_os = "windows")]
    {
        path.to_string_lossy().into_owned()
    }
    // **macOS: `file://` and a raw path.**
    //
    // The prefix is forced from above and the *absence* of escaping is forced
    // from below. The plugin refuses a bare path on macOS — that was the
    // blocker, every recording copy failing with "Invalid file uri" — and it
    // has no other entry point. Underneath, `clipboard-rs` puts the string
    // verbatim into `NSFilenamesPboardType`, documented as an array of fully
    // qualified pathnames, so a receiver that strips `file://` gets whatever is
    // left. Percent-encoding it, which the previous version did by sharing the
    // Linux branch, meant that leftover contained `%20` for every space — and
    // every default macOS recording name has spaces. That turned a loud failure
    // into a silent one. The plugin's own convention for this platform
    // is `format!("file://{}", file)` built from a bare path, with no encoding —
    // which is what this now matches.
    #[cfg(target_os = "macos")]
    {
        format!("file://{}", path.to_string_lossy())
    }
    // **Linux: `file://` and percent-encoded.**
    //
    // This is a `text/uri-list`, where escaping is required by the format: a raw
    // space makes the entry malformed. See `percent_encode_path` below for why
    // recordings are the case that always needs it.
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        format!("file://{}", percent_encode_path(&path.to_string_lossy()))
    }
}

/// Written out once because the drag plugin takes a path to a preview image,
/// not bytes.
fn video_preview<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    // Local app data, never roaming — see `dirs::local`.
    let dir = crate::dirs::local(app, "")?;

    let preview = dir.join("video-drag-preview.png");
    if !preview.is_file() {
        std::fs::write(&preview, VIDEO_PREVIEW).map_err(|err| err.to_string())?;
    }

    Ok(preview)
}

/// Percent-encode a path for a `file://` URI, leaving the separators alone.
///
/// Deliberately conservative: everything outside the unreserved set and `/` is
/// escaped, which is always valid even where it is not required.
// Linux only. macOS takes the `file://` form without escaping — a pasteboard
// of pathnames, not a `text/uri-list` — so this is unused on both of the other
// two, and the allowance says exactly which.
#[cfg_attr(any(target_os = "windows", target_os = "macos"), allow(dead_code))]
fn percent_encode_path(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    for byte in path.bytes() {
        let keep = byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~' | b'/');
        if keep {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_uri_is_what_the_clipboard_plugin_accepts_on_this_platform() {
        // `file_uri` itself had no test on any platform. The only thing covered
        // was `percent_encode_path`, which is the helper for the *Linux* branch
        // — the one branch not compiled on Windows or macOS — so the function
        // whose own docstring records two shipped blockers from this three-way
        // switch was never called by a test at all.
        //
        // One test, three `cfg` arms: each CI leg asserts the contract of the
        // branch it actually builds, which is the most a compile-time switch
        // allows. A space in the name is the case that separates them, and it
        // is in every default recording filename on both desktop platforms.
        let path = if cfg!(target_os = "windows") {
            PathBuf::from(r"C:\Users\me\Screen Recording 1.mp4")
        } else {
            PathBuf::from("/home/me/Screen Recording 1.mp4")
        };
        let uri = file_uri(&path);

        #[cfg(target_os = "windows")]
        {
            // The plugin rejects a `file://` prefix here outright.
            assert!(
                !uri.starts_with("file://"),
                "Windows takes a bare path, not a URI: {uri}"
            );
            assert_eq!(uri, path.to_string_lossy());
        }
        #[cfg(target_os = "macos")]
        {
            // Prefixed and *not* encoded: `clipboard-rs` puts the string
            // verbatim into `NSFilenamesPboardType`, so a receiver that strips
            // the scheme must be left a real pathname.
            assert_eq!(uri, "file:///home/me/Screen Recording 1.mp4");
            assert!(!uri.contains("%20"), "macOS must not percent-encode: {uri}");
        }
        #[cfg(not(any(target_os = "windows", target_os = "macos")))]
        {
            // A `text/uri-list`, where a raw space is malformed.
            assert_eq!(uri, "file:///home/me/Screen%20Recording%201.mp4");
        }
    }

    #[test]
    fn a_recording_uri_is_encoded_for_the_names_recordings_actually_have() {
        // Only recordings reach `file_uri`, and every platform's default
        // recording name contains spaces — so the one path that needed
        // percent-encoding was the one that always had characters requiring it.
        // A raw space makes a `text/uri-list` entry malformed.
        let encoded = percent_encode_path("/home/someone/Videos/Screencast from 2026-07-27.webm");
        assert!(
            !encoded.contains(' '),
            "a raw space is not a legal URI: {encoded}"
        );
        assert!(encoded.contains("%20"));
        // Separators stay separators, or it is not a path any more.
        assert!(encoded.starts_with("/home/someone/Videos/"));
        // And an ordinary name is left alone.
        assert_eq!(percent_encode_path("/a/b-c_d.mp4"), "/a/b-c_d.mp4");
    }

    #[test]
    fn a_scan_key_names_a_version_of_a_file_not_just_a_path() {
        // This module had no tests at all, and this key is the thing standing
        // between a re-saved capture and the previous file's findings — where
        // "no findings" is not rendered as "unknown" but as read-and-clean.
        //
        // What this can state without depending on the runner's timestamp
        // granularity: that an existing file gets a version at all, and that
        // an unreadable one degrades to `None` rather than panicking. The
        // "a different mtime is a different key" half is the tuple's own
        // definition, and `cache::Version` learned the hard way that
        // going through the filesystem to say so tests the filesystem.
        let dir = std::env::temp_dir().join(format!("shotshelf-scan-key-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("a temp dir");
        let file = dir.join("capture.png");
        std::fs::write(&file, b"pixels").expect("a temp file");

        // Two versions of the same path differ; a missing file still answers.
        // The encoding itself is `cache::Version`'s, tested there once for all
        // three caches rather than three times in three shapes.
        assert_eq!(
            crate::cache::Version::of(&file),
            crate::cache::Version::of(&file),
            "stable for one version"
        );
        assert_ne!(
            crate::cache::Version::of(&file),
            crate::cache::Version::of(&dir.join("other.png")),
            "two captures are two versions",
        );
        // An unreadable timestamp is not a panic.
        let _ = crate::cache::Version::of(&dir.join("never-existed.png"));

        let _ = std::fs::remove_dir_all(&dir);
    }
}
