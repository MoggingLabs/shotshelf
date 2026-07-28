//! Paths that arrive from the webview.
//!
//! The webview is the least-trusted process in the app, and six commands take
//! a filesystem path straight from it. Checking that path is one rule, so it
//! lives in one place.
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

/// Resolve a webview-supplied path to a file that is actually there.
///
/// For every caller that goes on to *read* the file. A tile can outlive its
/// file, and handing the OS a missing path makes for a drag that silently does
/// nothing — every caller here would rather report that than fail halfway
/// through.
pub fn existing_file(path: &str) -> Result<PathBuf, String> {
    let source = absolute(path)?;

    if !source.is_file() {
        return Err(format!("{path} is no longer on disk"));
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
        let err = existing_file("Pictures/Screenshot.png").expect_err("relative");
        assert!(err.contains("absolute"), "{err}");
    }

    #[test]
    fn a_path_that_is_not_there_is_refused() {
        let absolute = std::env::temp_dir().join("shotshelf-does-not-exist-000.png");
        let err = existing_file(&absolute.to_string_lossy()).expect_err("missing");
        assert!(err.contains("no longer on disk"), "{err}");
    }

    #[test]
    fn a_directory_is_not_a_file() {
        // `is_file` rather than `exists`: every caller goes on to read bytes.
        let dir = std::env::temp_dir();
        let err = existing_file(&dir.to_string_lossy()).expect_err("a directory");
        assert!(err.contains("no longer on disk"), "{err}");
    }

    #[test]
    fn a_real_file_comes_back() {
        let path = std::env::temp_dir().join("shotshelf-webview-path-test.png");
        std::fs::write(&path, b"x").expect("write");

        let resolved = existing_file(&path.to_string_lossy()).expect("a real file");
        assert_eq!(resolved, path);

        let _ = std::fs::remove_file(&path);
    }
}
