//! The file a capture is handed over as.
//!
//! Usually the original, untouched — that is the whole promise of a shelf that
//! never modifies your captures. When export sizing is turned on and a capture
//! is genuinely larger than any model will look at, this writes a smaller copy
//! and hands that over instead.
//!
//! Two details that look small and are not:
//!
//! **The copy keeps the original's filename.** Dropping a screenshot into a
//! folder should produce the file you recognise, not a cache key. The copy
//! goes in a directory named after the source instead.
//!
//! **The original is never touched.** The copy is a separate file in a cache
//! directory, and deleting that cache costs nothing but a re-encode.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Runtime};

use crate::imaging::export;

/// Where sized copies live. Cleared whenever the app feels like it; nothing
/// here is anything but a re-derivable copy.
const CACHE_DIR: &str = "handoff";

/// How many sized copies to keep before the oldest are dropped.
pub(crate) const CACHE_LIMIT: usize = 60;

/// The file to hand to the OS for this capture.
///
/// Returns the source path unchanged whenever sizing is off, the capture is a
/// recording, the capture is already small enough, or anything at all goes
/// wrong. That last one matters: a failed re-encode must degrade to "drag the
/// original", never to a failed drag.
pub fn file_for<R: Runtime>(app: &AppHandle<R>, source: &Path, downscale: bool) -> PathBuf {
    if !downscale {
        return source.to_path_buf();
    }

    match sized_copy(app, source) {
        Ok(Some(copy)) => copy,
        Ok(None) => source.to_path_buf(),
        Err(why) => {
            crate::diag::warn(&format!("handing over the original ({why})"));
            source.to_path_buf()
        }
    }
}

/// Write a sized copy, or `Ok(None)` if the capture is already small enough.
fn sized_copy<R: Runtime>(app: &AppHandle<R>, source: &Path) -> Result<Option<PathBuf>, String> {
    let dir = cache_dir(app)?.join(key(source));

    let target = dir.join(handoff_name(source));

    // The cache is checked *before* the work it exists to avoid. It used to
    // sit after the re-encode, which meant every drag and every copy paid a
    // full decode, Lanczos3 resize and PNG encode of a full-resolution
    // screenshot, and the only thing the cache saved was the `write`.
    if target.is_file() {
        return Ok(Some(target));
    }

    let Some(bytes) = export::png_for_handoff(source)? else {
        return Ok(None);
    };

    std::fs::create_dir_all(&dir).map_err(|err| err.to_string())?;

    // Written under a name unique to this call, then renamed into place.
    //
    // The uniqueness has to be per *operation*, not per process: `prepare_drag`
    // and `copy_capture` are `async fn` commands, so a drag and a copy of the
    // same capture run concurrently inside one process, and a staged name shared
    // between them lets the second `write` truncate the file the first had
    // finished — whereupon the first's `rename` publishes a zero-length PNG, and
    // the `is_file` check above then accepts it forever. A per-process id was
    // exactly that mistake.
    //
    // The spelling matters here, because verifying this argument means going to
    // `share.rs` and looking: it says `#[tauri::command]` on an `async fn`, not
    // the `#[tauri::command(async)]` this used to name. `share.rs` argues
    // against that second form by name, so a reader who took this literally
    // would find no hazard and could reasonably delete the nonce.
    //
    // A rename is atomic, so the target is either absent or whole. That also
    // means a write interrupted by a crash or a full disk leaves a `.part`
    // behind rather than a corrupt cache entry.
    static NONCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let ticket = NONCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let staged = dir.join(format!("{}-{ticket}.part", std::process::id()));

    std::fs::write(&staged, bytes).map_err(|err| err.to_string())?;
    if let Err(err) = std::fs::rename(&staged, &target) {
        // Only ever removes *this* call's staged file.
        let _ = std::fs::remove_file(&staged);
        // A concurrent writer may have won the race; its copy is identical.
        if !target.is_file() {
            return Err(err.to_string());
        }
    }

    Ok(Some(target))
}

/// What the sized copy is called: the original's name, with a `.png` extension.
///
/// The extension has to change because the bytes really are PNG, and handing
/// over a file whose contents contradict its name breaks whatever opens it.
/// Everything before it is the original's, because the module's promise at the
/// top of this file is that a drop produces the file the user recognises.
///
/// Appending rather than `with_extension`, which is what this was and which
/// quietly broke that promise: `with_extension` replaces everything after the
/// **last dot of the stem**, and macOS names screenshots
/// `Screenshot 2026-07-27 at 1.30.12 PM.png` by default. The handed-over file
/// arrived as `Screenshot 2026-07-27 at 1.30.png` — a different timestamp,
/// silently, on a first-class platform's out-of-the-box naming.
///
/// The stem itself comes from `edit::safe_stem`, shared rather than restated.
/// Both modules join a name onto a directory they own, so both need the same
/// containment rule; this file had its own copy, under a comment claiming they
/// could not be merged because this one "stays `OsString` so a capture whose
/// name is not valid UTF-8 keeps its bytes". It did not — the very next line
/// called `to_string_lossy`, which has already replaced those bytes. The sole
/// stated reason for the duplicate was a property the code did not have.
fn handoff_name(source: &Path) -> String {
    format!("{}.png", crate::edit::safe_stem(source))
}

fn cache_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    crate::dirs::cache(app, CACHE_DIR)
}

/// A directory name identifying *which version of which file*.
///
/// Through `cache::Version`, shared with the poster cache and the scan cache.
/// All three needed the same thing and each wrote its own — this one FNV-1a
/// over milliseconds, the poster cache `DefaultHasher` over seconds — with
/// three docstrings pointing at each other instead of one function.
fn key(source: &Path) -> String {
    crate::cache::Version::of(source).key()
}

/// Drop the oldest sized copies. Called on a timer from `lib.rs`, like the
/// poster cache: this is a cache, and a cache that only grows is a leak with a
/// nicer name.
///
/// Through `cache::prune`, which the poster cache also uses. The two had
/// separate copies of the same five steps written in different shapes, and
/// neither was tested.
pub fn prune<R: Runtime>(app: &AppHandle<R>) {
    let Ok(dir) = cache_dir(app) else {
        return;
    };
    // A directory per capture version: the copy inside keeps the original's
    // filename, so the version has to be the folder.
    crate::cache::prune(&dir, CACHE_LIMIT, crate::cache::Entry::Directory);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_key_depends_on_the_whole_path_not_the_filename() {
        // Two folders can each hold a `Screenshot.png`, and they are different
        // captures that must not share one cache entry.
        let a = key(Path::new("/one/Screenshot.png"));
        let b = key(Path::new("/two/Screenshot.png"));
        assert_ne!(a, b);
    }

    #[test]
    fn the_key_is_stable_for_the_same_capture() {
        assert_eq!(key(Path::new("/a/b.png")), key(Path::new("/a/b.png")));
    }

    #[test]
    fn the_sized_copy_keeps_a_name_containing_dots() {
        // macOS's default screenshot name. `with_extension` treated
        // `1.30.12 PM` as an extension and replaced it, so the copy claimed a
        // different time than the capture it came from.
        let named = handoff_name(Path::new("/p/Screenshot 2026-07-27 at 1.30.12 PM.png"));
        assert_eq!(named, "Screenshot 2026-07-27 at 1.30.12 PM.png");
    }

    #[test]
    fn the_sized_copy_is_named_after_the_original() {
        assert_eq!(handoff_name(Path::new("/p/shot.jpg")), "shot.png");
        assert_eq!(handoff_name(Path::new("/p/shot.png")), "shot.png");
        // A path with no file name would otherwise join nothing onto the cache
        // directory and target the directory itself.
        assert_eq!(handoff_name(Path::new("/")), "capture.png");
    }

    #[test]
    fn the_sized_copy_is_always_a_png() {
        // The bytes are PNG regardless of what went in; a name that says
        // otherwise breaks whatever opens the dropped file.
        for source in ["/p/a.jpeg", "/p/a.b.c", "/p/a", "/p/a.PNG"] {
            let named = handoff_name(Path::new(source));
            assert!(
                Path::new(&named)
                    .extension()
                    .is_some_and(|ext| ext == "png"),
                "{source} became {named:?}",
            );
        }
    }

    #[test]
    fn a_sized_copy_cannot_be_named_out_of_its_cache_directory() {
        // The same property `edit.rs` states for `safe_stem`, and the same
        // mechanism: `PathBuf::join` *truncates its base* when the pushed
        // component carries a Windows prefix, so a source named `D:evil.png`
        // has the stem `D:evil` and joining it lands outside the cache.
        //
        // `edit.rs` documents this in full, names its sanitiser so a test can
        // reach the shipping code, and asserts containment. One module away,
        // `handoff_name` did none of that and nothing checked it — the write-up
        // of the bug did not check its neighbour.
        //
        // The reach is narrow: a Windows filename cannot contain `:`, so this
        // needs a path from a synced or network volume. Narrow is not a reason
        // to leave the assertion unwritten. The two names are one function now
        // — `handoff_name` delegates to `edit::safe_stem` — so what each module
        // keeps is its own containment assertion, because each joins onto a
        // directory of its own.
        let dir = Path::new(if cfg!(windows) {
            r"C:\cache\handoff\abc"
        } else {
            "/cache/handoff/abc"
        });

        for hostile in [
            r"C:\dir\D:evil.png",
            r"C:\dir\..\..\evil.png",
            "/dir/../../evil.png",
            r"\server\share\evil.png",
        ] {
            let name = handoff_name(Path::new(hostile));

            // The name first, because it is the assertion that holds on every
            // platform. Containment alone is inert off Windows: `D:evil` is not
            // a drive prefix and `\server\share` is not a UNC path on macOS or
            // Linux, so `join` does not truncate and the path cannot leave the
            // directory whatever this returns.
            //
            // **Separators only, not `..`.** The first version of this asserted
            // no `..` either, and that is wrong in a way that only shows off
            // Windows: on Unix `C:\dir\..\..\evil.png` is a single file name,
            // so `file_stem` keeps the dots and `safe_stem` — which replaces
            // separators, not dots — leaves them. It turned two of the three CI
            // legs red, in the commit whose message was "two of three CI legs
            // ran an inert fixture".
            //
            // And `..` on its own is not the danger. Traversal needs a
            // separator; a name with none cannot leave the directory it is
            // joined to, whatever dots it contains. Asserting the separators are
            // gone *is* asserting containment, on every platform.
            for forbidden in [":", "/", "\\"] {
                assert!(
                    !name.contains(forbidden),
                    "{hostile} produced the name {name:?}, which still carries {forbidden:?}",
                );
            }

            let target = dir.join(&name);
            assert!(
                target.starts_with(dir),
                "{hostile} escaped the cache as {}",
                target.display(),
            );
        }
    }

    #[test]
    fn the_key_is_filesystem_safe() {
        let key = key(Path::new(r"C:\Users\someone\Pictures\Screenshots\a b.png"));
        assert!(
            key.chars().all(|c| c.is_ascii_hexdigit()),
            "a path cannot be a directory name on every platform: {key}",
        );
    }
}
