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
            eprintln!("shotshelf: handing over the original ({why})");
            source.to_path_buf()
        }
    }
}

/// Write a sized copy, or `Ok(None)` if the capture is already small enough.
fn sized_copy<R: Runtime>(app: &AppHandle<R>, source: &Path) -> Result<Option<PathBuf>, String> {
    let Some(bytes) = export::png_for_handoff(source, export::LONG_EDGE)? else {
        return Ok(None);
    };

    let dir = cache_dir(app)?.join(key(source));
    std::fs::create_dir_all(&dir).map_err(|err| err.to_string())?;

    // The original filename, so a drop produces the file the user recognises.
    // The extension becomes .png because the bytes are PNG — handing over a
    // file whose contents contradict its name breaks whatever opens it.
    let name = source.file_stem().unwrap_or_default();
    let target = dir.join(Path::new(name).with_extension("png"));

    // Byte-for-byte identical work, already done.
    if !target.is_file() {
        std::fs::write(&target, bytes).map_err(|err| err.to_string())?;
    }

    Ok(Some(target))
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
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    let mut eat = |bytes: &[u8]| {
        for byte in bytes {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
    };

    eat(source.to_string_lossy().as_bytes());

    // An unreadable timestamp is not a reason to fail; it only means this
    // capture shares a key with its other versions, which is where we were.
    if let Ok(modified) = std::fs::metadata(source).and_then(|meta| meta.modified()) {
        if let Ok(age) = modified.duration_since(std::time::UNIX_EPOCH) {
            eat(&age.as_millis().to_le_bytes());
        }
    }

    format!("{hash:016x}")
}

/// Drop the oldest sized copies. Called at startup, like the poster cache:
/// this is a cache, and a cache that only grows is a leak with a nicer name.
pub fn prune<R: Runtime>(app: &AppHandle<R>) {
    let Ok(dir) = cache_dir(app) else {
        return;
    };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return;
    };

    let mut folders: Vec<(std::time::SystemTime, PathBuf)> = entries
        .flatten()
        .filter(|entry| entry.path().is_dir())
        .filter_map(|entry| {
            let modified = entry.metadata().and_then(|meta| meta.modified()).ok()?;
            Some((modified, entry.path()))
        })
        .collect();

    if folders.len() <= CACHE_LIMIT {
        return;
    }

    // Oldest first, so the ones dropped are the ones least recently handed out.
    folders.sort_unstable_by_key(|(modified, _)| *modified);
    for (_, path) in folders.iter().take(folders.len() - CACHE_LIMIT) {
        let _ = std::fs::remove_dir_all(path);
    }
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
        let path = std::env::temp_dir().join("shotshelf-handoff-key-test.png");
        std::fs::write(&path, b"first").expect("write");
        let first = key(&path);

        // Enough of a gap that the filesystem records a different mtime.
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(&path, b"second").expect("rewrite");
        let second = key(&path);

        let _ = std::fs::remove_file(&path);
        assert_ne!(first, second, "same path, different contents, same key");
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
