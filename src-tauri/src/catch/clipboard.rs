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

use super::{now_ms, CaptureKind, CaptureSink, Source};

/// The plugin's watcher emits this on every clipboard change, of any type.
const CLIPBOARD_UPDATE: &str = "plugin:clipboard://clipboard-monitor/update";

/// Windows hands the clipboard to one process at a time, so the very read that
/// follows a screenshot tool's write can come back `ACCESS_DENIED`. Retrying is
/// the difference between catching a Win+Shift+S and silently losing it.
const READ_ATTEMPTS: u32 = 6;
const READ_RETRY: Duration = Duration::from_millis(80);

/// Win+PrtSc saves a PNG *and* copies it to the clipboard, so one screenshot
/// reaches both watchers. Hold every clipboard image back long enough for the
/// folder watcher to finish, then drop this copy if the same screenshot already
/// arrived as a file — the file has a real name and a real path, and this is
/// only an echo of it.
///
/// Twice `folders::SLOWEST_IMAGE`, rather than a hand-chosen 1500 ms under a
/// comment restating that module's timings as "roughly 750 ms". Those timings
/// are three constants private to `folders.rs`; nothing joined them to this
/// one, so raising any of them would have silently shelved every Win+PrtSc
/// twice and left an unprunable duplicate PNG behind. The factor of two is the
/// decision that belongs here — the number it multiplies belongs there.
const ECHO_GRACE: Duration =
    Duration::from_millis(super::folders::SLOWEST_IMAGE.as_millis() as u64 * 2);
const ECHO_WINDOW: Duration = Duration::from_secs(4);

pub fn start<R: Runtime>(app: &AppHandle<R>, sink: Arc<CaptureSink>) {
    if let Err(err) = app.state::<Clipboard>().start_monitor(app.clone()) {
        crate::diag::warn(&format!("could not start the clipboard monitor: {err}"));
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
        // Copying the same image twice should not shelve it twice. The shelf's
        // own copy-to-clipboard lands here too — see `OWN_WRITE_WINDOW` in
        // `share.rs`, which is the other half of stopping a copy from bouncing
        // straight back onto the shelf as a fresh capture.
        let mut last_image: Option<u64> = None;

        while rx.recv().is_ok() {
            // A burst of changes still only needs one look at the clipboard.
            while rx.try_recv().is_ok() {}

            // A copy the user made *from* the shelf is not a new capture.
            if sink.take_own_clipboard_write() {
                continue;
            }

            let bytes = match read_image(&app) {
                Ok(Some(bytes)) => bytes,
                Ok(None) => continue, // text, files, or nothing at all
                Err(err) => {
                    crate::diag::warn(&format!("could not read the clipboard: {err}"));
                    continue;
                }
            };

            let digest = digest_of(&bytes);
            if last_image == Some(digest) {
                continue;
            }
            last_image = Some(digest);

            // Let the folder watcher win if this is the same screenshot. The
            // check comes before the write, so an echo never leaves a file
            // behind either.
            std::thread::sleep(ECHO_GRACE);
            if sink.take_folder_echo(ECHO_WINDOW) {
                continue;
            }

            match write_capture(&app, &bytes) {
                Ok(path) => sink.emit(&app, &path, CaptureKind::Image, Source::Clipboard),
                Err(err) => {
                    crate::diag::warn(&format!("could not save the clipboard image: {err}"))
                }
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

/// Where clipboard captures are kept: under the app data dir, never the repo
/// and never a shared temp location. The shelf has to be able to read from
/// here too, which is why this is shared rather than inlined below.
pub(super) fn capture_dir<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    // Local app data, never roaming. These files are screen captures and they
    // are the only copy — see `dirs::local`, which is where that rule
    // lives now rather than in four docstrings pointing at each other.
    crate::dirs::local(app, "clipboard").ok()
}

/// Clipboard captures have no file of their own, so give them one.
///
/// Nothing prunes this folder, and that is deliberate rather than pending: a
/// clipboard capture is an original with no copy anywhere else, so an
/// automatic sweep here would be the only thing in the app that destroys a
/// capture. It grows until the user clears it, and the usage guide says so
/// plainly in the uninstall section.
fn write_capture<R: Runtime>(app: &AppHandle<R>, bytes: &[u8]) -> Result<PathBuf, String> {
    // `dirs::local` creates it; saying so again here made the contract
    // unreadable from the call site.
    let dir = capture_dir(app).ok_or("no app data directory")?;

    let path = dir.join(format!("clipboard-{}.png", now_ms()));
    std::fs::write(&path, bytes).map_err(|err| err.to_string())?;

    Ok(path)
}
