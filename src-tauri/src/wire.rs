//! One place that says what the webview receives, and checks it is still true.
//!
//! Field names are as much of the IPC contract as the command names are, and
//! they were joined a struct at a time — by whichever review round happened to
//! trip over that struct. `VideoDetails` and `Watching` each got a fixture;
//! `Capture`, which is the payload of `capture://new` *and* the return type of
//! `catch_backfill`, did not. Renaming `Capture::ts` and its six readers here
//! left every gate in the repo green, while in the running app `captureId`
//! becomes `"undefined:<path>"`, `ShelfStore::sweep`'s `item.ts < cutoff` is
//! `undefined < n` and so retention never evicts anything, day headings read
//! Invalid Date, and `set_pinned` rejects every pin.
//!
//! So the manifest is the contract for *every* serialising type, and
//! `scripts/check-wire.mjs` asks the crate which those are rather than
//! trusting this list to be complete. `src/wire.test.ts` asserts the other half
//! against the same file: rename a field on either side and one of the two goes
//! red, whichever side moved.
//!
//! Sorted on both sides. `serde_json` stores an object in a `BTreeMap` and hands
//! the keys back alphabetically; `Object.keys` in the sibling test yields
//! declaration order. What is being joined is the set of names.

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use serde_json::json;

    /// The field names each type is expected to put on the wire.
    const FIXTURE: &str = include_str!("../../tests/fixtures/wire-fields.json");

    /// A sample of every serialising type in the crate, by name.
    ///
    /// Hand-built values rather than anything reflective: constructing one is
    /// what proves the field names compile, so renaming a field in Rust fails
    /// here twice over — once to build and once to compare.
    fn samples() -> BTreeMap<&'static str, serde_json::Value> {
        use crate::{
            catch::{Capture, CaptureKind, Watching},
            enrich::{secrets, Findings},
            poster::VideoDetails,
            settings::{LocalState, PinnedItem, Settings},
            share::DragSource,
        };

        /// Names each sample at its call, so the list below reads as a table.
        fn value(
            what: &'static str,
            sample: serde_json::Value,
        ) -> (&'static str, serde_json::Value) {
            (what, sample)
        }

        BTreeMap::from([
            value(
                "Capture",
                json!(Capture {
                    path: String::new(),
                    kind: CaptureKind::Image,
                    ts: 0,
                    // Non-default, because `Capture::context` carries
                    // `skip_serializing_if` and an empty one would leave the
                    // field off the wire — which is correct at runtime and
                    // would quietly shrink what this test compares.
                    context: crate::enrich::foreground::Context {
                        label: Some(String::new()),
                    },
                }),
            ),
            value(
                "Context",
                json!(crate::enrich::foreground::Context {
                    label: Some(String::new()),
                }),
            ),
            value("DragSource", json!(DragSource::sample())),
            value(
                "Finding",
                json!(secrets::Finding {
                    kind: secrets::SecretKind::PrivateKey,
                    label: "",
                    preview: String::new(),
                    severity: 0,
                }),
            ),
            value("Findings", json!(Findings::default())),
            value("LocalState", json!(LocalState::default())),
            value(
                "PinnedItem",
                json!(PinnedItem {
                    path: String::new(),
                    kind: CaptureKind::Image,
                    ts: 0,
                }),
            ),
            value("Settings", json!(Settings::default())),
            value(
                "VideoDetails",
                json!(VideoDetails {
                    poster: None,
                    duration_ms: None,
                    bytes: 0,
                }),
            ),
            value(
                "Watching",
                json!(Watching {
                    dirs: Vec::new(),
                    clipboard: false,
                }),
            ),
        ])
    }

    #[test]
    fn every_serialised_type_puts_the_fields_the_front_end_reads_on_the_wire() {
        let expected: BTreeMap<String, Vec<String>> =
            serde_json::from_str(FIXTURE).expect("the shared field fixture parses");
        let samples = samples();

        // The manifest and the samples cover the same types. Without this, a
        // type could be added to one and not the other and the comparison below
        // would simply not run for it — which is the shape of the gap this
        // whole file exists to close.
        //
        // `check-wire.mjs` holds the manifest to what the *crate*
        // serialises; this holds the samples to the manifest. Between them
        // there is no way to add a serialising type and be checked nowhere.
        //
        // Named carefully: this credited `check-commands.mjs`, which reads
        // `generate_handler!` and greps `invoke(` and never opens the manifest.
        // `check-references.mjs` cannot catch that — the file it named exists —
        // so a maintainer trimming the `deadcode` chain could have deleted the
        // script that does the work on this comment's word.
        let declared: Vec<&str> = expected.keys().map(String::as_str).collect();
        let built: Vec<&str> = samples.keys().copied().collect();
        assert_eq!(
            declared, built,
            "tests/fixtures/wire-fields.json and `samples` name different types",
        );

        for (what, sample) in samples {
            let mut fields: Vec<String> = sample
                .as_object()
                .unwrap_or_else(|| panic!("{what} serialises as an object"))
                .keys()
                .cloned()
                .collect();
            fields.sort();

            let mut want = expected.get(what).cloned().unwrap_or_default();
            want.sort();

            assert_eq!(
                fields, want,
                "{what}'s wire fields have drifted from tests/fixtures/wire-fields.json",
            );
        }
    }
}
