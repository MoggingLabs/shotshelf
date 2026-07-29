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

        // Move the watermark on, so the next launch does not offer this one
        // back after the user has removed it. Only ever forwards — see
        // `SettingsStore::note_capture`.
        if let Some(store) = app.try_state::<crate::settings::SettingsStore>() {
            store.note_capture(capture.ts);
        }

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

    /// Stand the warning down because the write it was armed for did not happen.
    ///
    /// Without this a failed clipboard write left a live marker with nothing to
    /// consume it, so the *next* genuine screenshot inside the window was
    /// mistaken for our own copy and silently dropped — the failure the marker
    /// exists to prevent, produced by the error path that arms it.
    pub fn cancel_own_clipboard_write(&self) {
        *lock(&self.own_clipboard_write) = None;
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
///
/// **Managed before the slow work starts, and filled in afterwards.** Starting
/// the engine can block for seconds — `resolve_watch_dirs` does `exists`,
/// `create_dir` and `canonicalize` per candidate, and under Windows folder
/// redirection each is an SMB round trip — so it runs on a worker. That left
/// the two commands below reading state that was not there yet: Tauri creates
/// the window *before* `setup` runs, so the webview asks within milliseconds
/// and both commands answered with an empty list. A backfill that returned
/// nothing and a status line that said "no capture folders are being watched"
/// on a launch where nothing was wrong — permanently, because nothing re-asks.
///
/// `settings.ts` already documents this exact race for `get_settings` and
/// works around it by retrying. Rather than have every caller retry, the state
/// exists from the start and says which of the two things it means:
/// `None` is "still starting", `Some` is an answer.
pub struct CatchEngine {
    /// Where the engine actually is listening, once it knows.
    ///
    /// `None` until `start` finishes. Only the resolved list is kept — the
    /// *intended* one was stored beside it and became unread the moment the
    /// status line stopped reporting it, and two lists with no way to tell
    /// which answers "is it working" is worse than one.
    watching: Mutex<Option<Vec<PathBuf>>>,
    /// Dropping the watch stops the `notify` threads.
    _folders: Mutex<Option<folders::FolderWatch>>,
}

impl CatchEngine {
    /// The resolved watch list, or `None` while the engine is still starting.
    fn watching(&self) -> Option<Vec<PathBuf>> {
        lock(&self.watching).clone()
    }
}

/// Put the engine in state before anything slow happens.
///
/// Split from `start` so `lib.rs` can do this synchronously in `setup` and
/// then hand the slow half to a worker.
pub fn reserve<R: Runtime>(app: &AppHandle<R>) {
    app.manage(CatchEngine {
        watching: Mutex::new(None),
        _folders: Mutex::new(None),
    });
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

    // The copy-out fallback needs to reach the sink to flag its own clipboard
    // writes, so the shelf doesn't catch what the shelf just copied.
    app.manage(sink);

    // Filled in, not managed: `reserve` put this in place before the window
    // was shown, precisely so the commands below never see it missing.
    if let Some(engine) = app.try_state::<CatchEngine>() {
        *lock(&engine.watching) = Some(watching);
        *lock(&engine._folders) = folders;
    }
}

/// How far back a launch looks for captures it was not running to see.
///
/// Shotshelf only ever hears about a capture from a watcher, and a watcher only
/// runs while the app does. Install it, use it for a day, reboot — and the
/// shelf came back empty, having missed everything taken since. The README says
/// it "catches every new screenshot", and after any restart that was false.
///
/// A day, not everything: this is for the gap between sessions, not for
/// indexing a Pictures folder. Anything older is history the user already has a
/// folder for.
const BACKFILL_WINDOW: Duration = Duration::from_secs(24 * 60 * 60);

/// The most captures a launch will bring back.
///
/// A hard bound, because the alternative is a first run on a machine with four
/// thousand screenshots filling the shelf with a decade of them. Well under the
/// default item cap, so a backfill never evicts anything the user pinned.
const BACKFILL_LIMIT: usize = 20;

/// How recently a file may have changed and still count as finished.
///
/// A recording in progress has an mtime of *now*. The watcher has a whole
/// settle loop for that — stability ticks, an empty-file timeout — and a
/// backfill cannot run one, because it gets a single look at the folder. So it
/// declines anything this recent and leaves it to the watcher, which is already
/// watching that folder and will emit it properly once it stops growing.
///
/// That also removes the only way the two paths could double-shelve one
/// capture: a file the watcher is about to emit is a file backfill skips.
const BACKFILL_SETTLED: Duration = Duration::from_secs(5);

/// Captures that landed while Shotshelf was not running.
///
/// **Pulled by the front end, not pushed at it.** This was a thread spawned in
/// `setup` that emitted `capture://new`, and it delivered nothing: Tauri
/// creates the window and then runs `setup`, so those events fired within
/// milliseconds while the webview was still loading its bundle — and Tauri
/// delivers only to registered handlers and buffers nothing. The whole feature
/// was a no-op that two documents promised to users. `main.ts` already names
/// this exact failure for `update://available`, which survives only because a
/// network round trip is slower than a page load.
///
/// So it is a command, the shape pinned captures already use: the front end
/// asks once it is listening, and gets an answer it cannot miss.
#[tauri::command]
pub async fn catch_backfill<R: Runtime>(app: AppHandle<R>) -> Result<Vec<Capture>, String> {
    // Same distinction as `catch_watch_dirs`: "still starting" is not "nothing
    // to bring back". Answering the second for the first made this a silent
    // no-op again — the very failure the pull-based rewrite existed to fix,
    // moved from event ordering to state registration.
    let engine = app
        .try_state::<CatchEngine>()
        .ok_or_else(|| STARTING.to_owned())?;
    let dirs = engine.watching().ok_or_else(|| STARTING.to_owned())?;
    let since = app
        .try_state::<crate::settings::SettingsStore>()
        .map_or(0, |store| store.last_capture_ms());

    // On a blocking worker: a `read_dir` plus a `metadata` per entry across
    // every watch folder, and one of those folders can be a disconnected SMB
    // share under enterprise folder redirection, where each call is a round
    // trip with a multi-second timeout.
    let found = tauri::async_runtime::spawn_blocking(move || scan(&dirs))
        .await
        .unwrap_or_default();

    let chosen = to_backfill(found, SystemTime::now(), since);

    // Move the watermark past what is being handed over.
    //
    // Without this the whole mechanism does nothing: `note_capture` had one
    // caller, the live capture sink, so a capture that only ever arrived via a
    // backfill never advanced it — and came back on the next launch, and the
    // one after that, however many times the user removed it. `Remove` not
    // surviving a restart is exactly what the watermark was added to fix, and
    // `settings.rs` even documents this caller ("a backfill hands over
    // yesterday's after today's have already landed") for a call that did not
    // exist.
    if let Some(store) = app.try_state::<crate::settings::SettingsStore>() {
        if let Some(newest) = newest_of(&chosen) {
            store.note_capture(newest);
        }
    }

    if !chosen.is_empty() {
        crate::diag::info(&format!(
            "{} captures from before this launch",
            chosen.len()
        ));
    }
    Ok(chosen)
}

/// Everything on disk that could be a capture, with when it was taken.
fn scan(dirs: &[PathBuf]) -> Vec<(SystemTime, PathBuf, CaptureKind)> {
    let mut found = Vec::new();
    for dir in dirs {
        // The macOS case this exists for: the folder permission prompt was
        // declined, so `is_dir()` still succeeds, the folder is watched, the
        // status dot is green — and every read returns `Operation not
        // permitted`. Backfill then returns nothing, which is
        // indistinguishable from "no captures were taken", and `docs/USAGE.md`
        // sends the user to a log that said nothing.
        let entries = match std::fs::read_dir(dir) {
            Ok(entries) => entries,
            Err(err) => {
                crate::diag::warn(&format!(
                    "could not read {} — {err}. On macOS this is usually a \
                     declined folder-permission prompt; grant it under \
                     Privacy & Security -> Files and Folders.",
                    dir.display()
                ));
                continue;
            }
        };
        for entry in entries.flatten() {
            let path = entry.path();
            // The watcher's own admission rule, shared rather than restated.
            // Without it a macOS `._Screenshot.png` — an AppleDouble stub that
            // sits beside every real file on exFAT and SMB volumes, keeps the
            // `.png` extension and passes `kind_of` — is shelved as a
            // screenshot, 4 KB of resource fork rendered as a broken image.
            if folders::is_partial(&path) {
                continue;
            }
            let Some(kind) = kind_of(&path) else { continue };
            let Ok(meta) = entry.metadata() else { continue };
            // A directory named `shots.png` is not a capture, and a zero-length
            // file is a placeholder its writer has not filled in yet.
            if !meta.is_file() || meta.len() == 0 {
                continue;
            }
            let Ok(modified) = meta.modified() else {
                continue;
            };
            found.push((modified, path, kind));
        }
    }
    found
}

/// Which of the files found should be shelved, and when each was taken.
///
/// Separated from the `read_dir` so the rule can be stated without a
/// filesystem or a clock: what it decides — how far back, how recent is too
/// recent, how many, in which order, and what is already known — is the whole
/// of what a user sees after a restart.
fn to_backfill(
    mut found: Vec<(SystemTime, PathBuf, CaptureKind)>,
    now: SystemTime,
    since_ms: u64,
) -> Vec<Capture> {
    let cutoff = now - BACKFILL_WINDOW;
    let settled = now - BACKFILL_SETTLED;

    found.retain(|(modified, _, _)| {
        // Newer than the newest capture the shelf has already seen.
        //
        // Without this, backfill undoes `Remove`. Taking a capture off the
        // shelf is deliberately shelf-only — the file stays on disk, which is
        // the app's central promise — so every removed capture from the last
        // 24 hours came straight back on the next launch, along with anything
        // retention had already expired. A user who curates their shelf and
        // then reboots got all twenty back. `Remove` and a naive backfill
        // cancel each other out exactly.
        as_ms(*modified) > since_ms && *modified >= cutoff && *modified <= settled
    });

    // Newest first to apply the cap, so the cap keeps the most recent...
    found.sort_unstable_by_key(|(modified, _, _)| std::cmp::Reverse(*modified));
    found.truncate(BACKFILL_LIMIT);
    // ...then oldest first onto the shelf, so the order the user sees matches
    // the order they took them in. The shelf shows newest at the top and builds
    // that by prepending.
    found.reverse();

    found
        .into_iter()
        .map(|(modified, path, kind)| Capture {
            path: path.display().to_string(),
            kind,
            // **When it was taken**, not when it was found. `emit` stamps
            // `now_ms()` because a live capture is being taken as it runs; a
            // backfilled one is not, and stamping the launch time put
            // yesterday's screenshots under "Today" and restarted the retention
            // clock on every launch — so with a one-hour window they would
            // never expire.
            ts: as_ms(modified),
            // Deliberately absent. The foreground context answers "what was in
            // front when this landed", and for a capture taken before this
            // process existed that is unknowable. Reading it now would answer
            // "Shotshelf".
            context: crate::enrich::foreground::Context::default(),
        })
        .collect()
}

/// The newest timestamp among the captures being handed over, if any.
///
/// Split out so the round's blocker fix is reachable by a test. Deleting the
/// whole `note_capture` block left every gate green — no Rust test calls
/// `catch_backfill` (it needs an `AppHandle`) and the front-end stubs answer
/// with canned arrays — so the one line that makes `Remove` survive a restart
/// was one deletion from silently going away again.
fn newest_of(chosen: &[Capture]) -> Option<u64> {
    chosen.iter().map(|capture| capture.ts).max()
}

fn as_ms(at: SystemTime) -> u64 {
    at.duration_since(UNIX_EPOCH).map_or(0, |since| {
        u64::try_from(since.as_millis()).unwrap_or(u64::MAX)
    })
}

/// Let the webview render captures straight off disk.
///
/// The asset protocol is scoped shut by default, and the scope has to be
/// granted here rather than in `tauri.conf.json`: the macOS capture folder is
/// only known once `defaults read` has run, and `SHOTSHELF_WATCH_DIRS` can
/// replace the list outright. Deriving it from the resolved watch list keeps
/// one source of truth — the shelf can read exactly what the engine watches,
/// non-recursively, and nothing else.
/// Let the webview read the captures a restart is about to put back.
///
/// Called synchronously from `setup`, before the engine starts on its worker,
/// and that timing is the whole point. The webview is created *before* `setup`
/// runs; `settings::load` and `app.manage` complete a few statements in, so
/// `get_settings` can be answered and `restorePinned` builds tiles immediately.
/// The grant those tiles need, however, is inside `catch::start` — which is on
/// `spawn_blocking` precisely because resolving watch folders can take
/// multi-second SMB round trips on a redirected profile.
///
/// Lose that race and the failure is permanent, not transient: `tile.ts` binds
/// its `error` handler `{ once: true }` and swaps in the "file has gone"
/// warning, and `ShelfView` reuses that node on every later render. The user
/// sees ⚠ against files that are present, which `docs/USAGE.md` defines as
/// "moved or deleted since it was caught". `describe_capture` fails the same
/// scope check, so the card also reads as never scanned for credentials.
///
/// Only the parent directories of pinned captures, because those are the only
/// paths the front end can ask for before the engine is up — nothing else is on
/// the shelf yet. The engine's own wider grant follows and supersedes it.
pub fn allow_reading_pinned<R: Runtime>(app: &AppHandle<R>, pinned: &[PathBuf]) {
    let scope = app.asset_protocol_scope();

    for parent in pinned.iter().filter_map(|path| path.parent()) {
        if let Err(err) = scope.allow_directory(parent, false) {
            crate::diag::warn(&format!(
                "a pinned capture in {} may not show until the catch engine is up: {err}",
                parent.display()
            ));
        }
    }
}

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
pub fn catch_watch_dirs<R: Runtime>(app: AppHandle<R>) -> Result<Vec<String>, String> {
    // An error, not an empty list, while the engine is still coming up.
    //
    // The two are opposite answers: empty means "nothing is being watched, the
    // app's one job is not happening", which the front end reports in those
    // words. Returning it for "ask me again in a moment" told the user their
    // install was broken on a launch where nothing was wrong, and left it
    // saying so for the rest of the session.
    let engine = app
        .try_state::<CatchEngine>()
        .ok_or_else(|| STARTING.to_owned())?;

    // `watching`, not the intended list: reporting what the engine *meant* to
    // watch turned every watcher failure into a green dot. See `folders::start`.
    engine
        .watching()
        .map(|dirs| dirs.iter().map(|dir| dir.display().to_string()).collect())
        .ok_or_else(|| STARTING.to_owned())
}

/// What both commands say while the catch engine is still starting.
///
/// Matched by the front end, which retries — the same shape `settings.ts` uses
/// for `get_settings`, which loses the same race for the same reason.
pub const STARTING: &str = "the catch engine is still starting";

/// The same sentence, as the front end matches it.
///
/// One string in three hand-maintained copies across two languages, with
/// nothing joining them: this constant, `main.ts`'s `includes("still starting")`
/// and the e2e harness's own copy of the message. Rewording this alone left
/// every gate green — clippy, 129 Rust tests, 118 browser tests — while in the
/// real app `main.ts`'s `transient` predicate would answer `false` on the first
/// reply, so both catch commands fail immediately and every launch reports
/// "Shotshelf could not reach its catch engine" on a healthy machine. That is
/// the exact failure this sentinel exists to prevent.
///
/// The fixture is the join, the way `secret-kinds.json` and
/// `settings-bounds.json` already are for their rules.
#[cfg(test)]
const STARTING_FIXTURE: &str = include_str!("../../../tests/fixtures/engine-starting.json");

/// A watcher thread dying mid-update should not take the whole engine with it;
/// the worst a poisoned lock costs here is one stale timestamp.
fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Now, as Unix milliseconds.
///
/// Literally `as_ms(SystemTime::now())`. An earlier commit claimed to have made
/// it so and only edited the comment: the body stayed a second copy with
/// different saturation — a wrapping `as` cast where `as_ms` clamps — eighty
/// lines from the original, in the module that stamps both live captures and
/// backfilled ones. This is the deduplication that message described.
pub(crate) fn now_ms() -> u64 {
    as_ms(SystemTime::now())
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW_SECS: u64 = 1_000_000;

    fn now() -> SystemTime {
        SystemTime::UNIX_EPOCH + Duration::from_secs(NOW_SECS)
    }

    fn seen(secs_ago: u64, name: &str) -> (SystemTime, PathBuf, CaptureKind) {
        (
            SystemTime::UNIX_EPOCH + Duration::from_secs(NOW_SECS - secs_ago),
            PathBuf::from(name),
            CaptureKind::Image,
        )
    }

    /// Old enough to have settled, recent enough to be inside the window.
    fn ordinary(secs_ago: u64, name: &str) -> (SystemTime, PathBuf, CaptureKind) {
        seen(secs_ago + BACKFILL_SETTLED.as_secs(), name)
    }

    fn names(chosen: &[Capture]) -> Vec<&str> {
        chosen.iter().map(|c| c.path.as_str()).collect()
    }

    #[test]
    fn the_starting_sentinel_matches_what_the_front_end_waits_for() {
        // Both sides of one string, joined through the fixture rather than
        // agreeing by hand. `src/main.ts` matches on a substring of this; the
        // e2e harness replies with it.
        let shared: serde_json::Value =
            serde_json::from_str(STARTING_FIXTURE).expect("the shared fixture parses");
        assert_eq!(
            shared["starting"].as_str(),
            Some(STARTING),
            "the sentinel and the fixture the front end reads have drifted",
        );
    }

    #[test]
    fn a_launch_brings_back_recent_captures_oldest_first() {
        // What a user sees after a reboot. Shotshelf only hears about a capture
        // from a watcher, and a watcher only runs while the app does — so
        // before this, every restart lost everything taken since the last one
        // while the README claimed it "catches every new screenshot".
        let chosen = to_backfill(
            vec![
                ordinary(60, "newest.png"),
                ordinary(600, "older.png"),
                ordinary(30, "newer.png"),
            ],
            now(),
            0,
        );

        assert_eq!(
            names(&chosen),
            vec!["older.png", "newest.png", "newer.png"],
            "oldest first, so the shelf's newest-on-top order matches when they were taken",
        );
    }

    #[test]
    fn a_backfilled_capture_is_dated_when_it_was_taken() {
        // Not when it was found. `emit` stamps `now_ms()` because a live
        // capture is being taken as it runs; stamping a backfilled one the same
        // way put yesterday's screenshots under "Today" and restarted the
        // retention clock every launch — so with a one-hour window they would
        // never expire at all.
        let taken = ordinary(3_600, "an-hour-ago.png");
        let chosen = to_backfill(vec![taken.clone()], now(), 0);

        assert_eq!(chosen.len(), 1);
        assert_eq!(chosen[0].ts, as_ms(taken.0));
        assert_ne!(chosen[0].ts, as_ms(now()), "not the launch time");
    }

    #[test]
    fn a_launch_does_not_undo_remove() {
        // Taking a capture off the shelf is shelf-only by design — the file
        // stays on disk — so a backfill that looks only at the last 24 hours
        // brought every removed capture straight back, along with anything
        // retention had already expired. A user who curates their shelf and
        // reboots got all of it back. The watermark is what makes `Remove`
        // stick across a restart.
        let watermark = as_ms(ordinary(300, "x").0);
        let chosen = to_backfill(
            vec![
                ordinary(600, "removed-last-session.png"),
                ordinary(300, "exactly-the-watermark.png"),
                ordinary(60, "taken-while-the-app-was-closed.png"),
            ],
            now(),
            watermark,
        );

        assert_eq!(
            names(&chosen),
            vec!["taken-while-the-app-was-closed.png"],
            "only what the shelf has never been told about",
        );
    }

    #[test]
    fn a_capture_still_being_written_is_left_to_the_watcher() {
        // A recording in progress has an mtime of *now*. Backfill gets one look
        // at the folder and cannot run the watcher's settle loop, so shelving
        // it here would hand over a truncated file — the exact failure
        // `folders.rs` exists to prevent. Leaving it also removes the only way
        // the two paths could double-shelve one capture.
        let chosen = to_backfill(
            vec![
                seen(1, "recording-in-progress.mp4"),
                ordinary(60, "finished.png"),
            ],
            now(),
            0,
        );

        assert_eq!(names(&chosen), vec!["finished.png"]);
    }

    #[test]
    fn a_launch_does_not_index_the_pictures_folder() {
        // Two bounds, both of which matter on a first run. Anything older than
        // the window is history the user already has a folder for, and a
        // machine with four thousand screenshots must not have them all
        // shelved.
        let stale = to_backfill(
            vec![ordinary(BACKFILL_WINDOW.as_secs() + 60, "last-week.png")],
            now(),
            0,
        );
        assert!(stale.is_empty(), "older than the window");

        // Deliberately shuffled, so the cap is tested against the *sort* and
        // not against the order the fixture happened to be built in. Generated
        // newest-first, the previous version of this passed with the sort
        // deleted outright.
        let mut flood: Vec<_> = (0..BACKFILL_LIMIT * 5)
            .map(|n| ordinary(u64::try_from(n).unwrap() * 10, &format!("shot{n}.png")))
            .collect();
        flood.rotate_left(37);
        flood.swap(0, BACKFILL_LIMIT * 2);

        let capped = to_backfill(flood, now(), 0);
        assert_eq!(capped.len(), BACKFILL_LIMIT);
        // The cap keeps the newest — `shot0` is the most recent, `shot99` the
        // oldest — whatever order they were found in.
        assert!(names(&capped).contains(&"shot0.png"), "the newest survived");
        assert!(
            !names(&capped).contains(&"shot99.png"),
            "the oldest did not"
        );
    }

    #[test]
    fn a_backfill_moves_the_watermark_past_everything_it_hands_over() {
        // Otherwise `Remove` does not survive a restart for anything the
        // backfill delivered — which is the entire reason the watermark exists,
        // and it went a round with the call missing while the docstring in
        // `settings.rs` described the caller.
        //
        // The *newest*, not the last: the list is handed over oldest-first so
        // the shelf's newest-on-top order matches when they were taken, so
        // taking the final element would leave the watermark behind the newest
        // capture and re-offer it forever.
        let chosen = to_backfill(
            vec![
                ordinary(600, "older.png"),
                ordinary(60, "newest.png"),
                ordinary(300, "middle.png"),
            ],
            now(),
            0,
        );
        let newest = newest_of(&chosen).expect("something was chosen");

        // Against `to_backfill`'s output, not against `newest_of`'s own body.
        //
        // The first version of this asserted
        // `newest == chosen.iter().map(|c| c.ts).max().unwrap()`, which is the
        // function compared to itself and cannot fail. What matters is the
        // relationship to the *next* launch: feed the watermark back in and
        // nothing already handed over may come again.
        let next_launch = to_backfill(
            vec![
                ordinary(600, "older.png"),
                ordinary(60, "newest.png"),
                ordinary(300, "middle.png"),
            ],
            now(),
            newest,
        );
        assert!(
            next_launch.is_empty(),
            "a relaunch re-offered captures the last one already handed over: {:?}",
            next_launch.iter().map(|c| &c.path).collect::<Vec<_>>(),
        );

        // Specifically the newest, not the last element: the list is handed
        // over oldest-first, so taking the tail would leave the watermark
        // behind and re-offer the newest capture on every launch, for ever.
        let tail = chosen.last().expect("something was chosen").ts;
        assert!(newest >= tail);

        // And a launch with nothing to bring back must not move it at all —
        // moving it forward on an empty answer would skip captures taken
        // between now and the next launch.
        assert_eq!(newest_of(&[]), None);
    }

    #[test]
    fn a_backfilled_capture_claims_no_foreground_context() {
        // "What was in front when this landed" is unknowable for a capture
        // taken before this process existed, and reading it now would answer
        // "Shotshelf" — labelling every recovered card with the app that
        // recovered it.
        let chosen = to_backfill(vec![ordinary(60, "yesterday.png")], now(), 0);
        assert!(chosen[0].context.is_empty());
    }

    #[test]
    fn a_scan_admits_only_what_the_watcher_would_admit() {
        // Against `scan` itself, not against `is_partial` in isolation.
        //
        // Deleting both guards from `scan` left all 116 tests green: the rule
        // was tested in `folders.rs` and nothing checked that `scan` still
        // called it. That is verbatim the criticism `edit.rs` levels at its own
        // former test — "splitting the sanitiser out and testing that was not
        // enough: it left nothing checking that `write_edit` still called it".
        let dir = std::env::temp_dir().join(format!("shotshelf-scan-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("a temp dir");

        std::fs::write(dir.join("real.png"), b"pixels").expect("a capture");
        // A macOS AppleDouble stub. Sits beside every real file on exFAT and
        // SMB volumes, keeps the `.png` extension, and is 4 KB of resource
        // fork — a broken image on the shelf if it is admitted.
        std::fs::write(dir.join("._real.png"), b"resource fork").expect("a stub");
        std::fs::write(dir.join("half.png.part"), b"partial").expect("a partial");
        std::fs::write(dir.join("~draft.png"), b"draft").expect("a draft");
        // A placeholder its writer has not filled in yet.
        std::fs::write(dir.join("empty.png"), b"").expect("an empty file");
        // Not a capture at all.
        std::fs::write(dir.join("notes.txt"), b"text").expect("a text file");
        // A *directory* that looks like one.
        std::fs::create_dir_all(dir.join("album.png")).expect("a directory");

        let found = scan(std::slice::from_ref(&dir));
        let mut names: Vec<String> = found
            .iter()
            .map(|(_, path, _)| {
                path.file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned()
            })
            .collect();
        names.sort();

        assert_eq!(names, vec!["real.png".to_owned()], "admitted: {names:?}");

        let _ = std::fs::remove_dir_all(&dir);
    }

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
    fn a_write_that_failed_does_not_swallow_the_next_real_capture() {
        // The second half of the macOS clipboard blocker, and the half with no
        // test: the marker was armed before the write and left standing when the
        // write failed, so the *next* genuine screenshot inside the window was
        // taken for our own echo and dropped. On macOS, where every recording
        // copy failed outright, that was every time.
        let sink = CaptureSink::default();

        sink.expect_own_clipboard_write(Duration::from_secs(3));
        // …the write fails, so `share::copy_capture` stands the marker down.
        sink.cancel_own_clipboard_write();

        assert!(
            !sink.take_own_clipboard_write(),
            "a screenshot taken now is the user's, not our echo",
        );
    }

    #[test]
    fn an_expired_self_write_warning_is_ignored() {
        let sink = CaptureSink::default();

        // Warning already in the past: a clipboard change now is genuinely new.
        sink.expect_own_clipboard_write(Duration::ZERO);
        assert!(!sink.take_own_clipboard_write());
    }
}
