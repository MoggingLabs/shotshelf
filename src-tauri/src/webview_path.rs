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

use std::path::PathBuf;

/// Resolve a webview-supplied path to a file that is actually there.
///
/// Two checks, both load-bearing:
///
/// **Absolute.** A relative path is resolved against whatever the process's
/// working directory happens to be — which is not a property the front-end
/// knows or should depend on, and on a packaged build is not even stable.
///
/// **Present.** A tile can outlive its file: an emptied Recycle Bin, a cleared
/// temp folder, a capture moved out from under the shelf. Handing the OS a
/// missing path makes for a drag that silently does nothing, and every caller
/// here would rather report that than fail halfway through.
pub fn existing_file(path: &str) -> Result<PathBuf, String> {
    let source = PathBuf::from(path);

    if !source.is_absolute() {
        return Err(format!("{path} is not an absolute path"));
    }
    if !source.is_file() {
        return Err(format!("{path} is no longer on disk"));
    }

    Ok(source)
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
