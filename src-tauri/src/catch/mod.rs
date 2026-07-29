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
    /// What was in front when this landed.
    ///
    /// Read here rather than when a card is drawn, because by then it is no
    /// longer true — the whole value of "VS Code — auth.ts" is that it names
    /// the moment the capture was taken, and a second later the answer is
    /// "Shotshelf".
    #[serde(skip_serializing_if = "crate::enrich::foreground::Context::is_empty")]
    pub context: crate::enrich::foreground::Context,
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
            context: crate::enrich::foreground::current(),
        };

        match app.emit(CAPTURE_EVENT, &capture) {
            // Neither the window title nor the folder.
            //
            // A terminal titles itself with its command line, and a capture's
            // path carries client and project names just as readily — and on
            // macOS and Linux an app's stdout is collected into the unified
            // log or the journal: on disk, outside the app, unredacted, and
            // untouched by any retention setting. The filename is enough to
            // follow a capture through the pipeline.
            Ok(()) => crate::diag::info(&format!(
                "caught {:?} {}",
                kind,
                std::path::Path::new(&capture.path)
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
            )),
            Err(err) => crate::diag::warn(&format!("could not emit {CAPTURE_EVENT}: {err}")),
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
    /// Where the engine actually is listening — see `catch_watch_dirs`.
    ///
    /// Only this. The resolved *intended* list was stored beside it and became
    /// unread the moment the status line stopped reporting it; keeping both
    /// would leave the next reader a choice between two lists with no way to
    /// tell which one answers "is it working".
    watching: Vec<PathBuf>,
    /// Dropping the watch stops the `notify` threads.
    _folders: Option<folders::FolderWatch>,
}

/// Start watching. Never fatal: a shelf with a broken watcher is still a shelf,
/// so failures are logged and the rest of the engine carries on.
pub fn start<R: Runtime>(app: &AppHandle<R>, overrides: &[PathBuf]) {
    let watch_dirs = paths::resolve_watch_dirs(app, overrides);
    let sink = std::sync::Arc::new(CaptureSink::default());

    if watch_dirs.is_empty() {
        crate::diag::warn("no capture folders found — clipboard watch only");
    }
    for dir in &watch_dirs {
        crate::diag::info(&format!("watching {}", dir.display()));
    }

    allow_reading_captures(app, &watch_dirs);

    let folders = match folders::start(app, &watch_dirs, std::sync::Arc::clone(&sink)) {
        Ok(watch) => Some(watch),
        Err(err) => {
            crate::diag::warn(&format!("folder watching unavailable: {err}"));
            None
        }
    };

    // What is actually being watched, not what was asked for. With the whole
    // watcher dead this is empty, and the shelf says so rather than showing a
    // green dot over nothing.
    let watching = folders
        .as_ref()
        .map(|watch| watch.watching.clone())
        .unwrap_or_default();

    clipboard::start(app, std::sync::Arc::clone(&sink));

    // What landed while Shotshelf was not running, on its own thread.
    //
    // A `read_dir` plus a `metadata` per entry across every watch folder, and
    // one of those folders can be a disconnected network share under
    // enterprise folder redirection — where each of those calls is a blocking
    // round trip with a multi-second timeout. Nothing about that belongs on
    // the thread the window is waiting on: the webview only listens for
    // `capture://new`, so these arrive whenever they arrive.
    let backfill_app = app.clone();
    let backfill_dirs = watching.clone();
    let backfill_sink = std::sync::Arc::clone(&sink);
    std::thread::spawn(move || {
        backfill(&backfill_app, &backfill_dirs, &backfill_sink);
    });

    // The copy-out fallback needs to reach the sink to flag its own clipboard
    // writes, so the shelf doesn't catch what the shelf just copied.
    app.manage(sink);

    app.manage(CatchEngine {
        watching,
        _folders: folders,
    });
}

/// How far back a launch looks for captures it was not running to see.
///
/// Shotshelf only ever hears about a capture from a watcher, and a watcher
/// only runs while the app does. Install it, use it for a day, reboot — and
/// the shelf comes back empty, having missed everything taken since. The
/// README says it "catches every new screenshot automatically", and after any
/// restart that was false.
///
/// A day, not everything: this is for the gap between sessions, not for
/// indexing a Pictures folder. Anything older is history the user already has
/// a folder for.
const BACKFILL_WINDOW: Duration = Duration::from_secs(24 * 60 * 60);

/// The most captures a launch will bring back.
///
/// A hard bound, because the alternative is a first run on a machine with four
/// thousand screenshots filling the shelf with a decade of them. Well under
/// the default item cap, so a backfill never evicts anything the user pinned.
const BACKFILL_LIMIT: usize = 20;

/// Shelve captures that landed while Shotshelf was not running.
///
/// Through the same sink as the watchers, so de-duplication, the clipboard
/// echo rule and the event shape are all shared — a backfilled capture is a
/// capture, not a second kind of thing.
fn backfill<R: Runtime>(app: &AppHandle<R>, dirs: &[PathBuf], sink: &CaptureSink) {
    let mut found: Vec<(SystemTime, PathBuf, CaptureKind)> = Vec::new();
    for dir in dirs {
        let Ok(entries) = std::fs::read_dir(dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Some(kind) = kind_of(&path) else { continue };
            let Ok(modified) = entry.metadata().and_then(|meta| meta.modified()) else {
                continue;
            };
            found.push((modified, path, kind));
        }
    }

    let chosen = to_backfill(found, SystemTime::now());
    if !chosen.is_empty() {
        crate::diag::info(&format!(
            "{} captures from before this launch",
            chosen.len()
        ));
    }
    for (path, kind) in chosen {
        sink.emit(app, &path, kind, Source::Folder);
    }
}

/// Which of the files found should be shelved, in the order they go on.
///
/// Separated from the `read_dir` so the rule can be stated without a
/// filesystem or a clock: what it decides — how far back, how many, and in
/// which order — is the whole of what a user sees after a restart.
fn to_backfill(
    mut found: Vec<(SystemTime, PathBuf, CaptureKind)>,
    now: SystemTime,
) -> Vec<(PathBuf, CaptureKind)> {
    let cutoff = now - BACKFILL_WINDOW;
    found.retain(|(modified, _, _)| *modified >= cutoff);

    // Newest first to apply the cap, so the cap keeps the most recent...
    found.sort_unstable_by_key(|(modified, _, _)| std::cmp::Reverse(*modified));
    found.truncate(BACKFILL_LIMIT);
    // ...then oldest first onto the shelf, so the order the user sees matches
    // the order they took them in. The shelf shows newest at the top, and it
    // builds that by prepending.
    found.reverse();

    found
        .into_iter()
        .map(|(_, path, kind)| (path, kind))
        .collect()
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
            crate::diag::warn(&format!(
                "the shelf will not be able to show captures from {}: {err}",
                dir.display()
            ));
        }
    }
}

/// Watch-path override: `SHOTSHELF_WATCH_DIRS`, `;`-separated on Windows and
/// `:` elsewhere.
///
/// Deliberately an environment variable and not a setting. The default watch
/// folders are discovered from the OS, which is what makes the app work with
/// no configuration; this exists for the cases discovery cannot cover — a
/// capture tool writing somewhere unusual — and for driving the engine from
/// synthetic fixtures in testing, which is not something a settings panel
/// should offer.
pub fn overrides_from_env() -> Vec<PathBuf> {
    std::env::var_os("SHOTSHELF_WATCH_DIRS")
        .map(|value| std::env::split_paths(&value).collect())
        .unwrap_or_default()
}

/// Lets the shelf show where it is listening, so "nothing is appearing" has an
/// answer the user can see rather than a silence they have to guess at.
#[tauri::command]
pub fn catch_watch_dirs<R: Runtime>(app: AppHandle<R>) -> Vec<String> {
    app.try_state::<CatchEngine>()
        .map(|engine| {
            // `watching`, not `watch_dirs`: the second is where the engine
            // *meant* to listen, and reporting that turned every watcher
            // failure into a green dot. See `folders::start`.
            engine
                .watching
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

    fn seen(secs_ago: u64, name: &str) -> (SystemTime, PathBuf, CaptureKind) {
        (
            SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000 - secs_ago),
            PathBuf::from(name),
            CaptureKind::Image,
        )
    }

    #[test]
    fn a_launch_brings_back_recent_captures_oldest_first() {
        // What a user sees after a reboot. Shotshelf only hears about a
        // capture from a watcher, and a watcher only runs while the app does —
        // so before this, every restart lost everything taken since the last
        // one, while the README claimed it "catches every new screenshot
        // automatically".
        let now = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
        let chosen = to_backfill(
            vec![
                seen(60, "newest.png"),
                seen(600, "older.png"),
                seen(30, "newer.png"),
            ],
            now,
        );

        assert_eq!(
            chosen.iter().map(|(p, _)| p.as_path()).collect::<Vec<_>>(),
            vec![
                Path::new("older.png"),
                Path::new("newest.png"),
                Path::new("newer.png")
            ],
            "oldest first, so the shelf's newest-on-top order matches when they were taken",
        );
    }

    #[test]
    fn a_launch_does_not_index_the_pictures_folder() {
        // Two bounds, and both matter on a first run. Anything older than the
        // window is history the user already has a folder for, and a machine
        // with four thousand screenshots must not have them all shelved.
        let now = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);

        let stale = to_backfill(
            vec![seen(BACKFILL_WINDOW.as_secs() + 60, "last-week.png")],
            now,
        );
        assert!(stale.is_empty(), "older than the window");

        let flood: Vec<_> = (0..BACKFILL_LIMIT * 5)
            .map(|n| seen(u64::try_from(n).unwrap(), &format!("shot{n}.png")))
            .collect();
        let capped = to_backfill(flood, now);
        assert_eq!(capped.len(), BACKFILL_LIMIT);
        // And the cap keeps the newest, not whichever the filesystem listed first.
        assert!(capped.iter().any(|(p, _)| p == Path::new("shot0.png")));
        assert!(!capped.iter().any(|(p, _)| p == Path::new("shot99.png")));
    }

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
