//! How much of the slow work the app will do at once.
//!
//! Three process-wide ceilings, in one place. They were three verbatim copies
//! of the same `OnceLock`/`Arc`/`Semaphore` dance in two modules — two of them
//! nine lines apart — and a round that extracted a helper for them converted
//! two and left the third, under a docstring saying all three "existed" in the
//! past tense.
//!
//! Together rather than beside their callers, because the thing worth seeing is
//! the *set*: every one of these guards CPU-bound work on a machine the user is
//! using for something else, and the only question any of them answers is "how
//! many at once". Reading them apart is what let one of them be forgotten.
//!
//! Bounds are small on purpose. The shelf stays usable while any of this runs,
//! and every one of these is reachable once per tile — a shelf builds every
//! tile at once, and pinned captures are exempt from the item cap, so "one per
//! tile" is unbounded.

use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

use tokio::sync::Semaphore;

/// Take a lock, tolerating a thread that died holding it.
///
/// Poisoning means a previous holder panicked, not that the data is unusable.
/// Nothing behind any of these locks is an invariant a panic could half-update:
/// the worst case is a stale timestamp or a settings value re-read a moment
/// later. Propagating the poison would turn one dead watcher thread into a
/// permanently dead engine.
///
/// Here rather than in `catch/mod.rs`, which had it as a private `lock<T>`,
/// because `settings.rs` needed the same rule and wrote
/// `unwrap_or_else(|poisoned| poisoned.into_inner())` out three more times
/// beside it. One rule, four expressions of it, in a crate that had already
/// named the concept once.
pub fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// How many captures may be *sized* at once — the hand-off and clipboard paths.
///
/// Each decodes, Lanczos3-resizes and re-encodes a full-resolution screenshot,
/// and a multi-select drag asks once per capture concurrently.
pub const SIZING: usize = 2;

/// How many captures may be *read* at once — OCR and credential scanning.
///
/// The slowest thing the app does.
pub const SCANNING: usize = 2;

/// How many poster frames may be extracted at once.
///
/// Each is an ffmpeg process; the shelf asks once per video tile.
pub const FRAMES: usize = 2;

/// A process-wide limit, created on first use.
///
/// The `OnceLock` belongs to the caller so each limit is its own static; this
/// owns only the initialisation, which is the part that was written out three
/// times.
pub fn shared(cell: &'static OnceLock<Arc<Semaphore>>, permits: usize) -> &'static Arc<Semaphore> {
    cell.get_or_init(|| Arc::new(Semaphore::new(permits)))
}

// ── Running work under those limits ──────────────────────────────────────

// Here rather than in `share.rs`, which is where this grew.
//
// `share.rs`'s own header says it is about "getting a capture off the shelf and
// into another app". This is a general "how much slow work at once, and what
// happens when a job wedges" — its other consumer is `compare_captures`, an
// operation with no sharing in it at all, and `edit.rs` reached into the share
// module to get at it. That import was the tell.

/// How long a credential scan may take before its permit is given back.
///
/// Generous: OCR on a dense 4K screenshot is genuinely slow. It exists so a
/// recogniser that never returns costs one tile rather than the feature.
///
/// Beside the pool it guards, like the other two. `limits.rs`'s own argument —
/// that reading these apart is what let one of them be forgotten — applied to
/// the deadlines as much as the pools, and only one of the three was here.
pub(crate) const SCAN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// How long a poster frame may take.
pub(crate) const FRAME_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

/// How long Linux's `tesseract` child may run before it is killed.
///
/// A fourth deadline, and it was the one outside this file — under a header
/// claiming to hold the set, and after a round that moved the other three here
/// saying "reading them apart is what let one of them be forgotten".
///
/// It has to stay *under* [`SCAN_TIMEOUT`], and that is the whole reason it is
/// here rather than in `ocr.rs`. The child is killed by its own deadline; the
/// scan gives up at the other. If this outgrew that, every wedged capture would
/// leave a `tesseract` process and the blocking thread waiting on it running
/// past the point where anything is still interested in the answer — and the
/// shelf starts one of these per capture. Beside the constant it must stay
/// under, the inequality is visible; a file apart, it is nobody's.
///
/// Not a permit leak, which is what this said first. `under_limit` drops the
/// permit on every path including the timeout one, and
/// `a_job_that_never_finishes_gives_its_permit_back` asserts exactly that,
/// sixty lines below. The claim was written from the shape of an older bug this
/// same file had already fixed — the permit moved *into* the worker — and
/// nothing re-read the fix before restating the failure it removed.
///
/// Read for real only on Linux — the other two platforms use an OS recogniser
/// with no child process — but compiled everywhere so the test below can assert
/// the inequality on every platform rather than on one. Same shape as
/// `catch/paths.rs`'s `under_home` and `share.rs`'s `percent_encode_path`, and
/// scoped to exactly the platforms with no caller, so a genuinely dead constant
/// still fails the build on Linux.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) const OCR_CHILD_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

/// How long a single sizing job may take before its permit is given back.
///
/// Generous — a Lanczos3 resize of a 4K screenshot is real work, and a
/// comparison composites two of them. It exists so a decode that never returns
/// costs one drag rather than the feature.
const SIZING_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

/// Run sizing work on a blocking worker, under the concurrency limit and a
/// deadline, with the permit released whatever happens.
///
/// One function because there were three copies of it — `prepare_drag`,
/// `copy_capture` and `compare_captures` — and all three made the same mistake
/// in the same place: the permit was moved *into* the worker.
///
/// `describe_capture`, thirty lines above two of them, spends a paragraph on
/// why that is wrong, and the reasoning transfers exactly. A permit that lives
/// in the worker is released only when the worker finishes; two jobs that never
/// finish exhaust a semaphore of two, and every later drag and every later copy
/// blocks on `acquire_owned` forever. Held out here it is released the moment
/// this returns, so the cost of a wedge is a leaked thread rather than a
/// feature that never works again for the rest of the session.
///
/// The deadline is the other half, and the sizing path did not have it at all:
/// it awaited the `JoinHandle` bare, so a wedged decode hung its caller as well
/// as its permit.
pub(crate) async fn under_sizing_limit<T, W>(what: &str, work: W) -> Result<T, String>
where
    W: FnOnce() -> T + Send + 'static,
    T: Send + 'static,
{
    under_limit(sizing_limit().clone(), SIZING_TIMEOUT, what, work).await
}

/// The rule itself, with the pool and the deadline passed in.
///
/// Split out for one reason: "a wedged job gives its permit back" is the
/// property that was wrong at all three call sites, and stating it needs a job
/// that never finishes and a deadline measured in milliseconds rather than the
/// real minute.
pub(crate) async fn under_limit<T, W>(
    limit: std::sync::Arc<tokio::sync::Semaphore>,
    deadline: std::time::Duration,
    what: &str,
    work: W,
) -> Result<T, String>
where
    W: FnOnce() -> T + Send + 'static,
    T: Send + 'static,
{
    let permit = limit.acquire_owned().await.map_err(|err| err.to_string())?;

    let worker = tauri::async_runtime::spawn_blocking(work);
    let outcome = match tokio::time::timeout(deadline, worker).await {
        Ok(joined) => joined.map_err(|err| err.to_string()),
        Err(_) => Err(format!("preparing {what} took too long")),
    };

    // Before returning, on every path. `tokio::time::timeout` frees the *task*
    // and not the thread behind it, so this is the only thing that keeps a
    // wedged job from costing a permit permanently.
    drop(permit);
    outcome
}

fn sizing_limit() -> &'static std::sync::Arc<tokio::sync::Semaphore> {
    static LIMIT: std::sync::OnceLock<std::sync::Arc<tokio::sync::Semaphore>> =
        std::sync::OnceLock::new();
    shared(&LIMIT, SIZING)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn a_job_that_never_finishes_gives_its_permit_back() {
        // The property all three sizing call sites got wrong, in the same way:
        // the permit was moved *into* the worker, so it was released only when
        // the worker finished. With a pool of two, two jobs that never finish
        // meant every later drag and every later copy blocked on
        // `acquire_owned` for the rest of the session — the failure
        // `describe_capture` spends a paragraph avoiding, thirty lines above
        // two of them.
        //
        // Stated with a wedged job and a millisecond deadline, because the real
        // one is a minute. The thread really does stay stuck: that is the cost
        // being accepted, and the point is that the *permit* does not stay with
        // it.
        tauri::async_runtime::block_on(async {
            let limit = Arc::new(tokio::sync::Semaphore::new(1));
            let (release, wait) = std::sync::mpsc::channel::<()>();

            let wedged = under_limit(
                limit.clone(),
                Duration::from_millis(50),
                "a wedge",
                move || {
                    // Held until the assertions are done, then let go so the test
                    // does not leak a thread into the rest of the suite.
                    let _ = wait.recv_timeout(Duration::from_secs(10));
                },
            )
            .await;

            assert!(wedged.is_err(), "the deadline fired");
            assert!(
                wedged.unwrap_err().contains("took too long"),
                "and says so in terms a caller can show",
            );

            let regained =
                tokio::time::timeout(Duration::from_secs(2), limit.clone().acquire_owned()).await;
            assert!(
                regained.is_ok(),
                "the permit must be back even though the thread is still stuck",
            );

            let _ = release.send(());
        });
    }

    #[test]
    fn every_limit_leaves_the_shelf_usable() {
        // Zero would deadlock every caller on a semaphore that never admits
        // anyone; a large number is the burst these exist to prevent.
        for permits in [SIZING, SCANNING, FRAMES] {
            assert!(
                (1..=4).contains(&permits),
                "{permits} is not a usable bound"
            );
        }
    }

    #[test]
    fn a_child_is_killed_before_the_job_holding_its_permit_gives_up() {
        // The inequality the OCR deadline only makes sense relative to, and it
        // lived in another file with nothing stating it.
        //
        // The scan gives up at `SCAN_TIMEOUT`; the Linux child is killed at
        // `OCR_CHILD_TIMEOUT`. Reverse them and every wedged capture leaves a
        // `tesseract` process and the blocking thread waiting on it running
        // past the point where anything wants the answer — one per capture, and
        // the shelf starts one per tile.
        //
        // *Not* a permit leak: `under_limit` drops the permit on every path,
        // and the test below this one asserts it. Saying otherwise here was a
        // claim written from an older bug's shape, in the file that fixed it.
        //
        // Also the reason this constant is here rather than in `ocr.rs`: it is
        // `cfg(linux)`-only there, so on the other two platforms it would need a
        // `dead_code` allowance. Asserting the relationship gives it a caller on
        // every platform and gates the thing worth gating, which is better than
        // an allowance that only says the constant is allowed to be unused.
        assert!(
            OCR_CHILD_TIMEOUT < SCAN_TIMEOUT,
            "the child outlives the permit: child {OCR_CHILD_TIMEOUT:?}, scan {SCAN_TIMEOUT:?}",
        );

        // And with room, not by a millisecond: the child has to be killed *and*
        // reaped inside the difference.
        assert!(
            SCAN_TIMEOUT - OCR_CHILD_TIMEOUT >= std::time::Duration::from_secs(5),
            "too little room between the child's deadline and the scan's",
        );
    }

    #[test]
    fn a_shared_limit_is_created_once() {
        static CELL: OnceLock<Arc<Semaphore>> = OnceLock::new();
        let first = shared(&CELL, 2);
        let second = shared(&CELL, 99);
        assert!(
            Arc::ptr_eq(first, second),
            "a second call must not build a second semaphore",
        );
        assert_eq!(first.available_permits(), 2, "the first bound wins");
    }
}
