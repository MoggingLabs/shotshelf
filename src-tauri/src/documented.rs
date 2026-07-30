//! The numbers `docs/USAGE.md` promises the user, joined to the constants that
//! produce them.
//!
//! Six of them, hand-copied into prose with nothing between: how many hand-off
//! copies are kept, how many captures a launch brings back and from how far
//! back, how many corrupt settings files are set aside, what a downscaled export
//! is sized to, and how large the log gets before it restarts. All six agreed
//! when this was written, which is exactly the state in which the seventh
//! divergence is invisible — `lib.rs` already records one of these going the
//! other way, where the guide said the hand-off cache "keeps the 60 most
//! recent" while nothing pruned it within a session at all.
//!
//! `check-references.mjs` reads that document, but its three rules resolve
//! backticked *paths*, `module::item` references and spec titles. A number in
//! prose is invisible to all of them, so the promise had no gate of any kind.
//!
//! Two halves, the shape the other joins in `tests/fixtures/` already use: the
//! test below holds each constant to the fixture, and `check-references.mjs`
//! holds `docs/USAGE.md` to the same fixture. Change a constant and this goes
//! red; change it and the fixture and the document goes red. There is no edit
//! that moves a number and leaves the guide saying the old one.

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    /// The values the usage guide quotes.
    const FIXTURE: &str = include_str!("../../tests/fixtures/documented-limits.json");

    #[test]
    fn the_numbers_the_usage_guide_quotes_are_the_ones_the_code_uses() {
        let promised: BTreeMap<String, u64> =
            serde_json::from_str(FIXTURE).expect("the shared limits fixture parses");

        // Each constant read where it lives, so a rename or a move fails to
        // compile here rather than drifting.
        let actual: BTreeMap<String, u64> = BTreeMap::from([
            (
                "handoffCacheEntries".to_owned(),
                crate::handoff::CACHE_LIMIT as u64,
            ),
            (
                "backfillCaptures".to_owned(),
                crate::catch::BACKFILL_LIMIT as u64,
            ),
            (
                "backfillHours".to_owned(),
                crate::catch::BACKFILL_WINDOW.as_secs() / 3_600,
            ),
            (
                "keptCorruptCopies".to_owned(),
                u64::from(crate::settings::KEPT_CORRUPT),
            ),
            (
                "exportLongEdgePx".to_owned(),
                u64::from(crate::imaging::export::LONG_EDGE),
            ),
            (
                "logRestartKib".to_owned(),
                crate::diag::MAX_LOG_BYTES / 1_024,
            ),
        ]);

        // The sets first: a constant added to the fixture and not here, or here
        // and not in the fixture, would otherwise simply not be compared — the
        // gap this file exists to close, reopened one entry at a time.
        assert_eq!(
            promised.keys().collect::<Vec<_>>(),
            actual.keys().collect::<Vec<_>>(),
            "tests/fixtures/documented-limits.json and this test name different limits",
        );

        assert_eq!(
            actual, promised,
            "a number `docs/USAGE.md` promises the user has drifted from the code",
        );
    }
}
