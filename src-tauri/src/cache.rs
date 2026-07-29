//! Keeping a derived-data cache from growing without bound.
//!
//! Two caches need this — poster frames and sized hand-off copies — and both
//! wrote it out themselves, in shapes different enough that a reader could not
//! tell they were the same rule: one sorted ascending and took from the front,
//! the other sorted with `Reverse` and drained from the back; one deleted
//! files, the other directories; one filtered its entries, the other did not.
//! Neither had a test.
//!
//! That combination is worth naming, because these are the app's only two
//! unattended delete loops and `lib.rs` runs both on a timer for the lifetime
//! of a tray app that is expected to stay up for weeks. A sort in the wrong
//! direction evicts the *newest* entries — the ones on screen — and re-derives
//! them forever, at the cost of an ffmpeg run each. Nothing would have failed.
//!
//! Neither cache can cost anyone a capture: everything here is re-derivable,
//! and every path involved is inside a directory the app owns. That is what
//! makes an eviction rule acceptable at all, and it is why the *sort order* is
//! the only thing that can really go wrong.

use std::path::{Path, PathBuf};
use std::time::SystemTime;

use tauri::{AppHandle, Manager, Runtime};

/// What one cache entry is.
///
/// The hand-off cache keys a *directory* per capture version, because the copy
/// inside it keeps the original's filename; the poster cache stores one file
/// per recording. Passing this in rather than deleting whatever is found keeps
/// a stray file in a directory cache — or a directory in a file cache — from
/// being swept by a rule that was not written with it in mind.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Entry {
    File,
    Directory,
}

/// Which entries a sweep would drop, given what is in the cache.
///
/// Split from the deleting so the part that has a direction can be tested
/// without a filesystem, a clock, or a real cache. This is the whole of the
/// rule: everything around it is `read_dir` and `remove_*`.
pub fn overflow(mut entries: Vec<(SystemTime, PathBuf)>, limit: usize) -> Vec<PathBuf> {
    if entries.len() <= limit {
        return Vec::new();
    }

    // Oldest first, and the oldest are what go.
    //
    // Not true LRU: a cache *hit* returns without touching the entry, so a
    // capture dragged every day still ages out on the timestamp it was written
    // with. Acceptable for a cache whose miss costs a re-encode, and stated
    // rather than implied.
    entries.sort_unstable_by_key(|(modified, _)| *modified);
    let excess = entries.len() - limit;
    entries
        .into_iter()
        .take(excess)
        .map(|(_, path)| path)
        .collect()
}

/// Drop the oldest entries in `dir` until at most `limit` remain.
///
/// Every failure is silent by design: this runs on a timer with nobody
/// watching, and a cache that could not be swept this half-hour is not worth
/// interrupting anyone over. It will be tried again.
pub fn prune(dir: &Path, limit: usize, kind: Entry) {
    let Ok(listing) = std::fs::read_dir(dir) else {
        return;
    };

    let entries: Vec<(SystemTime, PathBuf)> = listing
        .flatten()
        .filter(|entry| match kind {
            Entry::File => entry.path().is_file(),
            Entry::Directory => entry.path().is_dir(),
        })
        .filter_map(|entry| {
            let modified = entry.metadata().and_then(|meta| meta.modified()).ok()?;
            Some((modified, entry.path()))
        })
        .collect();

    for stale in overflow(entries, limit) {
        let _ = match kind {
            Entry::File => std::fs::remove_file(&stale),
            Entry::Directory => std::fs::remove_dir_all(&stale),
        };
    }
}

/// A named directory under the app's cache root, created if it is not there.
///
/// Both caches resolved this themselves, in bodies identical but for the name.
/// This module exists because "two caches wrote the same rule out themselves,
/// in shapes different enough that a reader could not tell they were the same
/// rule" — the pruning and the keying moved here and the *directory* was left
/// behind in both callers, which is the same observation one level down.
pub fn dir<R: Runtime>(app: &AppHandle<R>, name: &str) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|err| err.to_string())?
        .join(name);
    std::fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    Ok(dir)
}

/// Which *version of which file* a piece of derived data belongs to.
///
/// Three caches need this and each had its own encoding — FNV-1a over
/// milliseconds, `DefaultHasher` over seconds, and a bare `(PathBuf,
/// Option<Duration>)` tuple — with the mtime read written out verbatim in two
/// of them. The concept was not named, it was *narrated*: three docstrings
/// pointing at each other ("the poster cache already keys on path and mtime
/// for exactly this reason", "the mistake `handoff.rs`'s key docstring
/// used to record", "the hand-off cache next door keys on path and mtime for exactly
/// this reason"). Three cross-references is a codebase saying it has one
/// concept and three copies of it.
///
/// The property they all exist for is the same, and each states it: serving
/// the *previous* version's derived data under the new thumbnail is a
/// disclosure bug rather than a stale cache. Three encodings meant it could be
/// lost one at a time — and it was: `poster` keyed on seconds, so re-recording
/// within a second served the old clip's frame, and it had no test at all
/// until a reviewer deleted the mtime and watched everything stay green.
///
/// Milliseconds, because a capture tool overwriting its output inside one
/// second is ordinary. `Ord` so callers can compare versions rather than only
/// test equality.
#[derive(Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Debug)]
pub struct Version {
    path: PathBuf,
    /// `None` when the timestamp could not be read, which only means this file
    /// shares a version with its other versions — where every one of these
    /// caches was before mtime was part of the key.
    modified_ms: Option<u128>,
}

impl Version {
    /// Read the version of a file from disk.
    pub fn of(source: &Path) -> Self {
        Self::from_parts(source, std::fs::metadata(source).ok().as_ref())
    }

    /// Same, for a caller that already holds the metadata — `poster.rs` reads
    /// it for the file size in the same breath.
    pub fn from_meta(source: &Path, meta: &std::fs::Metadata) -> Self {
        Self::from_parts(source, Some(meta))
    }

    fn from_parts(source: &Path, meta: Option<&std::fs::Metadata>) -> Self {
        let modified_ms = meta
            .and_then(|meta| meta.modified().ok())
            .and_then(|at| at.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|since| since.as_millis());
        Self {
            path: source.to_path_buf(),
            modified_ms,
        }
    }

    /// A filesystem-safe, fixed-width name for this version.
    ///
    /// Hashed because the alternative — the path itself — is not a legal
    /// directory or file name on every platform. Fixed width so a prefix
    /// cannot be ambiguous: `poster.rs` matches cached frames by prefix, and a
    /// variable-length key would let one capture's sweep match another's.
    pub fn key(&self) -> String {
        // FNV-1a, deterministic across releases — unlike `DefaultHasher`,
        // whose algorithm std explicitly does not promise to keep stable, and
        // which was keying one of these caches. A cache key that changes when
        // the toolchain does silently invalidates every entry.
        let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
        let mut eat = |bytes: &[u8]| {
            for byte in bytes {
                hash ^= u64::from(*byte);
                hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
            }
        };

        eat(self.path.to_string_lossy().as_bytes());
        if let Some(ms) = self.modified_ms {
            eat(&ms.to_le_bytes());
        }

        format!("{hash:016x}")
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    fn at(seconds: u64) -> SystemTime {
        SystemTime::UNIX_EPOCH + Duration::from_secs(seconds)
    }

    fn entry(seconds: u64, name: &str) -> (SystemTime, PathBuf) {
        (at(seconds), PathBuf::from(name))
    }

    fn version(path: &str, ms: Option<u128>) -> Version {
        Version {
            path: PathBuf::from(path),
            modified_ms: ms,
        }
    }

    #[test]
    fn a_re_saved_capture_is_a_different_version() {
        // The property all three caches exist for, stated once. Each of their
        // docstrings calls serving the previous version's pixels under the new
        // thumbnail a disclosure bug rather than a stale cache.
        //
        // Milliseconds: at one-second granularity — which one of the three
        // used — a capture tool overwriting its output inside the same second
        // served the old file's derived data. That cache had no test at all.
        assert_ne!(
            version("/p/shot.png", Some(1_700_000_000_000)).key(),
            version("/p/shot.png", Some(1_700_000_000_020)).key(),
            "same path, different contents, same key",
        );
        assert_eq!(
            version("/p/shot.png", Some(1)).key(),
            version("/p/shot.png", Some(1)).key(),
        );
        assert_ne!(
            version("/one/Screenshot.png", Some(1)).key(),
            version("/two/Screenshot.png", Some(1)).key(),
            "two folders can each hold a Screenshot.png",
        );
    }

    #[test]
    fn a_version_key_is_a_legal_fixed_width_name() {
        // A path is not a legal directory name on every platform, and
        // `poster.rs` matches cached frames by *prefix* — a variable-length key
        // would let one capture's sweep match another's.
        for source in [
            r"C:\Users\someone\Pictures\a b.png",
            "/home/someone/图片/截图.png",
        ] {
            let key = version(source, Some(7)).key();
            assert_eq!(key.len(), 16);
            assert!(key.chars().all(|c| c.is_ascii_hexdigit()), "{key}");
        }
    }

    #[test]
    fn a_capture_with_no_readable_timestamp_still_has_a_version() {
        let key = version("/p/shot.png", None).key();
        assert_eq!(key.len(), 16);
    }

    #[test]
    fn a_cache_under_its_limit_is_left_alone() {
        let entries = vec![entry(1, "a"), entry(2, "b")];
        assert!(overflow(entries, 5).is_empty());
    }

    #[test]
    fn a_cache_exactly_at_its_limit_is_left_alone() {
        let entries = vec![entry(1, "a"), entry(2, "b")];
        assert!(
            overflow(entries, 2).is_empty(),
            "at the limit is not over it"
        );
    }

    #[test]
    fn the_oldest_entries_are_the_ones_dropped() {
        // The property with a direction, and the only one that can be silently
        // backwards. Reversed, a sweep evicts the frames of the recordings
        // currently on the shelf and pays an ffmpeg run to rebuild each of
        // them — every half hour, for as long as the app is running.
        let entries = vec![
            entry(300, "newest"),
            entry(100, "oldest"),
            entry(200, "middle"),
        ];

        let dropped = overflow(entries, 1);

        assert_eq!(
            dropped,
            vec![PathBuf::from("oldest"), PathBuf::from("middle")],
            "oldest first, and the newest survives",
        );
    }

    #[test]
    fn a_sweep_removes_exactly_the_excess() {
        let entries: Vec<_> = (0..10).map(|n| entry(n, &format!("e{n}"))).collect();
        assert_eq!(overflow(entries, 4).len(), 6);
    }

    #[test]
    fn a_file_cache_and_a_directory_cache_sweep_their_own_kind() {
        // The two callers differ in exactly this, and a rule shared between
        // them has to keep the difference rather than average it.
        let root = std::env::temp_dir().join(format!("shotshelf-cache-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("a temp dir");

        let file = root.join("frame.jpg");
        let folder = root.join("copy");
        std::fs::write(&file, b"jpeg").expect("a file");
        std::fs::create_dir_all(&folder).expect("a directory");

        // A limit of zero: everything of the swept kind must go, and nothing
        // of the other kind may.
        prune(&root, 0, Entry::File);
        assert!(!file.exists(), "the file cache swept its file");
        assert!(folder.is_dir(), "and left a directory alone");

        std::fs::write(&file, b"jpeg").expect("a file again");
        prune(&root, 0, Entry::Directory);
        assert!(!folder.exists(), "the directory cache swept its directory");
        assert!(file.is_file(), "and left a file alone");

        let _ = std::fs::remove_dir_all(&root);
    }
}
