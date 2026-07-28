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
            let permit = sizing_limit()
                .clone()
                .acquire_owned()
                .await
                .map_err(|err| err.to_string())?;
            let worker_app = app.clone();
            let for_worker = source.clone();
            tauri::async_runtime::spawn_blocking(move || {
                let sized = handoff::file_for(&worker_app, &for_worker, downscale);
                drop(permit);
                sized
            })
            .await
            .map_err(|err| err.to_string())?
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

/// How many captures may be *sized* at once.
///
/// `prepare_drag` and `copy_capture` decode, Lanczos3-resize and re-encode a
/// full-resolution screenshot, and a multi-select drag calls `prepare_drag`
/// once per capture concurrently — so moving that work to blocking threads
/// without limiting how many was half the fix. The same ceiling as the scan,
/// for the same reason.
pub(crate) const SIZING_CONCURRENCY: usize = 2;

pub(crate) fn sizing_limit() -> &'static std::sync::Arc<tokio::sync::Semaphore> {
    static LIMIT: std::sync::OnceLock<std::sync::Arc<tokio::sync::Semaphore>> =
        std::sync::OnceLock::new();
    LIMIT.get_or_init(|| std::sync::Arc::new(tokio::sync::Semaphore::new(SIZING_CONCURRENCY)))
}

/// How many captures may be read at once.
///
/// Small on purpose: this is CPU-bound work on a machine the user is using for
/// something else, and the shelf is usable the whole time either way.
const SCAN_CONCURRENCY: usize = 2;

/// Identity of a capture's *contents*: where it is, and when it last changed.
///
/// An unreadable timestamp only means this file shares a key with its other
/// versions, which is where we were before.
fn scan_key(source: &Path) -> (PathBuf, Option<std::time::Duration>) {
    let modified = std::fs::metadata(source)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|at| at.duration_since(std::time::UNIX_EPOCH).ok());
    (source.to_path_buf(), modified)
}

type ScanKey = (PathBuf, Option<std::time::Duration>);

fn scan_cache() -> &'static std::sync::Mutex<std::collections::HashMap<ScanKey, Findings>> {
    static CACHE: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashMap<ScanKey, Findings>>,
    > = std::sync::OnceLock::new();
    CACHE.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

fn scan_limit() -> &'static std::sync::Arc<tokio::sync::Semaphore> {
    static LIMIT: std::sync::OnceLock<std::sync::Arc<tokio::sync::Semaphore>> =
        std::sync::OnceLock::new();
    LIMIT.get_or_init(|| std::sync::Arc::new(tokio::sync::Semaphore::new(SCAN_CONCURRENCY)))
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
            let permit = sizing_limit()
                .clone()
                .acquire_owned()
                .await
                .map_err(|err| err.to_string())?;
            let worker_app = app.clone();
            let for_worker = source.clone();
            let bytes = tauri::async_runtime::spawn_blocking(move || {
                let handed_over = handoff::file_for(&worker_app, &for_worker, downscale);
                let read = read_capture(&handed_over).map_err(|err| err.to_string());
                drop(permit);
                read
            })
            .await
            .map_err(|err| err.to_string())??;
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

/// The clipboard plugin wants a bare path on Windows and a `file://` URI
/// everywhere else, and rejects the wrong one outright.
fn file_uri(path: &Path) -> String {
    #[cfg(target_os = "windows")]
    {
        path.to_string_lossy().into_owned()
    }
    #[cfg(not(target_os = "windows"))]
    {
        format!("file://{}", path.to_string_lossy())
    }
}

/// Written out once because the drag plugin takes a path to a preview image,
/// not bytes.
fn video_preview<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|err| err.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|err| err.to_string())?;

    let preview = dir.join("video-drag-preview.png");
    if !preview.is_file() {
        std::fs::write(&preview, VIDEO_PREVIEW).map_err(|err| err.to_string())?;
    }

    Ok(preview)
}

#[cfg(test)]
mod tests {
    use super::*;

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
        // definition, and `handoff::fingerprint` learned the hard way that
        // going through the filesystem to say so tests the filesystem.
        let dir = std::env::temp_dir().join(format!("shotshelf-scan-key-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("a temp dir");
        let file = dir.join("capture.png");
        std::fs::write(&file, b"pixels").expect("a temp file");

        let (path, version) = scan_key(&file);
        assert_eq!(path, file, "the key carries which file it is about");
        assert!(version.is_some(), "an existing capture has a version");

        let (_, missing) = scan_key(&dir.join("never-existed.png"));
        assert_eq!(missing, None, "an unreadable timestamp is not a panic");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_two_concurrency_limits_leave_the_shelf_usable() {
        // Both guard CPU-bound work on a machine the user is doing something
        // else on. Zero would deadlock every caller on a semaphore that never
        // admits anyone; a large number is the burst these exist to prevent —
        // pinned captures are exempt from the item cap, so "one per tile" is
        // unbounded.
        assert!((1..=4).contains(&SIZING_CONCURRENCY));
        assert!((1..=4).contains(&SCAN_CONCURRENCY));
    }
}
