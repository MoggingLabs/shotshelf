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

use crate::catch::{CaptureKind, CaptureSink};

/// Recordings have no thumbnail of their own until phase 05, so they drag
/// under the app icon.
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
#[tauri::command]
pub fn prepare_drag<R: Runtime>(
    app: AppHandle<R>,
    path: String,
    kind: CaptureKind,
) -> Result<DragSource, String> {
    let source = existing_file(&path)?;

    let icon = match kind {
        // A screenshot is its own best preview.
        CaptureKind::Image => source.clone(),
        CaptureKind::Video => video_preview(&app)?,
    };

    Ok(DragSource {
        path: source.to_string_lossy().into_owned(),
        icon: icon.to_string_lossy().into_owned(),
    })
}

/// Clipboard fallback, for the apps that will take a paste but not a drop.
#[tauri::command]
pub fn copy_capture<R: Runtime>(
    app: AppHandle<R>,
    sink: State<'_, Arc<CaptureSink>>,
    path: String,
    kind: CaptureKind,
) -> Result<(), String> {
    let source = existing_file(&path)?;

    // This write is about to wake our own clipboard watcher; without warning
    // it, copying a capture would shelve a second copy of it.
    sink.expect_own_clipboard_write(OWN_WRITE_WINDOW);

    let clipboard = app.state::<Clipboard>();
    match kind {
        CaptureKind::Image => {
            let bytes = std::fs::read(&source).map_err(|err| err.to_string())?;
            clipboard.write_image_binary(bytes)
        }
        // A recording pastes as a file, not as pixels.
        CaptureKind::Video => clipboard.write_files_uris(vec![file_uri(&source)]),
    }
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

fn existing_file(path: &str) -> Result<PathBuf, String> {
    let source = PathBuf::from(path);

    if !source.is_absolute() {
        return Err(format!("{path} is not an absolute path"));
    }
    if !source.is_file() {
        return Err(format!("{path} is no longer on disk"));
    }

    Ok(source)
}

/// Written out once because the drag plugin takes a path to a preview image,
/// not bytes.
fn video_preview<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|err| err.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|err| err.to_string())?;

    let preview = dir.join("video-drag-preview.png");
    if !preview.is_file() {
        std::fs::write(&preview, VIDEO_PREVIEW).map_err(|err| err.to_string())?;
    }

    Ok(preview)
}
