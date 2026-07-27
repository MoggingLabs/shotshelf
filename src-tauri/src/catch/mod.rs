//! Catch engine — turns OS captures into one `capture://new` event each.
//!
//! Shotshelf is a *watcher*, not a capturer: the OS already writes screenshots
//! and recordings to known folders, and Win+Shift+S / ⌘⌃⇧4 land on the
//! clipboard only. So this module has exactly two inputs —
//! [`folders`] (the `notify` crate) and [`clipboard`]
//! (`tauri-plugin-clipboard`'s native watcher) — and one output, [`CAPTURE_EVENT`].
//!
//! Local-only: everything here reads local files and the local clipboard.

mod clipboard;
mod folders;
mod paths;

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime};

/// Event the shelf front-end listens on. Payload is [`Capture`].
pub const CAPTURE_EVENT: &str = "capture://new";

/// A capture fires once inside this window however many filesystem events the
/// OS produced for it.
const DEDUPE_WINDOW: Duration = Duration::from_secs(3);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CaptureKind {
    Image,
    Video,
}

/// Payload of [`CAPTURE_EVENT`].
#[derive(Debug, Clone, Serialize)]
pub struct Capture {
    /// Absolute path on disk. Stays on the device.
    pub path: String,
    pub kind: CaptureKind,
    /// Unix milliseconds.
    pub ts: u64,
}

/// Classify by extension. `None` means "not a capture" — ignore the file.
pub fn kind_of(path: &Path) -> Option<CaptureKind> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    match ext.as_str() {
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" => Some(CaptureKind::Image),
        "mp4" | "mov" | "mkv" | "webm" => Some(CaptureKind::Video),
        _ => None,
    }
}

/// Which watcher saw the capture. Win+PrtSc writes a PNG *and* copies it to
/// the clipboard, so one screenshot reaches both of them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    Folder,
    Clipboard,
}

/// The one place a capture becomes an event, so de-duplication only has to
/// happen once for both the folder watchers and the clipboard watcher.
#[derive(Default)]
pub struct CaptureSink {
    recent: Mutex<HashMap<PathBuf, Instant>>,
    /// Set when a folder image is emitted, cleared when a clipboard capture
    /// claims it as its own echo. See [`CaptureSink::take_folder_echo`].
    folder_echo: Mutex<Option<Instant>>,
    /// Set when Shotshelf itself writes to the clipboard, so copying a capture
    /// out doesn't shelve a second copy of it. See
    /// [`CaptureSink::take_own_clipboard_write`].
    own_clipboard_write: Mutex<Option<Instant>>,
}

impl CaptureSink {
    pub fn emit<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        path: &Path,
        kind: CaptureKind,
        source: Source,
    ) {
        if !self.claim(path) {
            return;
        }

        if source == Source::Folder && kind == CaptureKind::Image {
            *lock(&self.folder_echo) = Some(Instant::now());
        }

        let capture = Capture {
            path: path.display().to_string(),
            kind,
            ts: now_ms(),
        };

        match app.emit(CAPTURE_EVENT, &capture) {
            Ok(()) => println!("shotshelf: caught {:?} {}", kind, capture.path),
            Err(err) => eprintln!("shotshelf: could not emit {CAPTURE_EVENT}: {err}"),
        }
    }

    /// `true` if a folder image landed within `window` — and consumes it, so
    /// one screenshot can only ever silence one clipboard echo. Without that,
    /// a Win+PrtSc followed straight away by a genuine Win+Shift+S would lose
    /// the second capture.
    pub fn take_folder_echo(&self, window: Duration) -> bool {
        let mut echo = lock(&self.folder_echo);
        match *echo {
            Some(seen) if seen.elapsed() < window => {
                *echo = None;
                true
            }
            _ => false,
        }
    }

    /// Warn the clipboard watcher that the next change is Shotshelf's own
    /// doing — the copy-out fallback in [`crate::share`].
    pub fn expect_own_clipboard_write(&self, window: Duration) {
        *lock(&self.own_clipboard_write) = Some(Instant::now() + window);
    }

    /// `true` if that warning is still standing, consuming it either way.
    pub fn take_own_clipboard_write(&self) -> bool {
        let mut expected = lock(&self.own_clipboard_write);
        match *expected {
            Some(until) => {
                *expected = None;
                until > Instant::now()
            }
            None => false,
        }
    }

    /// `true` the first time a path shows up inside [`DEDUPE_WINDOW`].
    fn claim(&self, path: &Path) -> bool {
        let mut recent = lock(&self.recent);
        let now = Instant::now();
        recent.retain(|_, seen| now.duration_since(*seen) < DEDUPE_WINDOW);
        // Re-inserting refreshes the timestamp, so a noisy writer stays quiet.
        recent.insert(path.to_path_buf(), now).is_none()
    }
}

/// Keeps the watcher threads alive for the life of the app; held in Tauri state.
pub struct CatchEngine {
    watch_dirs: Vec<PathBuf>,
    /// Dropping the watch stops the `notify` threads.
    _folders: Option<folders::FolderWatch>,
}

/// Start watching. Never fatal: a shelf with a broken watcher is still a shelf,
/// so failures are logged and the rest of the engine carries on.
pub fn start<R: Runtime>(app: &AppHandle<R>, overrides: &[PathBuf]) {
    let watch_dirs = paths::resolve_watch_dirs(app, overrides);
    let sink = std::sync::Arc::new(CaptureSink::default());

    if watch_dirs.is_empty() {
        eprintln!("shotshelf: no capture folders found — clipboard watch only");
    }
    for dir in &watch_dirs {
        println!("shotshelf: watching {}", dir.display());
    }

    allow_reading_captures(app, &watch_dirs);

    let folders = match folders::start(app, &watch_dirs, std::sync::Arc::clone(&sink)) {
        Ok(watch) => Some(watch),
        Err(err) => {
            eprintln!("shotshelf: folder watching unavailable: {err}");
            None
        }
    };

    clipboard::start(app, std::sync::Arc::clone(&sink));

    // The copy-out fallback needs to reach the sink to flag its own clipboard
    // writes, so the shelf doesn't catch what the shelf just copied.
    app.manage(sink);

    app.manage(CatchEngine {
        watch_dirs,
        _folders: folders,
    });
}

/// Let the webview render captures straight off disk.
///
/// The asset protocol is scoped shut by default, and the scope has to be
/// granted here rather than in `tauri.conf.json`: the macOS capture folder is
/// only known once `defaults read` has run, and `SHOTSHELF_WATCH_DIRS` can
/// replace the list outright. Deriving it from the resolved watch list keeps
/// one source of truth — the shelf can read exactly what the engine watches,
/// non-recursively, and nothing else.
fn allow_reading_captures<R: Runtime>(app: &AppHandle<R>, dirs: &[PathBuf]) {
    let scope = app.asset_protocol_scope();

    let clipboard = clipboard::capture_dir(app);
    for dir in dirs.iter().chain(clipboard.iter()) {
        if let Err(err) = scope.allow_directory(dir, false) {
            eprintln!(
                "shotshelf: the shelf will not be able to show captures from {}: {err}",
                dir.display()
            );
        }
    }
}

/// Watch-path override. Phase 06 will feed this from the settings file; until
/// then `SHOTSHELF_WATCH_DIRS` (`;`-separated on Windows, `:` elsewhere) is the
/// override hook, and how synthetic fixtures drive the engine in testing.
pub fn overrides_from_env() -> Vec<PathBuf> {
    std::env::var_os("SHOTSHELF_WATCH_DIRS")
        .map(|value| std::env::split_paths(&value).collect())
        .unwrap_or_default()
}

/// Lets the shelf show where it is listening — and phase 06's settings read it back.
#[tauri::command]
pub fn catch_watch_dirs<R: Runtime>(app: AppHandle<R>) -> Vec<String> {
    app.try_state::<CatchEngine>()
        .map(|engine| {
            engine
                .watch_dirs
                .iter()
                .map(|dir| dir.display().to_string())
                .collect()
        })
        .unwrap_or_default()
}

/// A watcher thread dying mid-update should not take the whole engine with it;
/// the worst a poisoned lock costs here is one stale timestamp.
fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|since| since.as_millis() as u64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_by_extension_regardless_of_case() {
        assert_eq!(kind_of(Path::new("a.PNG")), Some(CaptureKind::Image));
        assert_eq!(kind_of(Path::new("a.jpeg")), Some(CaptureKind::Image));
        assert_eq!(kind_of(Path::new("a.MP4")), Some(CaptureKind::Video));
        assert_eq!(kind_of(Path::new("a.mov")), Some(CaptureKind::Video));
        // Not captures: a half-written file and something with no extension.
        assert_eq!(kind_of(Path::new("a.png.tmp")), None);
        assert_eq!(kind_of(Path::new("notes")), None);
    }

    #[test]
    fn a_path_only_fires_once_inside_the_dedupe_window() {
        let sink = CaptureSink::default();
        let path = Path::new("/captures/shot.png");

        assert!(sink.claim(path), "first sighting should fire");
        assert!(
            !sink.claim(path),
            "a second event for the same file must not"
        );
    }

    #[test]
    fn one_screenshot_silences_exactly_one_clipboard_echo() {
        let sink = CaptureSink::default();
        *lock(&sink.folder_echo) = Some(Instant::now());

        assert!(
            sink.take_folder_echo(Duration::from_secs(4)),
            "the clipboard copy of a Win+PrtSc is an echo"
        );
        // Win+PrtSc followed straight away by a real Win+Shift+S must still be
        // caught, so the marker is consumed rather than left standing.
        assert!(!sink.take_folder_echo(Duration::from_secs(4)));
    }

    #[test]
    fn a_stale_echo_marker_does_not_swallow_a_later_capture() {
        let sink = CaptureSink::default();
        *lock(&sink.folder_echo) = Some(Instant::now() - Duration::from_secs(30));

        assert!(!sink.take_folder_echo(Duration::from_secs(4)));
    }

    #[test]
    fn our_own_clipboard_write_is_not_a_capture() {
        let sink = CaptureSink::default();

        sink.expect_own_clipboard_write(Duration::from_secs(3));
        assert!(sink.take_own_clipboard_write(), "the copy we just made");
        assert!(!sink.take_own_clipboard_write(), "and only that one");
    }

    #[test]
    fn an_expired_self_write_warning_is_ignored() {
        let sink = CaptureSink::default();

        // Warning already in the past: a clipboard change now is genuinely new.
        sink.expect_own_clipboard_write(Duration::ZERO);
        assert!(!sink.take_own_clipboard_write());
    }
}
