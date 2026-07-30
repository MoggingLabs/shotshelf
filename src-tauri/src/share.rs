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
}
