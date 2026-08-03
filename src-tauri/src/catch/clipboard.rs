//! Clipboard-image watching via `tauri-plugin-clipboard`.
//!
//! Win+Shift+S and ⌘⌃⇧4 never touch the disk, so the folder watchers can't see
//! them. The plugin ships an OS-level clipboard watcher; we subscribe to it
//! rather than polling, write the image out, and treat it as a normal capture.

use std::{
    collections::{hash_map::DefaultHasher, HashSet},
    hash::{Hash, Hasher},
    path::{Path, PathBuf},
    sync::{mpsc, Arc},
    time::{Duration, SystemTime},
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
// Same const arithmetic as `SLOWEST_IMAGE`, which this is derived from.
#[allow(clippy::cast_possible_truncation)]
const ECHO_GRACE: Duration =
    Duration::from_millis(super::folders::SLOWEST_IMAGE.as_millis() as u64 * 2);

/// How long after a folder image a clipboard copy still counts as its echo.
///
/// Derived from the grace above rather than written out, because the whole rule
/// only works while `ECHO_GRACE < ECHO_WINDOW`: the worker sleeps the grace and
/// *then* asks whether the marker is younger than the window, so a grace that
/// outgrows the window means the answer is always no. Every Win+PrtSc would
/// shelve twice and leave an unpruned PNG — verbatim the defect `folders.rs`
/// says these constants exist to prevent.
///
/// Two of the three numbers already moved together; this was the third, a
/// hand-written `from_secs(4)`, and it is the one the rule depends on. Raising
/// `IMAGE_STABLE_TICKS` from one to six — the same class of edit
/// `folders.rs` names as the motivating hazard — put a 5000 ms grace against a
/// 4000 ms window with nothing to say so. Written as grace + slack, the
/// inequality holds by construction and `ECHO_SLACK` is the decision that
/// genuinely belongs in this file: how much later than the folder watcher's
/// worst case a copy may still arrive and be recognised.
const ECHO_SLACK: Duration = Duration::from_millis(2_500);
const ECHO_WINDOW: Duration = ECHO_GRACE.saturating_add(ECHO_SLACK);

/// Returns whether the monitor is actually running, which the status line
/// needs: it used to append "+ the clipboard" whatever happened here.
pub fn start<R: Runtime>(app: &AppHandle<R>, sink: Arc<CaptureSink>) -> bool {
    if let Err(err) = app.state::<Clipboard>().start_monitor(app.clone()) {
        crate::diag::warn(&format!("could not start the clipboard monitor: {err}"));
        return false;
    }

    let (tx, rx) = mpsc::channel::<()>();
    spawn_worker(app.clone(), rx, sink);

    app.listen(CLIPBOARD_UPDATE, move |_event| {
        // Hand off immediately: the plugin's watcher thread must not sit
        // blocked on a clipboard another app is still holding.
        let _ = tx.send(());
    });

    true
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
            // Only an echo if it is the same *picture*, not merely close in
            // time. The plugin hands over PNG bytes whatever the OS held, so
            // the encodings never match byte for byte — the shape is the
            // cheapest thing both sides can agree on, and it is read from the
            // header rather than by decoding.
            let shape = image::ImageReader::new(std::io::Cursor::new(&bytes))
                .with_guessed_format()
                .ok()
                .and_then(|reader| reader.into_dimensions().ok());
            if let Some(shape) = shape {
                if sink.take_folder_echo(ECHO_WINDOW, shape) {
                    continue;
                }
            }

            match write_capture(&app, &bytes) {
                Ok(path) => sink.emit(&app, &path, CaptureKind::Image, Source::Clipboard),
                // On screen, not only in the log. This is the one capture with
                // no other copy: the bytes are in the clipboard and nowhere
                // else, so failing to write them loses the screenshot outright.
                //
                // "Capture", because that is the word every other user-facing
                // sentence uses, and the raw io::Error goes to the log rather
                // than the strip — a person who has just lost a screenshot is
                // not the audience for "os error 112".
                Err(err) => {
                    crate::diag::warn(&format!("a clipboard capture could not be written: {err}"));
                    super::report_problem(
                        &app,
                        "That capture could not be saved — it existed only in the clipboard.",
                    );
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
/// By default nothing prunes this folder: a clipboard capture is an original
/// with no copy anywhere else, so it grows until the user clears it — or
/// opts into a keep limit ("Keep clipboard captures" in Settings →
/// Capturing), which is the one sweep in the app allowed to delete a
/// capture, spelled out on [`prune_clipboard`]. The usage guide covers both
/// in the uninstall section.
fn write_capture<R: Runtime>(app: &AppHandle<R>, bytes: &[u8]) -> Result<PathBuf, String> {
    // `dirs::local` creates it; saying so again here made the contract
    // unreadable from the call site.
    let dir = capture_dir(app).ok_or("no app data directory")?;

    let path = dir.join(format!("clipboard-{}.png", now_ms()));
    std::fs::write(&path, bytes).map_err(|err| err.to_string())?;

    Ok(path)
}

/// Let go of clipboard captures past the owner's chosen keep.
///
/// The one deletion the app ever performs, and only on files it made itself:
/// a clipboard capture exists nowhere but this folder, so without a limit it
/// grows for as long as the machine lives. Opt-in — `clipboard_keep_days`
/// defaults to `None`, which is today's keep-forever — and pinned captures
/// are always spared, whatever their age: a pin is the user saying "this one
/// matters", and no housekeeping outranks that.
pub(super) fn prune_clipboard<R: Runtime>(app: &AppHandle<R>) {
    let Some(store) = app.try_state::<crate::settings::SettingsStore>() else {
        return;
    };
    let settings = store.get();
    let Some(days) = settings.clipboard_keep_days else {
        return;
    };
    let Some(dir) = capture_dir(app) else {
        return;
    };
    // `checked_sub` because a huge keep on a young clock underflows, and
    // "cannot compute the cutoff" must mean "delete nothing".
    let Some(cutoff) = SystemTime::now().checked_sub(Duration::from_secs_f64(days * 86_400.0))
    else {
        return;
    };
    let pinned: HashSet<PathBuf> = settings
        .pinned
        .iter()
        .map(|pin| PathBuf::from(&pin.path))
        .collect();
    let gone = sweep_keep(&dir, &pinned, cutoff);
    if gone > 0 {
        crate::diag::info(&format!(
            "{gone} clipboard captures past their keep were let go"
        ));
    }
}

/// The sweep itself, separable so a test can drive it against a real
/// directory: everything under `dir` last written before `cutoff` goes,
/// except pinned paths. Flat on purpose — this folder has no tree.
fn sweep_keep(dir: &Path, pinned: &HashSet<PathBuf>, cutoff: SystemTime) -> usize {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    let mut gone = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() || pinned.contains(&path) {
            continue;
        }
        let old = entry
            .metadata()
            .ok()
            .and_then(|meta| meta.modified().ok())
            .is_some_and(|written| written < cutoff);
        if old && std::fs::remove_file(&path).is_ok() {
            gone += 1;
        }
    }
    gone
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_keep_sweep_spares_the_pinned_and_the_new() {
        // Filesystem mtimes cannot be set portably from std, so age is
        // simulated from the other side: a cutoff in the future makes every
        // file "old", a cutoff in the past makes every file "new". The two
        // runs together pin the comparison's direction and the pin
        // exemption — the property that matters most, because this is the
        // one sweep in the app that deletes a capture's only copy.
        let dir = std::env::temp_dir().join(format!("shotshelf-keep-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("a temp dir");
        let stale = dir.join("stale.png");
        let precious = dir.join("pinned.png");
        std::fs::write(&stale, b"x").expect("writable");
        std::fs::write(&precious, b"x").expect("writable");
        let pinned: HashSet<PathBuf> = [precious.clone()].into_iter().collect();

        let future = SystemTime::now() + Duration::from_secs(3600);
        assert_eq!(
            sweep_keep(&dir, &pinned, future),
            1,
            "one stale, one pinned"
        );
        assert!(!stale.exists(), "the stale unpinned file is gone");
        assert!(precious.exists(), "a pin outranks any keep");

        std::fs::write(&stale, b"x").expect("writable");
        let past = SystemTime::now() - Duration::from_secs(3600);
        assert_eq!(
            sweep_keep(&dir, &pinned, past),
            0,
            "nothing is younger than its keep"
        );
        assert!(stale.exists());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_echo_window_outlasts_the_grace_the_worker_sleeps() {
        // The whole Win+PrtSc rule rests on this one inequality and nothing
        // asserted it. The worker sleeps `ECHO_GRACE` and *then* asks whether
        // the folder marker is younger than `ECHO_WINDOW`, so a grace that
        // outgrows the window means the answer is always no: every Win+PrtSc
        // shelves twice and leaves an unpruned PNG in a folder the app never
        // prunes — verbatim the defect `folders.rs` says these constants exist
        // to prevent.
        //
        // Two of the three numbers already moved together; this was the third,
        // a hand-written `from_secs(4)`. Raising `IMAGE_STABLE_TICKS` from one
        // to six — the same class of edit `folders.rs` names as the motivating
        // hazard — put a 5000 ms grace against a 4000 ms window with nothing
        // anywhere to say so.
        assert!(
            ECHO_WINDOW > ECHO_GRACE,
            "the marker has already expired by the time the worker looks at it: \
             grace {ECHO_GRACE:?}, window {ECHO_WINDOW:?}",
        );

        // And it moves with the watcher it is waiting for, rather than being a
        // constant that happens to be big enough today.
        assert_eq!(ECHO_GRACE, super::super::folders::SLOWEST_IMAGE * 2);
        assert_eq!(ECHO_WINDOW, ECHO_GRACE + ECHO_SLACK);
    }
}
