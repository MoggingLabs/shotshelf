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

use std::sync::{Arc, OnceLock};

use tokio::sync::Semaphore;

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
async fn under_limit<T, W>(
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
