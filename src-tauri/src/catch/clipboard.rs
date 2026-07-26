//! Clipboard-image watching via `tauri-plugin-clipboard`.
//!
//! Win+Shift+S and ⌘⌃⇧4 never touch the disk, so the folder watchers can't see
//! them. The plugin ships an OS-level clipboard watcher; we subscribe to it
//! rather than polling, write the image out, and treat it as a normal capture.

use std::{
    collections::hash_map::DefaultHasher,
    hash::{Hash, Hasher},
    path::PathBuf,
    sync::{mpsc, Arc},
    time::Duration,
};

use tauri::{AppHandle, Listener, Manager, Runtime};
use tauri_plugin_clipboard::Clipboard;

use super::{now_ms, CaptureKind, CaptureSink};

/// The plugin's watcher emits this on every clipboard change, of any type.
const CLIPBOARD_UPDATE: &str = "plugin:clipboard://clipboard-monitor/update";

/// Windows hands the clipboard to one process at a time, so the very read that
/// follows a screenshot tool's write can come back `ACCESS_DENIED`. Retrying is
/// the difference between catching a Win+Shift+S and silently losing it.
const READ_ATTEMPTS: u32 = 6;
const READ_RETRY: Duration = Duration::from_millis(80);

pub fn start<R: Runtime>(app: &AppHandle<R>, sink: Arc<CaptureSink>) {
    if let Err(err) = app.state::<Clipboard>().start_monitor(app.clone()) {
        eprintln!("shotshelf: could not start the clipboard monitor: {err}");
        return;
    }

    let (tx, rx) = mpsc::channel::<()>();
    spawn_worker(app.clone(), rx, sink);

    app.listen(CLIPBOARD_UPDATE, move |_event| {
        // Hand off immediately: the plugin's watcher thread must not sit
        // blocked on a clipboard another app is still holding.
        let _ = tx.send(());
    });
}

fn spawn_worker<R: Runtime>(app: AppHandle<R>, rx: mpsc::Receiver<()>, sink: Arc<CaptureSink>) {
    std::thread::spawn(move || {
        // Copying the same image twice should not shelve it twice. Phase 04's
        // copy-to-clipboard fallback will land here too, and this is what stops
        // it from bouncing straight back onto the shelf.
        let mut last_image: Option<u64> = None;

        while rx.recv().is_ok() {
            // A burst of changes still only needs one look at the clipboard.
            while rx.try_recv().is_ok() {}

            let bytes = match read_image(&app) {
                Ok(Some(bytes)) => bytes,
                Ok(None) => continue, // text, files, or nothing at all
                Err(err) => {
                    eprintln!("shotshelf: could not read the clipboard: {err}");
                    continue;
                }
            };

            let digest = digest_of(&bytes);
            if last_image == Some(digest) {
                continue;
            }
            last_image = Some(digest);

            match write_capture(&app, &bytes) {
                Ok(path) => sink.emit(&app, &path, CaptureKind::Image),
                Err(err) => eprintln!("shotshelf: could not save the clipboard image: {err}"),
            }
        }
    });
}

/// `Ok(None)` means the clipboard genuinely holds no image; `Err` means we
/// could not find out, even after retrying.
fn read_image<R: Runtime>(app: &AppHandle<R>) -> Result<Option<Vec<u8>>, String> {
    let mut last_err = None;

    for attempt in 0..READ_ATTEMPTS {
        if attempt > 0 {
            std::thread::sleep(READ_RETRY);
        }

        let clipboard = app.state::<Clipboard>();
        match clipboard.has_image() {
            Ok(false) => return Ok(None),
            Ok(true) => match clipboard.read_image_binary() {
                // Already PNG-encoded by the plugin.
                Ok(bytes) if !bytes.is_empty() => return Ok(Some(bytes)),
                Ok(_) => last_err = Some("clipboard image was empty".to_owned()),
                Err(err) => last_err = Some(err),
            },
            Err(err) => last_err = Some(err),
        }
    }

    match last_err {
        Some(err) => Err(err),
        None => Ok(None),
    }
}

fn digest_of(bytes: &[u8]) -> u64 {
    let mut hasher = DefaultHasher::new();
    bytes.hash(&mut hasher);
    hasher.finish()
}

/// Clipboard captures have no file of their own, so give them one under the app
/// data dir — never the repo, never a shared temp location. Phase 06 adds the
/// retention policy that cleans this folder up.
fn write_capture<R: Runtime>(app: &AppHandle<R>, bytes: &[u8]) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|err| err.to_string())?
        .join("clipboard");
    std::fs::create_dir_all(&dir).map_err(|err| err.to_string())?;

    let path = dir.join(format!("clipboard-{}.png", now_ms()));
    std::fs::write(&path, bytes).map_err(|err| err.to_string())?;

    Ok(path)
}
