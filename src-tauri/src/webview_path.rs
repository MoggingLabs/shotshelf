//! Paths that arrive from the webview.
//!
//! The webview is the least-trusted process in the app, and every command that
//! touches a capture takes a filesystem path straight from it. Checking that
//! path is one rule, so it lives in one place.
//!
//! Stated without a count on purpose: this said "six commands" while there
//! were seven, which is the failure mode of any number written into prose next
//! to code that grows.
//!
//! It did not. `share.rs` and `edit.rs` each grew their own copy of the same
//! ten lines, and the copies did what copies do: `edit.rs` lost the
//! absolute-path check at some point and nobody noticed, because there was
//! nothing to notice it against. `poster.rs` never had a check at all — both
//! of its commands took a path from the webview and went straight to
//! `fs::metadata`. Deleting one of the two copies would have left that third
//! module exactly as it was, which is why this is a module rather than an
//! `edit.rs` that imports from `share.rs`.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager, Runtime};

/// Accept a webview-supplied path without requiring it to still exist.
///
/// **Absolute** is the part that always matters: a relative path is resolved
/// against whatever the process's working directory happens to be — not a
/// property the front-end knows or should depend on, and on a packaged build
/// not even stable.
///
/// Existence is a separate question, because for one caller it is the wrong
/// one. `save_edit` takes the source path purely to name the result, and the
/// editor is holding the composited pixels in memory by then. Refusing to
/// write because the original has gone — an emptied Recycle Bin, which this
/// app's own docs call routine — throws away the annotation the user just
/// spent five minutes on, to protect a file nothing is going to read.
pub fn absolute(path: &str) -> Result<PathBuf, String> {
    let source = PathBuf::from(path);

    if !source.is_absolute() {
        return Err(format!("{path} is not an absolute path"));
    }

    Ok(source)
}

/// How this module says a capture's file has gone.
///
/// A named constant because the front end matches on it. `src/shelf/view/tile.ts` reads
/// `String(error).includes(…)` to tell a recording that has been deleted from
/// one that is there but unreadable — no ffmpeg, an unsupported container — and
/// shows the ⚠ glyph for the first and nothing for the second. That was one
/// sentence in three hand-maintained copies across two languages, with nothing
/// joining them: this literal, the front end's substring, and a third copy in a
/// spec stub. Rewording it here left every gate green while `docs/USAGE.md`'s
/// "a tile shows ⚠ when the file has been moved or deleted" quietly went back to
/// being true of images only — the exact regression the comment at that branch
/// says it was written to fix.
///
/// Joined through `tests/fixtures/capture-missing.json`, the way [`crate::catch::STARTING`]
/// is through `engine-starting.json`.
pub const MISSING: &str = "is no longer on disk";

/// Resolve a webview-supplied path to a capture this app is allowed to read.
///
/// For every caller that goes on to *read* the file. Three checks:
///
/// **Absolute**, as above.
///
/// **Present.** A tile can outlive its file, and handing the OS a missing path
/// makes for a drag that silently does nothing — every caller here would
/// rather report that than fail halfway through.
///
/// **In scope.** The asset protocol is scoped shut by default and opened only
/// for the folders the catch engine watches, the clipboard directory, the
/// edits directory and the poster cache — so the webview can *display* exactly
/// those and nothing else. Rust had no such limit, which meant any file on the
/// machine could be read and credential-scanned, put on the clipboard, or
/// handed to the OS as a drag payload, by asking for it by name. It also
/// persisted: `set_pinned` writes paths to `pinned.json` — the local file, never
/// the roaming preferences one, which is the whole point of the split — and they are
/// restored and re-scanned at the next launch.
///
/// Reusing the asset scope rather than inventing a second list is the point.
/// Every capture the shelf can act on is one it is already showing, so the two
/// boundaries agreeing costs nothing and cannot drift apart — and this one
/// fails closed.
pub fn existing_file<R: Runtime>(app: &AppHandle<R>, path: &str) -> Result<PathBuf, String> {
    let source = absolute(path)?;

    if !source.is_file() {
        return Err(format!("{path} {MISSING}"));
    }
    if !app.asset_protocol_scope().is_allowed(&source) {
        return Err(format!(
            "{path} is not somewhere Shotshelf reads captures from"
        ));
    }

    Ok(source)
}

/// The most of one capture that is ever held in memory at a time.
///
/// Generous for what it guards — a 6K screenshot is a few megabytes — and the
/// point is only that there *is* a ceiling. Every caller below hands a whole
/// file to something in a single allocation, and the path reaches them from
/// the webview, so an unbounded read turns one stray path into an
/// out-of-memory kill of the app.
pub const MAX_CAPTURE_BYTES: u64 = 96 * 1024 * 1024;

/// Read a capture into memory, refusing one that is implausibly large.
///
/// Here rather than beside any one caller because there are three, in three
/// modules, and the last round bounded the two that had been named in a review
/// while the third — `copy_capture`, reading whatever `handoff` handed back,
/// which with export sizing off is the original — kept reading without a
/// ceiling. Same argument, same input, different file.
pub fn read_capture(path: &Path) -> std::io::Result<Vec<u8>> {
    use std::io::Read;

    let file = std::fs::File::open(path)?;
    let size = file.metadata()?.len();
    if size > MAX_CAPTURE_BYTES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("{size} bytes is past the ceiling for a single capture"),
        ));
    }

    let mut bytes = Vec::new();
    // Capped a second time on the read itself: the file can grow between the
    // metadata call and here.
    file.take(MAX_CAPTURE_BYTES).read_to_end(&mut bytes)?;
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_missing_sentence_matches_what_the_front_end_looks_for() {
        // Both sides of one string, joined through the fixture rather than
        // agreeing by hand. `src/shelf/view/tile.ts` matches on a substring of
        // this to decide whether a recording gets the ⚠ glyph, and a spec
        // rejects `video_details` with it.
        let shared: serde_json::Value =
            serde_json::from_str(include_str!("../../tests/fixtures/capture-missing.json"))
                .expect("the shared fixture parses");
        assert_eq!(
            shared["missing"].as_str(),
            Some(MISSING),
            "the sentence and the fixture the front end reads have drifted",
        );
    }

    #[test]
    fn a_relative_path_is_refused() {
        // Whatever the working directory is, it is not the front-end's to
        // choose. This is the check `edit.rs`'s copy had quietly lost.
        let err = absolute("Pictures/Screenshot.png").expect_err("relative");
        assert!(err.contains("absolute"), "{err}");

        // Traversal is refused by the same rule rather than by a separate one.
        assert!(absolute("../../etc/passwd").is_err());
    }

    #[test]
    fn an_absolute_path_is_taken_whether_or_not_it_still_exists() {
        // `save_edit` needs exactly this: the name of a capture that may have
        // been deleted while the editor was open. The pixels are already in
        // hand, so refusing would discard the annotation to protect a file the
        // function never opens.
        let gone = std::env::temp_dir().join("shotshelf-does-not-exist-000.png");
        assert!(absolute(&gone.to_string_lossy()).is_ok());
    }

    // `existing_file`'s **scope check has no automated coverage**, and neither
    // does anything else that takes an `AppHandle`.
    //
    // **The scope, stated properly.** Not a list of stragglers: it is every
    // registered command whose arguments cannot be built in a test — an
    // `AppHandle` for most, a `tauri::State` for `get_settings` and
    // `set_pinned` — and the whole shell beneath them. The one exception is
    // `enrich::ocr::text_recognition_available`, which takes nothing and is
    // tested directly.
    //
    // Stated without a count, and this sentence has now been wrong three
    // ways: "six commands" when there were seven, then a false universal, then
    // "all bar one" when it is three. A criterion is checkable; a tally is
    // just a fact that goes stale. `share.rs`, `edit.rs`, `poster.rs`, `window.rs`,
    // `catch/mod.rs` (including `catch_backfill` and `catch_watch_dirs`),
    // `catch/folders.rs`, `catch/paths.rs`, `catch/clipboard.rs`, `tray.rs`,
    // `hotkey.rs`, `update.rs`, `imaging/mod.rs`, `diag.rs`, `settings::load`,
    // `handoff::file_for`, `read_capture`'s ceiling, and `lib.rs`'s entire
    // setup ordering. A reviewer demonstrated the reach twice: once by
    // deleting the scope check below, and once by making `prepare_drag` never
    // call `handoff::file_for` — killing export sizing outright. Both left
    // clippy and every test green.
    //
    // **Why.** Two gate populations, disjoint by construction. No Playwright
    // spec can reach Rust: `tests/harness/tauri-mock.ts` replaces
    // `window.__TAURI_INTERNALS__` wholesale, so no spec ever executes a
    // `#[tauri::command]`. And no Rust test here can construct an `AppHandle`.
    //
    // **What was tried, and what is actually known.** Tauri ships
    // `tauri::test::mock_builder` for this. Three wirings were attempted — a
    // `[dev-dependencies]` entry, the `test` feature on the existing
    // dependency, and the WebView2 loader copied beside the test binary — and
    // all three compiled and died at load with `STATUS_ENTRYPOINT_NOT_FOUND`
    // (0xc0000139) on the development machine.
    //
    // An earlier version of this comment blamed the crate building as a
    // `cdylib`, and prescribed an integration test under `src-tauri/tests/` as
    // "the route that should work". **Both claims were wrong**, and a reviewer
    // disproved them in sixteen seconds: `cargo test --lib` builds a standalone
    // *executable* and never links the `cdylib` at all, and an integration test
    // that merely names `shotshelf_lib::run` dies with the identical error
    // while one containing `2 + 2` passes. The variable is not the target kind
    // — it is whether the linked object graph reaches the Tauri runtime.
    // `--lib` passes today only because no test references `run()`, so the
    // linker drops the runtime and its imports with it.
    //
    // So the honest statement is: **any Rust test that links the Tauri runtime
    // fails to load on this machine, and the cause is unidentified.** Nothing
    // about the failure is crate-shaped, which makes it most likely local — the
    // same Smart App Control and WebView2 estate that refuses the packaged app.
    // The way to find out is to land the mock-runtime test and let CI answer on
    // three OSes. **CI** runs `--all-targets` precisely so such a test would be
    // run rather than silently skipped; the local `npm run gate` runs `--lib`,
    // because Smart App Control refuses the bin target's freshly linked test
    // harness here. Add a test under `src-tauri/tests/` and CI will run it and
    // your local gate will not — a difference stated in README, CONTRIBUTING
    // and SECURITY.md, and, until this was corrected, stated backwards right here, in the one paragraph
    // that reasons about why it matters. It is not landed
    // here because a change that alters what the shipped binary links is not
    // something to push unverified from a machine that cannot launch it.
    //
    // Until then the shape checks above are the half that is pure and tested.
    // The scope half rests on reading Tauri's `FsScope::is_allowed`, which
    // canonicalizes before matching, and on the grant and the watcher being
    // non-recursive over the same resolved list.
}
