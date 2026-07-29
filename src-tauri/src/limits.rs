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

#[cfg(test)]
mod tests {
    use super::*;

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
