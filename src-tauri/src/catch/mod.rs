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

use crate::limits::lock;
use tauri::{AppHandle, Emitter, Manager, Runtime};

/// Event the shelf front-end listens on. Payload is [`Capture`].
pub const CAPTURE_EVENT: &str = "capture://new";

/// A capture that was lost on the way in. Payload is a sentence for the user.
///
/// The only channel from the catch engine to the alert strip, and until now
/// there was none: the crate emitted four events and `src/main.ts` listened for
/// those four, so a capture that could not be saved was written to
/// `shotshelf.log` and nowhere else.
///
/// That gap mattered most where it was least recoverable. A clipboard capture —
/// Win+Shift+S, ⌘⌃⇧4 — has no file anywhere until this process writes one, so a
/// full disk or an unwritable profile destroys the only copy that exists, and
/// what the user saw was the shelf simply not appearing. `docs/USAGE.md`'s
/// troubleshooting table attributes that to a folder not being watched, which
/// sends them looking in the wrong place entirely.
///
/// Deliberately not clipboard-specific: any capture-level failure belongs here.
pub const PROBLEM_EVENT: &str = "capture://problem";

/// Tell the user a capture did not make it, and say the same thing in the log.
pub(crate) fn report_problem<R: Runtime>(app: &AppHandle<R>, message: &str) {
    crate::diag::warn(message);
    if let Err(err) = app.emit(PROBLEM_EVENT, message) {
        crate::diag::warn(&format!("could not report that to the shelf: {err}"));
    }
}

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
    ///
    /// The *shape* is kept with the moment, because "an image landed in a
    /// folder recently" was never enough to prove the clipboard is holding a
    /// copy of it. Win+PrtSc is the only thing that writes both; a Game Bar
    /// clip, a save-only ShareX profile or a sync client dropping a screenshot
    /// in armed the same silencer, and the next Win+Shift+S inside four seconds
    /// was destroyed — the one capture with no other copy.
    folder_echo: Mutex<Option<(Instant, (u32, u32))>>,
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

        self.note_folder_image(path, kind, source);

        let capture = Capture {
            path: path.display().to_string(),
            kind,
            // When Shotshelf caught it, not the file's own mtime.
            //
            // Stamping the mtime was tried, to make this path and the backfill
            // agree on `captureId` and stop one capture becoming two cards. It
            // is the wrong trade. `is_write` admits a rename, so a file *moved*
            // into a watch folder — a sync client landing yesterday's
            // screenshot, a restore from backup, a drag into the folder — keeps
            // its old mtime, and retention reads this field: with "Keep for" at
            // an hour, that capture popped the column and then vanished from
            // the shelf fifteen seconds later, silently. Day grouping reads it
            // too, so with retention off it filed under a day the user was not
            // looking at.
            //
            // The duplicate that motivated it is fixed where the timing is
            // known: `to_backfill` hands each file over at its own folder's
            // watcher-start moment, so the two paths cannot both claim one
            // capture. The front-end merge that stood here briefly is gone —
            // it could see only one of the two routes a live capture takes.
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

    /// Arm the echo marker, if what was just emitted is a folder image.
    ///
    /// Split from `emit` so it can be tested: `emit` needs an `AppHandle`, which
    /// no test in this crate can build, so the whole *producer* of the marker
    /// was unreachable — deleting it left all 153 tests green while every
    /// Win+PrtSc shelved twice and left an unpruned PNG in a folder the app
    /// never prunes. `folders.rs` records that exact outcome as a defect it
    /// already shipped once.
    ///
    /// The *condition* comes with it, which the first split did not do. `emit`
    /// kept `if source == Source::Folder && kind == CaptureKind::Image` and
    /// called this for the body only, so swapping `Folder` for `Clipboard`
    /// there — after which no folder image ever arms the marker, and every
    /// Win+PrtSc shelves twice again — left clippy and all 155 tests green.
    /// Extracting a helper had moved the boundary and not the decision, and the
    /// decision is the part worth testing.
    ///
    /// Only the header is read: `image_dimensions` does not decode. A file that
    /// cannot be read arms nothing, which fails safe — an unarmed marker means
    /// a clipboard capture is kept.
    ///
    /// Failing safe is not the same as failing silently, so it is logged. A
    /// screenshot that lands mid-write, or in a format `image` cannot read a
    /// header for, shelves twice from then on and leaves an unpruned PNG in a
    /// folder the app never prunes — visible to the user, and previously with
    /// nothing anywhere saying why.
    pub fn note_folder_image(&self, path: &Path, kind: CaptureKind, source: Source) {
        if source != Source::Folder || kind != CaptureKind::Image {
            return;
        }

        match image::image_dimensions(path) {
            Ok(shape) => *lock(&self.folder_echo) = Some((Instant::now(), shape)),
            // The filename only, like every other line this module writes: a
            // capture's path names client and project work as readily as a
            // window title does.
            Err(err) => crate::diag::warn(&format!(
                "could not measure {}, so its clipboard copy will shelve as a second capture: {err}",
                path.file_name().unwrap_or_default().to_string_lossy()
            )),
        }
    }

    /// `true` if a folder image of this exact shape landed within `window` — and
    /// consumes it, so one screenshot can only ever silence one clipboard echo.
    /// Without that, a Win+PrtSc followed straight away by a genuine
    /// Win+Shift+S would lose the second capture.
    pub fn take_folder_echo(&self, window: Duration, shape: (u32, u32)) -> bool {
        let mut echo = lock(&self.folder_echo);
        match *echo {
            // Same shape as well as recent. Two captures of different sizes are
            // two captures, whatever their timing, and dropping the second cost
            // the user a screenshot that existed nowhere else.
            Some((seen, folder_shape)) if seen.elapsed() < window && folder_shape == shape => {
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
    /// What `start` resolved, or `None` while it is still running.
    started: Mutex<Option<Started>>,
    /// Dropping the watch stops the `notify` threads.
    _folders: Mutex<Option<folders::FolderWatch>>,
}

/// Everything `start` works out, in one value.
///
/// Three `Mutex<Option<_>>` fields before this, written in three consecutive
/// lines of `start` and read in pairs — so "is the engine up yet" was three
/// separate questions with three separate answers, and any pair of them could
/// disagree. One of the three answered it wrongly: the clipboard flag was read
/// with `unwrap_or(false)`, which reports "the clipboard watcher is not running"
/// for "nobody has asked it yet" — the exact conflation the `Option` was added
/// to prevent, on the indicator `docs/USAGE.md` points the user at first, and
/// reachable because the other two fields carried the `STARTING` answer and this
/// one silently did not.
///
/// One `Option` makes that unrepresentable: either `start` has finished and all
/// three are known, or it has not and no caller gets any of them.
#[derive(Clone)]
struct Started {
    /// Where the engine actually is listening.
    ///
    /// Only the resolved list is kept — the *intended* one was stored beside it
    /// and became unread the moment the status line stopped reporting it, and
    /// two lists with no way to tell which answers "is it working" is worse
    /// than one.
    dirs: Vec<PathBuf>,
    /// When each watched directory's watcher started — the boundary backfill needs.
    ///
    /// `notify` reports events, not history: it can only tell us about writes
    /// that happen after it registers. So "the watcher will emit this one" is
    /// true exactly of files whose last write landed at or after this moment,
    /// and false — permanently — of everything before it.
    since: Vec<(PathBuf, SystemTime)>,
    /// Whether the clipboard monitor is actually running.
    ///
    /// Recorded because the status line was asserting it: `describeWatch`
    /// appended "+ the clipboard" whatever had happened, so a monitor that
    /// failed to start left the dot green and the tooltip claiming a watcher
    /// that was not there — the same defect the folder half was fixed for, left
    /// standing on the other watcher.
    clipboard: bool,
}

impl CatchEngine {
    /// What `start` resolved, or `None` while the engine is still starting.
    ///
    /// Cloned out rather than handed a reference: every caller is a
    /// `#[tauri::command]` that goes on to do slow work — a `read_dir` across
    /// network shares, in `catch_backfill`'s case — and holding this lock across
    /// that would block `start` itself.
    fn started(&self) -> Option<Started> {
        lock(&self.started).clone()
    }
}

/// Put the engine in state before anything slow happens.
///
/// Split from `start` so `lib.rs` can do this synchronously in `setup` and
/// then hand the slow half to a worker.
pub fn reserve<R: Runtime>(app: &AppHandle<R>) {
    app.manage(CatchEngine {
        started: Mutex::new(None),
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
    let dirs = folders
        .as_ref()
        .map(|watch| watch.watching.clone())
        .unwrap_or_default();
    // Recorded by `folders::start` as each directory was taken, not stamped once
    // here. A single moment is wrong in one direction or the other — see the
    // field's own docstring.
    let since = folders
        .as_ref()
        .map(|watch| watch.started.clone())
        .unwrap_or_default();

    let clipboard = clipboard::start(app, std::sync::Arc::clone(&sink));

    // The copy-out fallback needs to reach the sink to flag its own clipboard
    // writes, so the shelf doesn't catch what the shelf just copied.
    app.manage(sink);

    // Filled in, not managed: `reserve` put this in place before the window
    // was shown, precisely so the commands below never see it missing.
    if let Some(engine) = app.try_state::<CatchEngine>() {
        // One write, so no caller can see two of these three and not the third.
        *lock(&engine.started) = Some(Started {
            dirs,
            since,
            clipboard,
        });
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
    let started = engine.started().ok_or_else(|| STARTING.to_owned())?;
    let dirs = started.dirs;
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

    // Empty exactly when the folder watcher failed outright, because this and
    // `dirs` are now written together and read from one clone.
    //
    // In that case every file in the window is handed over — `took_over` finds
    // no watcher and `is_none_or` yields `true`, which is the right answer for a
    // folder nothing is watching, because backfill is then the only way in. An
    // earlier comment here claimed the opposite ("admits nothing"), and a third
    // above it described a `now` fallback that no longer exists.
    let chosen = to_backfill(found, SystemTime::now(), since, &started.since, settled);

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

/// Whether a capture found on disk has stopped being written to.
///
/// The production answer to [`to_backfill`]'s `finished` parameter, and a named
/// function rather than a closure written inline at the call. It was a closure:
/// `to_backfill` takes the predicate as a parameter *precisely* so a test can
/// substitute one, and the value production actually passes then sat inside the
/// body of a `#[tauri::command]`, which no test in this crate can execute. So
/// the tests asserted that `to_backfill` applies a predicate correctly and
/// nothing at all about which predicate it applies — and the test that reads
/// closest to this one writes its own copy, without the `is_readable` half.
/// Flipping `>=` to `<=` here left clippy and all 155 tests green, and shelves
/// exactly the files that may still be growing.
///
/// Both signals, not either. The budget is the portable one; the lock is a
/// stronger answer where the OS offers it.
fn settled(path: &Path, kind: CaptureKind, modified: SystemTime) -> bool {
    SystemTime::now()
        .duration_since(modified)
        .is_ok_and(|age| age >= folders::settle_budget(kind))
        && folders::is_readable(path)
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
    watching_since: &[(PathBuf, SystemTime)],
    finished: impl Fn(&Path, CaptureKind, SystemTime) -> bool,
) -> Vec<Capture> {
    let cutoff = now - BACKFILL_WINDOW;

    /// When the watcher covering this file started listening.
    ///
    /// `None` when no watched directory holds it, which means nothing will ever
    /// emit it live — so backfill is its only way in and the boundary does not
    /// apply.
    fn took_over(file: &Path, watching_since: &[(PathBuf, SystemTime)]) -> Option<SystemTime> {
        watching_since
            .iter()
            .find(|(dir, _)| file.parent() == Some(dir.as_path()))
            .map(|(_, started)| *started)
    }

    found.retain(|(modified, path, kind)| {
        // Newer than the newest capture the shelf has already seen.
        //
        // Without this, backfill undoes `Remove`. Taking a capture off the
        // shelf is deliberately shelf-only — the file stays on disk, which is
        // the app's central promise — so every removed capture from the last
        // 24 hours came straight back on the next launch, along with anything
        // retention had already expired. A user who curates their shelf and
        // then reboots got all twenty back. `Remove` and a naive backfill
        // cancel each other out exactly.
        // Against *this file's own* folder, not one moment for the engine.
        //
        // A file is backfill's exactly when its last write landed before the
        // watcher for its directory started. Earlier than that, no live event
        // can ever have been produced for it; later, one was, and taking it
        // here as well is how one capture became two cards.
        let watchers_yet =
            took_over(path, watching_since).is_none_or(|started| *modified < started);

        // And a file that may still be growing is the watcher's, whatever the
        // boundary says.
        //
        // Two wrong answers were tried here. A flat five-second clock ANDed with
        // the boundary lost captures outright: `watchers_yet` already means "no
        // live event can ever come for this", so anything the clock then refused
        // was refused by both paths and gone for good. `is_readable` lost
        // nothing but is a Windows signal — an exclusive lock is not a thing on
        // macOS or Linux, where `File::open` succeeds on a file its writer still
        // holds — so on two platforms it answered "finished" for every in-flight
        // recording while being written as the general rule.
        //
        // The honest question is "could the watcher still be about to emit
        // this?", and it has a portable answer derived from the settle loop's
        // own budgets. A file younger than its kind's budget may still be
        // growing — and if it is, its remaining writes all land after the
        // watcher registered, so the watcher emits it properly. Leaving it
        // therefore loses nothing, where shelving it hands over a truncated
        // container. An image's budget is 750 ms; a recording's is 3.2 s.
        let done = finished(path, *kind, *modified);

        as_ms(*modified) > since_ms && *modified >= cutoff && watchers_yet && done
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
fn allow_reading_captures<R: Runtime>(app: &AppHandle<R>, dirs: &[PathBuf]) {
    let scope = app.asset_protocol_scope();

    let clipboard = clipboard::capture_dir(app);
    for dir in dirs.iter().chain(clipboard.iter()) {
        // The watch list and the clipboard folder: whole folders whose contents
        // are captures by definition, which is the one shape this grant fits.
        #[allow(clippy::disallowed_methods)]
        if let Err(err) = scope.allow_directory(dir, false) {
            // Watch folders may be logged — `diag.rs` names them as one of the
            // two permitted kinds — but this list also carries the clipboard
            // capture directory, which is a capture's own folder and is not.
            // `diag.rs` names watch folders as loggable and a capture's own
            // folder as not; this list carries both, so it names neither.
            crate::diag::warn(&format!(
                "the shelf will not be able to show captures from one of its watch folders: {err}"
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
pub fn catch_watch_dirs<R: Runtime>(app: AppHandle<R>) -> Result<Watching, String> {
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

    // One read for both halves, so the clipboard flag cannot answer "not
    // running" on a launch where the folder half is still answering "starting".
    // It could: read separately, it was unwrapped with `unwrap_or(false)`, which
    // spells "we do not know yet" as "it is not working" — and the front end
    // reports that as `Win+Shift+S` and `⌘⌃⇧4` doing nothing at all.
    let started = engine.started().ok_or_else(|| STARTING.to_owned())?;

    Ok(Watching {
        // `dirs`, not the intended list: reporting what the engine *meant* to
        // watch turned every watcher failure into a green dot. See
        // `folders::start`.
        dirs: started
            .dirs
            .iter()
            .map(|dir| dir.display().to_string())
            .collect(),
        // Same rule as the folders: what is running, not what was attempted.
        clipboard: started.clipboard,
    })
}

/// What the status line is told: the folders, and whether the clipboard watcher
/// is running.
///
/// A struct rather than the bare list it used to be, because the front end was
/// filling in the second half from nothing — see `Started::clipboard`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Watching {
    pub dirs: Vec<String>,
    pub clipboard: bool,
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
/// every gate green — clippy, the whole suite — while in the
/// real app `main.ts`'s `transient` predicate would answer `false` on the first
/// reply, so both catch commands fail immediately and every launch reports
/// "Shotshelf could not reach its catch engine" on a healthy machine. That is
/// the exact failure this sentinel exists to prevent.
///
/// The fixture is the join, the way `secret-kinds.json` and
/// `settings-bounds.json` already are for their rules.
#[cfg(test)]
const STARTING_FIXTURE: &str = include_str!("../../../tests/fixtures/engine-starting.json");

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

    /// How long ago the watcher came up, in these tests.
    const WATCH_STARTED_SECS: u64 = 5;

    /// When the one watched directory in these fixtures started listening.
    ///
    /// The fixtures name files without a directory, so their parent is `""` and
    /// the watched directory is `PathBuf::new()` — which is what pairs them.
    fn watcher_started() -> Vec<(PathBuf, SystemTime)> {
        vec![(
            PathBuf::new(),
            SystemTime::UNIX_EPOCH + Duration::from_secs(NOW_SECS - WATCH_STARTED_SECS),
        )]
    }

    /// `to_backfill` with the watcher-start argument these tests all share.
    fn backfill(
        found: Vec<(SystemTime, PathBuf, CaptureKind)>,
        now: SystemTime,
        since_ms: u64,
    ) -> Vec<Capture> {
        // Everything in these fixtures is a finished file; the one test that
        // cares about a half-written one supplies its own predicate.
        to_backfill(found, now, since_ms, &watcher_started(), |_, _, _| true)
    }

    /// Written before the watcher was listening, and inside the window.
    ///
    /// One second clear of the boundary rather than exactly on it: a file whose
    /// last write lands *at* the registration moment is the watcher's, because
    /// the comparison is strict in that direction on purpose — leaving it to
    /// backfill as well is how one capture would be shelved twice.
    fn ordinary(secs_ago: u64, name: &str) -> (SystemTime, PathBuf, CaptureKind) {
        seen(secs_ago + WATCH_STARTED_SECS + 1, name)
    }

    fn names(chosen: &[Capture]) -> Vec<&str> {
        chosen.iter().map(|c| c.path.as_str()).collect()
    }

    #[test]
    fn the_kinds_on_the_wire_are_the_ones_the_front_end_knows() {
        // One `#[serde(rename_all = …)]` was the whole agreement between this
        // enum and `src/shelf/types.ts`, and nothing joined them. Changing the
        // attribute to `"UPPERCASE"` compiled, passed clippy and passed all 135
        // tests in this crate — while in the real app the kind crosses in both
        // directions, so it broke everything at once: outbound, every
        // `capture://new` carried a `kind` the TypeScript union does not admit,
        // so `isImage` was false for images (no editor, no compare, no preview)
        // and recordings rendered as broken stills and got credential-scanned;
        // inbound, `copy_capture` and `prepare_drag` take a `CaptureKind` *from*
        // the webview, so serde refused `"image"` and every drag-out and every
        // copy failed.
        //
        // No browser spec could see it either — the e2e harness replaces
        // `__TAURI_INTERNALS__` wholesale, so nothing there runs a real command.
        //
        // Exhaustive by the compiler, the way `secret-kinds.json` is: adding a
        // variant stops this compiling until it is named, and naming it fails
        // until the fixture and the TypeScript union agree.
        let expected: Vec<String> =
            serde_json::from_str(include_str!("../../../tests/fixtures/capture-kinds.json"))
                .expect("the shared kinds fixture parses");

        let all = [CaptureKind::Image, CaptureKind::Video];
        let mut on_the_wire = Vec::new();
        for kind in all {
            // No wildcard arm — that is the whole mechanism.
            let spelling = match kind {
                CaptureKind::Image => "image",
                CaptureKind::Video => "video",
            };

            // Asserted through serde rather than against the literal above,
            // which would only compare this test to itself.
            let serialised = serde_json::to_value(kind).expect("a capture kind serialises");
            assert_eq!(
                serialised,
                serde_json::Value::String(spelling.to_owned()),
                "{kind:?} does not serialise as the front end reads it"
            );
            on_the_wire.push(spelling.to_owned());
        }

        assert_eq!(
            on_the_wire, expected,
            "the wire spellings have drifted from tests/fixtures/capture-kinds.json"
        );
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
        let chosen = backfill(
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
        let chosen = backfill(vec![taken.clone()], now(), 0);

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
        let chosen = backfill(
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
        let chosen = backfill(
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
        let stale = backfill(
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

        let capped = backfill(flood, now(), 0);
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
    fn a_recording_still_being_written_at_launch_is_left_to_the_watcher() {
        // The boundary answers "could a live event have been produced for
        // this?"; it does not answer "is anyone still writing it?".
        //
        // At a real launch the watcher started a fraction of a second ago, and a
        // recording that was already running has its last flush *before* that —
        // `VIDEO_STABLE_TICKS` is sized for an ffmpeg stall of about 2.8
        // seconds with the file untouched. So the boundary alone handed the
        // shelf a partially written container: a card whose length and size
        // cannot be read, whose drag-out is a truncated clip, and which the
        // watcher then shelved again under a different `ts` when it finished.
        //
        // The second question is asked of the *file*, not of a clock. A clock
        // was tried — "written more than five seconds ago" — and it dropped
        // every capture written in the band before its watcher registered,
        // which is the permanent loss the boundary exists to prevent. The
        // watcher's own signal is the right one: a writer still holding the
        // file open has not finished with it.
        let watching = vec![(
            PathBuf::new(),
            SystemTime::UNIX_EPOCH + Duration::from_millis(NOW_SECS * 1000 - 200),
        )];
        // The real predicate, not a stand-in: a file younger than its kind's
        // settle budget may still be growing.
        let settled = |_: &Path, kind: CaptureKind, modified: SystemTime| {
            now()
                .duration_since(modified)
                .is_ok_and(|age| age >= folders::settle_budget(kind))
        };

        // Two seconds ago: before the watcher started, so the boundary admits
        // it, and the writer still has it open.
        // Two seconds old: inside a recording's 3.2 s budget, so it may still
        // be growing — and if it is, the watcher will emit it when it stops.
        let running = (
            SystemTime::UNIX_EPOCH + Duration::from_secs(NOW_SECS - 2),
            PathBuf::from("recording-in-progress.mp4"),
            CaptureKind::Video,
        );
        assert!(
            to_backfill(vec![running], now(), 0, &watching, settled).is_empty(),
            "a partially written recording was handed to the shelf"
        );

        // The same age, finished. This is the case the clock lost.
        // The same age, but an image — well past its 750 ms budget. This is
        // the case the flat five-second clock lost.
        let done = seen(2, "taken-two-seconds-ago.png");
        assert_eq!(
            names(&to_backfill(vec![done], now(), 0, &watching, settled)),
            vec!["taken-two-seconds-ago.png"],
            "a capture no watcher could ever emit was dropped by backfill too"
        );
    }

    #[test]
    fn each_folder_hands_over_at_its_own_watchers_start() {
        // Why the boundary is per directory rather than one moment.
        //
        // `folders::start` registers watchers one at a time, and either single
        // stamp is wrong in one direction. Taken before the first: a file
        // written while the rest were still registering is skipped by backfill
        // *and* invisible to a watcher that was not yet listening — the capture
        // is lost, permanently, because the watermark moves past it. Taken
        // after the last: a file written in that same interval is emitted live
        // by an already-live watcher *and* offered by backfill, and one capture
        // becomes two cards.
        //
        // Two folders, registered a second apart, and a file in each written
        // between the two registrations. Both properties are asserted at once:
        // the early folder's file is the watcher's, the late folder's is not.
        let early = PathBuf::from("/early");
        let late = PathBuf::from("/late");
        // Both starts well past every settle budget, so this measures the
        // hand-over boundary rather than the liveness one.
        let started = vec![
            (
                early.clone(),
                SystemTime::UNIX_EPOCH + Duration::from_secs(NOW_SECS - 9),
            ),
            (
                late.clone(),
                SystemTime::UNIX_EPOCH + Duration::from_secs(NOW_SECS - 7),
            ),
        ];

        // Written eight seconds ago: after `early`'s watcher, before `late`'s.
        let between = SystemTime::UNIX_EPOCH + Duration::from_secs(NOW_SECS - 8);
        let found = vec![
            (between, early.join("seen-live.png"), CaptureKind::Image),
            (between, late.join("nobody-saw-it.png"), CaptureKind::Image),
        ];

        let chosen = to_backfill(found, now(), 0, &started, |_, _, _| true);
        assert_eq!(
            names(&chosen),
            vec!["/late\nobody-saw-it.png"]
                .into_iter()
                .map(|_| late.join("nobody-saw-it.png").display().to_string())
                .collect::<Vec<_>>(),
            "one moment for the whole engine is wrong for one of these two files"
        );
    }

    #[test]
    fn a_capture_written_just_before_the_watcher_started_is_still_brought_back() {
        // The gap this boundary exists to close.
        //
        // `notify` reports events, not history, so a file whose writes finished
        // before registration produces none — ever. The rule used to be "skip
        // anything modified in the last five seconds, the watcher has it", and
        // for the seconds either side of start-up that was simply false: too
        // recent for backfill, invisible to a watcher that was not yet
        // listening. Permanently, too, because `CaptureSink::emit` moves the
        // watermark by wall-clock emit time while this filter reads mtimes, so
        // the first live capture pushed the watermark past it for good.
        //
        // Its own watcher start, deliberately: a launch that has just finished
        // starting up is the only arrangement where the gap opens, and the
        // shared helper puts the watcher five seconds back, which is far enough
        // that the old five-second grace happened to admit the file anyway.
        //
        // Six seconds ago, then, and a screenshot taken seven seconds ago —
        // while Shotshelf was still coming up. Under the old rule that file was
        // inside the grace and skipped as "the watcher has it"; the watcher had
        // not started yet, so nothing had it.
        //
        // The numbers are comfortably apart because this test is about the
        // *boundary*. The band immediately before a watcher's start — where a
        // later round's five-second clock lost captures outright — is covered
        // by `a_recording_still_being_written_at_launch_is_left_to_the_watcher`,
        // which asserts a two-second-old file comes back.
        let started_just_now = vec![(
            PathBuf::new(),
            SystemTime::UNIX_EPOCH + Duration::from_secs(NOW_SECS - 6),
        )];
        // Older than the watcher's start, so nothing live can ever have seen it.
        let during_launch = seen(7, "taken-during-launch.png");
        let chosen = to_backfill(
            vec![during_launch],
            now(),
            0,
            &started_just_now,
            |_, _, _| true,
        );
        assert_eq!(
            names(&chosen),
            vec!["taken-during-launch.png"],
            "a capture the watcher could not have seen has to come from backfill"
        );

        // And the other side of the boundary still belongs to the watcher, so
        // the two paths cannot both shelve one capture: written after
        // registration, and still growing.
        let after = seen(0, "still-being-written.mp4");
        assert!(
            to_backfill(vec![after], now(), 0, &started_just_now, |_, _, _| true).is_empty(),
            "a file written after the watcher came up is the watcher's to emit"
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
        let chosen = backfill(
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
        let next_launch = backfill(
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

        // No further assertion here, and that is deliberate.
        //
        // Two have been tried and both were tautologies. `newest ==
        // chosen.iter().map(|c| c.ts).max()` is `newest_of` compared to itself.
        // `newest >= chosen.last().ts` reads as though it guards against taking
        // the tail — but the list is handed over oldest-first, so the last
        // element *is* the maximum, and it reduces to `max >= max`. Its comment
        // named the wrong element as the danger too.
        //
        // The real mistake is `first()`, which parks the watermark on the
        // oldest capture in the batch so everything newer comes again on every
        // launch, for ever — and the re-run above catches exactly that: with
        // `first()`, feeding the watermark back returns the rest of the batch
        // instead of nothing. Verified by mutation, both ways.

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
        let chosen = backfill(vec![ordinary(60, "yesterday.png")], now(), 0);
        assert!(chosen[0].context.is_empty());
    }

    #[test]
    fn a_scan_admits_only_what_the_watcher_would_admit() {
        // Against `scan` itself, not against `is_partial` in isolation.
        //
        // Deleting both guards from `scan` left the whole suite green: the rule
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

    /// A screen-sized capture, and something plainly different.
    const FULL_SCREEN: (u32, u32) = (2560, 1440);
    const A_REGION: (u32, u32) = (612, 337);

    #[test]
    fn one_screenshot_silences_exactly_one_clipboard_echo() {
        let sink = CaptureSink::default();
        *lock(&sink.folder_echo) = Some((Instant::now(), FULL_SCREEN));

        assert!(
            sink.take_folder_echo(Duration::from_secs(4), FULL_SCREEN),
            "the clipboard copy of a Win+PrtSc is an echo"
        );
        // Win+PrtSc followed straight away by a real Win+Shift+S must still be
        // caught, so the marker is consumed rather than left standing.
        assert!(!sink.take_folder_echo(Duration::from_secs(4), FULL_SCREEN));
    }

    #[test]
    fn a_folder_image_arms_the_marker_with_its_own_shape() {
        // The producer, which had no test because `emit` needs an `AppHandle`
        // no test here can build. Deleting the arming left all 153 tests green
        // while every Win+PrtSc shelved twice and left an unpruned PNG behind.
        let dir = std::env::temp_dir().join("shotshelf-echo-arm-test");
        std::fs::create_dir_all(&dir).expect("a temp dir");
        let shot = dir.join("screenshot.png");

        // A real 3x2 PNG, so the header carries a shape to read.
        let image = image::RgbaImage::new(3, 2);
        image.save(&shot).expect("a png");

        let sink = CaptureSink::default();
        sink.note_folder_image(&shot, CaptureKind::Image, Source::Folder);

        assert!(
            !sink.take_folder_echo(Duration::from_secs(4), (9, 9)),
            "the marker matched a shape the file does not have"
        );
        assert!(
            sink.take_folder_echo(Duration::from_secs(4), (3, 2)),
            "the marker did not carry the image's own shape"
        );

        // A file that cannot be read arms nothing, which keeps the clipboard
        // capture rather than swallowing it.
        let sink = CaptureSink::default();
        sink.note_folder_image(
            &dir.join("not-there.png"),
            CaptureKind::Image,
            Source::Folder,
        );
        assert!(!sink.take_folder_echo(Duration::from_secs(4), (3, 2)));

        // And the *condition*, which used to live in `emit` beside an
        // `AppHandle` no test can build. Swapping `Folder` for `Clipboard`
        // there stopped every folder image arming the marker — every Win+PrtSc
        // shelving twice again — with clippy and all 155 tests green.
        for (kind, source) in [
            (CaptureKind::Image, Source::Clipboard),
            (CaptureKind::Video, Source::Folder),
            (CaptureKind::Video, Source::Clipboard),
        ] {
            let sink = CaptureSink::default();
            sink.note_folder_image(&shot, kind, source);
            assert!(
                !sink.take_folder_echo(Duration::from_secs(4), (3, 2)),
                "{kind:?} from {source:?} is not a folder image and must arm nothing"
            );
        }

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_capture_still_being_written_is_not_settled() {
        // The production answer to `to_backfill`'s `finished` parameter, which
        // was an inline closure inside a `#[tauri::command]` — so the tests
        // asserted that `to_backfill` applies a predicate correctly and nothing
        // about which predicate it applies. Flipping `>=` to `<=` in it left
        // clippy and all 155 tests green, and shelves exactly the files that
        // may still be growing.
        //
        // Real files and the real clock, because that is what the production
        // predicate reads. The synthetic-predicate tests above cover the
        // *policy*; this covers the answer.
        let dir = std::env::temp_dir().join("shotshelf-settled-test");
        std::fs::create_dir_all(&dir).expect("a temp dir");
        let shot = dir.join("fresh.png");
        std::fs::write(&shot, [0_u8; 8]).expect("a file");

        let just_now = SystemTime::now();
        assert!(
            !settled(&shot, CaptureKind::Image, just_now),
            "a capture written this instant is inside its settle budget"
        );
        assert!(
            !settled(&shot, CaptureKind::Video, just_now),
            "a recording written this instant is inside its settle budget"
        );

        // Past the budget for an image but not for a recording, which gets the
        // longer one because ffmpeg stalls mid-encode.
        let between =
            SystemTime::now() - folders::settle_budget(CaptureKind::Video) + Duration::from_secs(1);
        assert!(settled(&shot, CaptureKind::Image, between));
        assert!(
            !settled(&shot, CaptureKind::Video, between),
            "a recording was called finished inside the video budget"
        );

        let long_ago = SystemTime::now() - Duration::from_secs(3_600);
        assert!(settled(&shot, CaptureKind::Image, long_ago));
        assert!(settled(&shot, CaptureKind::Video, long_ago));

        // Both signals, not either: a file old enough but not openable is not
        // handed over.
        assert!(
            !settled(&dir.join("not-there.png"), CaptureKind::Image, long_ago),
            "a capture that cannot be opened was called finished"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_clipboard_capture_of_a_different_shape_is_not_an_echo() {
        // "An image landed in a folder recently" was the whole test, and it is
        // not evidence that the clipboard holds a copy of it. Win+PrtSc is the
        // only thing that writes both; a Game Bar clip, a save-only ShareX
        // profile or a sync client dropping a screenshot in armed the same
        // silencer, and the next Win+Shift+S inside four seconds was destroyed
        // — silently, and it is the one capture with no other copy.
        let sink = CaptureSink::default();
        *lock(&sink.folder_echo) = Some((Instant::now(), FULL_SCREEN));

        assert!(
            !sink.take_folder_echo(Duration::from_secs(4), A_REGION),
            "a region grab was swallowed by an unrelated full-screen file"
        );
        // And the marker is still standing for the capture it really belongs to.
        assert!(sink.take_folder_echo(Duration::from_secs(4), FULL_SCREEN));
    }

    #[test]
    fn a_stale_echo_marker_does_not_swallow_a_later_capture() {
        let sink = CaptureSink::default();
        *lock(&sink.folder_echo) = Some((Instant::now() - Duration::from_secs(30), FULL_SCREEN));

        assert!(!sink.take_folder_echo(Duration::from_secs(4), FULL_SCREEN));
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
