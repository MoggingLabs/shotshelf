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
/// persisted: `set_pinned` writes paths to `settings.json`, and they are
/// restored and re-scanned at the next launch.
///
/// Reusing the asset scope rather than inventing a second list is the point.
/// Every capture the shelf can act on is one it is already showing, so the two
/// boundaries agreeing costs nothing and cannot drift apart — and this one
/// fails closed.
pub fn existing_file<R: Runtime>(app: &AppHandle<R>, path: &str) -> Result<PathBuf, String> {
    let source = absolute(path)?;

    if !source.is_file() {
        return Err(format!("{path} is no longer on disk"));
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

    // `existing_file` additionally consults the asset-protocol scope, which
    // needs a running app — so it has **no automated coverage at all**, here or
    // anywhere. The front-end gate cannot reach it: `tests/harness/tauri-mock.ts`
    // replaces `window.__TAURI_INTERNALS__` wholesale, so no Playwright spec
    // ever executes a `#[tauri::command]`. An earlier version of this comment
    // said the front-end gate exercised it, which was simply false and is the
    // kind of claim that stops the next reader from looking.
    //
    // The shape checks above are the half that is pure and are tested. The
    // scope half rests on reading Tauri's `FsScope::is_allowed`, which
    // canonicalizes before matching, and on the watcher and the grant being
    // non-recursive over the same resolved list.
}
