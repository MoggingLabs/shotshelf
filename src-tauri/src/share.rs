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
            under_sizing_limit("that capture for the drag", move || {
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
    let version = scan_key(&source);

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
        .and_then(|cache| cache.get(&version).cloned())
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
    let permit = scan_limit()
        .clone()
        .acquire_owned()
        .await
        .map_err(|err| err.to_string())?;

    let for_worker = source.clone();
    // A blocking worker rather than the async runtime that also serves the
    // shelf's other commands.
    let worker =
        tauri::async_runtime::spawn_blocking(move || Findings::from(enrich::describe(&for_worker)));

    let findings = match tokio::time::timeout(SCAN_TIMEOUT, worker).await {
        Ok(joined) => joined.map_err(|err| err.to_string())?,
        Err(_) => {
            drop(permit);
            return Err(format!(
                "reading {} took too long",
                source.file_name().unwrap_or_default().to_string_lossy()
            ));
        }
    };
    drop(permit);

    if let Ok(mut cache) = scan_cache().lock() {
        // Bounded: a shelf that has seen thousands of captures in one session
        // should not hold every scan for the life of the process.
        if cache.len() >= SCAN_CACHE_LIMIT {
            cache.clear();
        }
        cache.insert(version, findings.clone());
    }

    Ok(findings)
}

/// How many scans to remember before starting over.
const SCAN_CACHE_LIMIT: usize = 500;

/// How long one capture may be read for before the caller gives up on it.
///
/// Generous: OCR on a dense 4K screenshot is genuinely slow. It exists so a
/// recogniser that never returns costs one tile rather than the feature.
const SCAN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// How long one sizing job may run before the caller gives up on it.
///
/// Generous — a Lanczos3 resize of a 4K screenshot is real work, and a
/// comparison composites two of them. It exists so a decode that never returns
/// costs one drag rather than the feature.
const SIZING_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

/// Run sizing work on a blocking worker, under the concurrency limit and a
/// deadline, with the permit released whatever happens.
///
/// One function because there were three copies of it — `prepare_drag`,
/// `copy_capture` and `compare_captures` — and all three made the same mistake
/// in the same place: the permit was moved *into* the worker.
///
/// `describe_capture`, thirty lines above two of them, spends a paragraph on
/// why that is wrong, and the reasoning transfers exactly. A permit that lives
/// in the worker is released only when the worker finishes; two jobs that never
/// finish exhaust a semaphore of two, and every later drag and every later copy
/// blocks on `acquire_owned` forever. Held out here it is released the moment
/// this returns, so the cost of a wedge is a leaked thread rather than a
/// feature that never works again for the rest of the session.
///
/// The deadline is the other half, and the sizing path did not have it at all:
/// it awaited the `JoinHandle` bare, so a wedged decode hung its caller as well
/// as its permit.
pub(crate) async fn under_sizing_limit<T, W>(what: &str, work: W) -> Result<T, String>
where
    W: FnOnce() -> T + Send + 'static,
    T: Send + 'static,
{
    under_limit(sizing_limit().clone(), SIZING_TIMEOUT, what, work).await
}

/// The rule itself, with the pool and the deadline passed in.
///
/// Split out for one reason: "a wedged job gives its permit back" is the
/// property that was wrong at all three call sites, and stating it needs a job
/// that never finishes and a deadline measured in milliseconds rather than the
/// real minute.
async fn under_limit<T, W>(
    limit: Arc<tokio::sync::Semaphore>,
    deadline: Duration,
    what: &str,
    work: W,
) -> Result<T, String>
where
    W: FnOnce() -> T + Send + 'static,
    T: Send + 'static,
{
    let permit = limit.acquire_owned().await.map_err(|err| err.to_string())?;

    let worker = tauri::async_runtime::spawn_blocking(work);
    let outcome = match tokio::time::timeout(deadline, worker).await {
        Ok(joined) => joined.map_err(|err| err.to_string()),
        Err(_) => Err(format!("preparing {what} took too long")),
    };

    // Before returning, on every path. `tokio::time::timeout` frees the *task*
    // and not the thread behind it, so this is the only thing that keeps a
    // wedged job from costing a permit permanently.
    drop(permit);
    outcome
}

fn sizing_limit() -> &'static std::sync::Arc<tokio::sync::Semaphore> {
    static LIMIT: std::sync::OnceLock<std::sync::Arc<tokio::sync::Semaphore>> =
        std::sync::OnceLock::new();
    crate::limits::shared(&LIMIT, crate::limits::SIZING)
}

/// Identity of a capture's *contents*, through `cache::Version`.
///
/// The same answer the hand-off and poster caches key on, rather than a third
/// encoding of it — this one carried its own copy of the mtime read, byte for
/// byte identical to `handoff.rs`'s. An unreadable timestamp only means the
/// file shares a version with its other versions, which is where all three
/// caches were before mtime was part of the key.
fn scan_key(source: &Path) -> ScanKey {
    crate::cache::Version::of(source)
}

type ScanKey = crate::cache::Version;

fn scan_cache() -> &'static std::sync::Mutex<std::collections::HashMap<ScanKey, Findings>> {
    static CACHE: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashMap<ScanKey, Findings>>,
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
            let bytes = under_sizing_limit("that capture for the clipboard", move || {
                let handed_over = handoff::file_for(&worker_app, &for_worker, downscale);
                read_capture(&handed_over).map_err(|err| err.to_string())
            })
            .await??;
            Payload::Pixels(bytes)
        }
        // A recording pastes as a file, not as pixels.
        CaptureKind::Video => Payload::File(file_uri(&source)),
    };

    sink.expect_own_clipboard_write(OWN_WRITE_WINDOW);

    let clipboard = app.state::<Clipboard>();
    match payload {
        Payload::Pixels(bytes) => clipboard.write_image_binary(bytes),
        Payload::File(uri) => clipboard.write_files_uris(vec![uri]),
    }
}

/// What is about to go on the clipboard, prepared before anything is armed.
enum Payload {
    Pixels(Vec<u8>),
    File(String),
}

/// What the clipboard plugin wants for a file, per platform.
///
/// **Windows and macOS want a bare path.** This used to say macOS wanted a
/// `file://` URI and that the plugin "rejects the wrong one outright" — both
/// false. `clipboard-rs`'s macOS backend hands the strings straight to
/// `NSFilenamesPboardType`, which is a property list of POSIX paths: it does
/// not convert and it does not reject, so a URI went onto the pasteboard
/// verbatim and pasted as nothing usable.
///
/// **X11 wants a `file://` URI in `text/uri-list`**, which must be
/// percent-encoded — and this emitted raw spaces. Reachable only for
/// recordings, whose default names on every platform contain spaces
/// (`Screen Recording 2026-07-27 at 15.22.33.mov`, `Screencast from ....webm`),
/// so the one path that needed encoding was the one that always had spaces.
fn file_uri(path: &Path) -> String {
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    {
        path.to_string_lossy().into_owned()
    }
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
        assert_eq!(scan_key(&file), scan_key(&file), "stable for one version");
        assert_ne!(
            scan_key(&file),
            scan_key(&dir.join("other.png")),
            "two captures are two versions",
        );
        // An unreadable timestamp is not a panic.
        let _ = scan_key(&dir.join("never-existed.png"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_job_that_never_finishes_gives_its_permit_back() {
        // The property all three sizing call sites got wrong, in the same way:
        // the permit was moved *into* the worker, so it was released only when
        // the worker finished. With a pool of two, two jobs that never finish
        // meant every later drag and every later copy blocked on
        // `acquire_owned` for the rest of the session — the failure
        // `describe_capture` spends a paragraph avoiding, thirty lines above
        // two of them.
        //
        // Stated with a wedged job and a millisecond deadline, because the real
        // one is a minute. The thread really does stay stuck: that is the cost
        // being accepted, and the point is that the *permit* does not stay with
        // it.
        tauri::async_runtime::block_on(async {
            let limit = Arc::new(tokio::sync::Semaphore::new(1));
            let (release, wait) = std::sync::mpsc::channel::<()>();

            let wedged = under_limit(
                limit.clone(),
                Duration::from_millis(50),
                "a wedge",
                move || {
                    // Held until the assertions are done, then let go so the test
                    // does not leak a thread into the rest of the suite.
                    let _ = wait.recv_timeout(Duration::from_secs(10));
                },
            )
            .await;

            assert!(wedged.is_err(), "the deadline fired");
            assert!(
                wedged.unwrap_err().contains("took too long"),
                "and says so in terms a caller can show",
            );

            let regained =
                tokio::time::timeout(Duration::from_secs(2), limit.clone().acquire_owned()).await;
            assert!(
                regained.is_ok(),
                "the permit must be back even though the thread is still stuck",
            );

            let _ = release.send(());
        });
    }

    #[test]
    fn work_that_finishes_in_time_returns_its_answer() {
        tauri::async_runtime::block_on(async {
            let limit = Arc::new(tokio::sync::Semaphore::new(1));
            let answer = under_limit(limit, Duration::from_secs(5), "a quick job", || 7).await;
            assert_eq!(answer, Ok(7));
        });
    }
}
