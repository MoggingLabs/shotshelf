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

use tauri::{AppHandle, Manager, Runtime};

use crate::imaging::export;

/// Where sized copies live. Cleared whenever the app feels like it; nothing
/// here is anything but a re-derivable copy.
const CACHE_DIR: &str = "handoff";

/// How many sized copies to keep before the oldest are dropped.
const CACHE_LIMIT: usize = 60;

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

    let Some(bytes) = export::png_for_handoff(source, export::LONG_EDGE)? else {
        return Ok(None);
    };

    std::fs::create_dir_all(&dir).map_err(|err| err.to_string())?;

    // Written under a name unique to this call, then renamed into place.
    //
    // The uniqueness has to be per *operation*, not per process: these
    // commands are `command(async)`, so a drag and a copy of the same capture
    // run concurrently inside one process, and a staged name shared between
    // them lets the second `write` truncate the file the first had finished —
    // whereupon the first's `rename` publishes a zero-length PNG, and the
    // `is_file` check above then accepts it forever. A per-process id was
    // exactly that mistake.
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
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|err| err.to_string())?
        .join(CACHE_DIR);
    std::fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    Ok(dir)
}

/// A directory name identifying *which version of which file*.
///
/// Two captures can share a filename — `Screenshot.png` in two folders — so
/// the key has to come from the whole path, and it has to be filesystem-safe
/// on every platform, which rules out the path itself.
///
/// The modified time is in the key for a sharper reason. Plenty of capture
/// tools reuse a filename: a fixed ShareX pattern, an overwritten
/// `Screenshot.png`, a file re-saved from an editor. Keyed on path alone, the
/// cache would hand over the *previous* image's pixels while the shelf showed
/// the new thumbnail — the app's one job is handing over a specific
/// screenshot, so delivering different pixels than the ones on screen is a
/// disclosure bug rather than a stale cache. The poster cache already keys on
/// path and mtime for exactly this reason.
fn key(source: &Path) -> String {
    // An unreadable timestamp is not a reason to fail; it only means this
    // capture shares a key with its other versions, which is where we were.
    let modified = std::fs::metadata(source)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|at| at.duration_since(std::time::UNIX_EPOCH).ok());

    fingerprint(&source.to_string_lossy(), modified)
}

/// The key itself, with the filesystem factored out.
///
/// Split from `key` so the "a re-saved capture gets a new key" property can be
/// stated with two timestamps rather than by writing a file, sleeping, and
/// hoping the filesystem records a distinct mtime. That test passed on NTFS
/// and APFS and was one coarse-granularity runner away from failing for a
/// reason that had nothing to do with the code.
fn fingerprint(path: &str, modified: Option<std::time::Duration>) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    let mut eat = |bytes: &[u8]| {
        for byte in bytes {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
    };

    eat(path.as_bytes());
    if let Some(age) = modified {
        eat(&age.as_millis().to_le_bytes());
    }

    format!("{hash:016x}")
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
    fn a_replaced_capture_gets_a_new_key() {
        // A capture tool reusing a filename must not make the shelf hand over
        // the previous image's pixels under the new thumbnail.
        //
        // Stated against `fingerprint` with two timestamps rather than by
        // writing a file twice and sleeping: the property is "a different
        // mtime is a different key", and going through the filesystem to say
        // so made it depend on the runner's timestamp granularity instead.
        let at = |ms| Some(std::time::Duration::from_millis(ms));
        let first = fingerprint("/pictures/Screenshot.png", at(1_700_000_000_000));
        let second = fingerprint("/pictures/Screenshot.png", at(1_700_000_000_020));

        assert_ne!(first, second, "same path, different contents, same key");
    }

    #[test]
    fn a_capture_with_no_readable_timestamp_still_gets_a_key() {
        // Degrades to sharing a key with its other versions, which is where
        // the cache was before mtime was part of it — not to a panic.
        let keyed = fingerprint("/pictures/Screenshot.png", None);
        assert_eq!(keyed.len(), 16);
        assert!(keyed.chars().all(|c| c.is_ascii_hexdigit()));
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
        // to leave the assertion unwritten, and it is why the containment is
        // asserted here rather than the two names being merged — `handoff_name`
        // stays `OsString` for captures whose names are not valid UTF-8, which
        // `safe_stem` does not.
        let dir = Path::new(if cfg!(windows) {
            r"C:\cache\handoffbc"
        } else {
            "/cache/handoff/abc"
        });

        for hostile in [
            r"C:\dir\D:evil.png",
            r"C:\dir\..\..\evil.png",
            "/dir/../../evil.png",
            r"\server\share\evil.png",
        ] {
            let target = dir.join(handoff_name(Path::new(hostile)));
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
