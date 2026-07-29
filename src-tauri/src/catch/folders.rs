//! Folder watching via `notify` + notify-rs' own debouncer.
//!
//! Two problems sit between "the OS wrote a file" and "this is a capture":
//! filesystem events arrive in bursts, and a screen recording exists on disk
//! long before it is finished. The debouncer solves the first; the settle loop
//! below solves the second by holding a candidate until its size stops moving.

use std::{
    collections::{hash_map::Entry, HashMap},
    path::{Path, PathBuf},
    sync::{
        mpsc::{self, RecvTimeoutError},
        Arc,
    },
    time::{Duration, Instant, SystemTime},
};

use notify::{
    event::{EventKind, ModifyKind},
    RecommendedWatcher, RecursiveMode,
};
use notify_debouncer_full::{new_debouncer, DebounceEventResult, Debouncer, RecommendedCache};
use tauri::{AppHandle, Runtime};

use super::{kind_of, CaptureKind, CaptureSink, Source};

/// Coalescing window for raw filesystem events.
const DEBOUNCE: Duration = Duration::from_millis(400);
/// How often a not-yet-settled candidate is re-checked.
const SETTLE_TICK: Duration = Duration::from_millis(350);
/// Screenshots are written in one go, so one unchanged size is enough.
const IMAGE_STABLE_TICKS: u32 = 1;

/// The longest this watcher can take to report a screenshot it has seen.
///
/// Derived, because someone else needs it and a second hand-written copy is a
/// number that goes stale in silence. `clipboard.rs` holds every clipboard
/// image back for a multiple of this so a Win+PrtSc — which saves a PNG *and*
/// copies it — is shelved once rather than twice; its constant used to be a
/// hand-chosen 1500 ms with a comment saying "debounce + settle is roughly
/// 750 ms", computed by hand from three constants private to this module.
///
/// Raising `SETTLE_TICK`, or `IMAGE_STABLE_TICKS` from one to two — the same
/// edit `VIDEO_STABLE_TICKS` below already documents wanting — would have left
/// this watcher finishing *after* the clipboard grace expired, and every
/// Win+PrtSc would have shelved two copies plus an unpruned PNG. Nothing joined
/// them and no test could see it. Now the edit moves both.
// `as_millis` is a `u128` and this is const arithmetic over three constants
// declared a few lines up, none of them a second long. `u64::try_from` is not
// usable in a const initialiser, so the conversion is stated here instead.
#[allow(clippy::cast_possible_truncation)]
pub(super) const SLOWEST_IMAGE: Duration = Duration::from_millis(
    DEBOUNCE.as_millis() as u64 + SETTLE_TICK.as_millis() as u64 * IMAGE_STABLE_TICKS as u64,
);
/// Recordings grow while they record; require a real pause before believing it.
///
/// This has to outlast an encoder *stalling*, not just writing slowly. ffmpeg
/// lays down a 48-byte header, spends a second or more encoding with the file
/// untouched, then flushes everything at once — and a shorter window read that
/// pause as "finished", shelving a recording that was still 48 bytes long. A
/// capture caught mid-write drags out truncated, so this errs slow: ~2.8s of
/// genuine silence before a recording counts as done.
const VIDEO_STABLE_TICKS: u32 = 8;
/// How long a vanished file is kept around before being forgotten.
const GONE_GRACE: Duration = Duration::from_secs(5);
/// A file that is still empty this long after its first event is not a capture
/// being written — it is a placeholder, and keeping it would tick forever.
const EMPTY_TIMEOUT: Duration = Duration::from_secs(15);
/// Backstop for a file that never settles (an abandoned recording, say).
const SETTLE_TIMEOUT: Duration = Duration::from_secs(60 * 60);

/// Dropping this stops the watcher and its settle thread.
pub struct FolderWatch {
    /// The directories the watcher really took, which is what the status line
    /// must report — see `start`.
    pub watching: Vec<PathBuf>,
    /// When each of those directories went live, paired with it.
    ///
    /// Per directory rather than one moment for the whole engine, because the
    /// watchers register one at a time and either single stamp is wrong: taken
    /// before the first, a file written while the rest were still registering
    /// is skipped by backfill *and* invisible to a watcher that was not yet
    /// listening; taken after the last, a file written in that same interval is
    /// emitted by an already-live watcher *and* offered by backfill, and the
    /// user gets two cards for one capture.
    ///
    /// Per directory there is no interval to be wrong about: a file belongs to
    /// backfill exactly when it was last written before its own folder's
    /// watcher started. That is decidable, and it is why this is a list of
    /// pairs rather than the single `SystemTime` it used to be.
    pub started: Vec<(PathBuf, SystemTime)>,
    _debouncer: Debouncer<RecommendedWatcher, RecommendedCache>,
}

pub fn start<R: Runtime>(
    app: &AppHandle<R>,
    dirs: &[PathBuf],
    sink: Arc<CaptureSink>,
) -> Result<FolderWatch, notify::Error> {
    let (tx, rx) = mpsc::channel::<Candidate>();

    let mut debouncer = new_debouncer(DEBOUNCE, None, move |result| queue(result, &tx))?;

    // Which directories are genuinely being watched, not which were asked for.
    //
    // A per-directory failure was logged and the directory left in the list —
    // and the status line reads that list, so an exhausted inotify limit, a
    // macOS permission denial or a folder redirected to an offline share all
    // left the dot green and the tooltip claiming "Watching 3 folders". The
    // usage guide tells the user to check that line when nothing appears, so
    // the one diagnostic offered for the app's central failure was the one
    // thing that could not report it.
    let mut watching = Vec::with_capacity(dirs.len());
    let mut started = Vec::with_capacity(dirs.len());
    for dir in dirs {
        // Non-recursive on purpose: capture folders are flat, and recursing a
        // whole Pictures tree would be a lot of churn for nothing.
        match debouncer.watch(dir, RecursiveMode::NonRecursive) {
            Ok(()) => {
                // Stamped as each one is taken, not once for the loop.
                started.push((dir.clone(), SystemTime::now()));
                watching.push(dir.clone());
            }
            Err(err) => crate::diag::warn(&format!("cannot watch {}: {err}", dir.display())),
        }
    }

    spawn_settler(app.clone(), rx, sink);

    Ok(FolderWatch {
        watching,
        started,
        _debouncer: debouncer,
    })
}

/// Hand every plausible capture to the settle loop. This runs on the
/// debouncer's own thread, so it does no I/O beyond the filename checks.
fn queue(result: DebounceEventResult, tx: &mpsc::Sender<Candidate>) {
    let events = match result {
        Ok(events) => events,
        Err(errors) => {
            for err in errors {
                crate::diag::warn(&format!("watch error: {err}"));
            }
            return;
        }
    };

    for event in events {
        if !is_write(&event.kind) {
            continue;
        }
        for path in &event.paths {
            if let Some(candidate) = Candidate::new(path) {
                let _ = tx.send(candidate);
            }
        }
    }
}

/// Creations and content/rename changes only. Metadata-only touches are skipped
/// so opening an old screenshot never looks like a new one.
fn is_write(kind: &EventKind) -> bool {
    matches!(
        kind,
        EventKind::Create(_)
            | EventKind::Modify(ModifyKind::Any)
            | EventKind::Modify(ModifyKind::Data(_))
            | EventKind::Modify(ModifyKind::Name(_))
    )
}

/// Half-written or sidecar files the writer will clean up itself.
///
/// `pub(super)` so `catch::scan` applies the same rule. It did not, and
/// `._Screenshot.png` — a macOS AppleDouble stub, present beside every real
/// file on any exFAT or SMB volume — keeps the `.png` extension and passes
/// `kind_of`. A first launch on macOS would have filled the shelf with 4 KB
/// resource forks rendered as broken images.
pub(super) fn is_partial(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return true;
    };
    let lower = name.to_ascii_lowercase();

    name.starts_with('~')
        || name.starts_with('.') // includes macOS `._` AppleDouble files
        || name.ends_with('~')
        || lower.ends_with(".tmp")
        || lower.ends_with(".temp")
        || lower.ends_with(".part")
        || lower.ends_with(".partial")
        || lower.ends_with(".crdownload")
        || lower.ends_with(".download")
}

struct Candidate {
    path: PathBuf,
    kind: CaptureKind,
}

impl Candidate {
    fn new(path: &Path) -> Option<Self> {
        if is_partial(path) {
            return None;
        }
        Some(Self {
            path: path.to_path_buf(),
            kind: kind_of(path)?,
        })
    }
}

struct Pending {
    kind: CaptureKind,
    last_len: u64,
    stable_ticks: u32,
    first_seen: Instant,
}

enum Settled {
    /// Finished writing — emit it.
    Ready,
    /// Still moving; check again next tick.
    Waiting,
    /// Gone for good; forget it.
    Gone,
}

/// One thread owns every in-flight candidate, so a long recording can settle
/// without holding up the screenshot taken while it was running.
fn spawn_settler<R: Runtime>(
    app: AppHandle<R>,
    rx: mpsc::Receiver<Candidate>,
    sink: Arc<CaptureSink>,
) {
    std::thread::spawn(move || {
        let mut pending: HashMap<PathBuf, Pending> = HashMap::new();

        loop {
            // Idle at zero cost when nothing is in flight; tick only while
            // something is waiting to settle.
            let next = if pending.is_empty() {
                match rx.recv() {
                    Ok(candidate) => Some(candidate),
                    Err(_) => return, // app is shutting down
                }
            } else {
                match rx.recv_timeout(SETTLE_TICK) {
                    Ok(candidate) => Some(candidate),
                    Err(RecvTimeoutError::Timeout) => None,
                    Err(RecvTimeoutError::Disconnected) => return,
                }
            };

            if let Some(candidate) = next {
                remember(&mut pending, candidate);
            }
            while let Ok(candidate) = rx.try_recv() {
                remember(&mut pending, candidate);
            }

            pending.retain(|path, state| match settle(path, state) {
                Settled::Ready => {
                    sink.emit(&app, path, state.kind, Source::Folder);
                    false
                }
                Settled::Waiting => state.first_seen.elapsed() < SETTLE_TIMEOUT,
                Settled::Gone => false,
            });
        }
    });
}

fn remember(pending: &mut HashMap<PathBuf, Pending>, candidate: Candidate) {
    let len = len_of(&candidate.path);

    match pending.entry(candidate.path) {
        Entry::Occupied(mut entry) => {
            let state = entry.get_mut();
            // Another event and a different size means it is still growing.
            if state.last_len != len {
                state.last_len = len;
                state.stable_ticks = 0;
            }
        }
        Entry::Vacant(entry) => {
            entry.insert(Pending {
                kind: candidate.kind,
                last_len: len,
                stable_ticks: 0,
                first_seen: Instant::now(),
            });
        }
    }
}

fn settle(path: &Path, state: &mut Pending) -> Settled {
    let Ok(meta) = std::fs::metadata(path) else {
        // Renamed or deleted right after we queued it.
        return if state.first_seen.elapsed() < GONE_GRACE {
            Settled::Waiting
        } else {
            Settled::Gone
        };
    };

    if !meta.is_file() {
        return Settled::Gone;
    }

    let len = meta.len();
    if len == 0 {
        // The writer has created the file but not filled it yet — unless it
        // never will, in which case stop watching it.
        state.last_len = 0;
        state.stable_ticks = 0;
        return if state.first_seen.elapsed() < EMPTY_TIMEOUT {
            Settled::Waiting
        } else {
            Settled::Gone
        };
    }

    if len == state.last_len && is_readable(path) {
        state.stable_ticks += 1;
    } else {
        state.last_len = len;
        state.stable_ticks = 0;
    }

    let needed = match state.kind {
        CaptureKind::Image => IMAGE_STABLE_TICKS,
        CaptureKind::Video => VIDEO_STABLE_TICKS,
    };

    if state.stable_ticks >= needed {
        Settled::Ready
    } else {
        Settled::Waiting
    }
}

fn len_of(path: &Path) -> u64 {
    std::fs::metadata(path).map(|meta| meta.len()).unwrap_or(0)
}

/// Windows keeps an exclusive lock on a file that is still being written, so
/// being able to open it is a second, cheap "the writer is done" signal.
fn is_readable(path: &Path) -> bool {
    std::fs::File::open(path).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A file on disk with `bytes` in it, and a `Pending` that has never seen it.
    fn waiting_on(name: &str, bytes: usize, kind: CaptureKind) -> (PathBuf, Pending) {
        let dir = std::env::temp_dir().join("shotshelf-settle-test");
        std::fs::create_dir_all(&dir).expect("a temp dir");
        let path = dir.join(name);
        std::fs::write(&path, vec![0u8; bytes]).expect("a file to settle");
        (
            path,
            Pending {
                kind,
                last_len: 0,
                stable_ticks: 0,
                first_seen: Instant::now(),
            },
        )
    }

    #[test]
    fn a_screenshot_settles_in_one_quiet_tick_and_a_recording_does_not() {
        // `settle` had no test at all, so swapping the two arms of its
        // `match state.kind` — a one-line edit — left all 135 tests and clippy
        // green. Swapped, a recording is emitted after a single 350 ms tick,
        // which is the truncated-drag failure `VIDEO_STABLE_TICKS` exists to
        // prevent; and a screenshot takes 3.2 s, past `ECHO_GRACE`, so every
        // Win+PrtSc shelves twice and leaves a duplicate PNG behind.
        //
        // The first call only records the length — a file whose size is new is
        // never stable — so both kinds need one call to observe and then as
        // many quiet ticks as their budget asks for.
        let (shot, mut shot_state) = waiting_on("shot.png", 16, CaptureKind::Image);
        assert!(
            matches!(settle(&shot, &mut shot_state), Settled::Waiting),
            "the first sight of a file only measures it"
        );
        for _ in 0..IMAGE_STABLE_TICKS {
            assert!(matches!(settle(&shot, &mut shot_state), Settled::Ready));
        }

        let (clip, mut clip_state) = waiting_on("clip.mp4", 48, CaptureKind::Video);
        assert!(matches!(settle(&clip, &mut clip_state), Settled::Waiting));
        // One tick short of the budget, a recording is still not believed —
        // this is the ffmpeg stall the constant is sized for.
        for tick in 1..VIDEO_STABLE_TICKS {
            assert!(
                matches!(settle(&clip, &mut clip_state), Settled::Waiting),
                "a recording quiet for only {tick} tick(s) is not finished"
            );
        }
        assert!(matches!(settle(&clip, &mut clip_state), Settled::Ready));

        // And a file that grows resets the count rather than accumulating it.
        let (growing, mut growing_state) = waiting_on("growing.png", 16, CaptureKind::Image);
        assert!(matches!(
            settle(&growing, &mut growing_state),
            Settled::Waiting
        ));
        std::fs::write(&growing, vec![0u8; 32]).expect("it grows");
        assert!(
            matches!(settle(&growing, &mut growing_state), Settled::Waiting),
            "a file that changed size starts its count again"
        );

        for path in [shot, clip, growing] {
            let _ = std::fs::remove_file(path);
        }
    }

    #[test]
    fn the_slowest_image_budget_is_the_one_settle_actually_applies() {
        // `SLOWEST_IMAGE` is derived from `IMAGE_STABLE_TICKS` so that
        // `clipboard.rs`'s `ECHO_GRACE` moves whenever this does — its docstring
        // says "now the edit moves both". Nothing checked that `settle` still
        // *uses* the constant the derivation was computed from, which is the
        // half that makes the derivation mean anything.
        let (shot, mut state) = waiting_on("budget.png", 16, CaptureKind::Image);

        let mut ticks = 0u32;
        // The first call measures; count only the quiet ticks after it.
        assert!(matches!(settle(&shot, &mut state), Settled::Waiting));
        while !matches!(settle(&shot, &mut state), Settled::Ready) {
            ticks += 1;
            assert!(ticks < 100, "a still file must settle");
        }
        ticks += 1;

        assert_eq!(
            SLOWEST_IMAGE,
            DEBOUNCE + SETTLE_TICK * ticks,
            "SLOWEST_IMAGE no longer describes how long settle really takes"
        );

        let _ = std::fs::remove_file(shot);
    }

    #[test]
    fn ignores_half_written_and_sidecar_files() {
        // Every one of these has actually turned up in a watched folder.
        for name in [
            "Screenshot.png.tmp",
            "clip.mp4.part",
            "shot.png.crdownload",
            "~$draft.png",
            "._resource-fork.png", // macOS AppleDouble
            "backup.png~",
        ] {
            assert!(is_partial(Path::new(name)), "{name} should be ignored");
        }
    }

    #[test]
    fn accepts_the_names_the_os_actually_writes() {
        for name in [
            "Screenshot 2026-07-27 152233.png",
            "Screenshot (2).png",
            "Screen Recording 2026-07-27 at 15.22.33.mov",
        ] {
            assert!(!is_partial(Path::new(name)), "{name} should be caught");
        }
    }

    #[test]
    fn a_metadata_touch_is_not_a_new_capture() {
        use notify::event::{DataChange, MetadataKind};

        assert!(is_write(&EventKind::Create(notify::event::CreateKind::Any)));
        assert!(is_write(&EventKind::Modify(ModifyKind::Data(
            DataChange::Any
        ))));
        // Opening an old screenshot must not put it back on the shelf.
        assert!(!is_write(&EventKind::Modify(ModifyKind::Metadata(
            MetadataKind::Any
        ))));
        assert!(!is_write(&EventKind::Remove(
            notify::event::RemoveKind::Any
        )));
    }
}
