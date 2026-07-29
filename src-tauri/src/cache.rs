//! Two things every derived-data cache here needs: a way to age out, and a way
//! to say which version of which capture an entry belongs to.
//!
//! Three caches need this — poster frames, sized hand-off copies and credential
//! scans — and all three
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
//! Neither cache can cost anyone a capture: everything *these two prune* is
//! re-derivable,
//! and every path involved is inside a directory the app owns. That is what
//! makes an eviction rule acceptable at all, and it is why the *sort order* is
//! the only thing that can really go wrong.

use std::path::{Path, PathBuf};
use std::time::SystemTime;

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

/// How many entries a cache serving the whole shelf has to hold.
///
/// The largest shelf that can exist, plus room above it so an entry is not
/// evicted while its tile is still on screen.
///
/// One home, because it was written out twice — `POSTER_CACHE_LIMIT` and
/// `SCAN_CACHE_LIMIT`, each with its own `*_MARGIN = 50` — and both files
/// record having *already* been fixed once for hand-writing this number too
/// small. Two copies of a derivation is the same defect one step later: the
/// next `MAX_PINNED` change moves whichever one the author remembered.
pub const fn shelf_wide_limit() -> usize {
    crate::settings::MAX_ITEMS + crate::settings::MAX_PINNED + MARGIN
}

/// Room above the largest shelf that can exist.
///
/// The decision that genuinely belongs here: how much slack a cache keeps so a
/// tile still on screen cannot lose its entry to an eviction.
const MARGIN: usize = 50;

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

/// Make room in a keyed cache for one more entry, oldest first.
///
/// The in-memory twin of [`overflow`], for a cache that is a map rather than a
/// directory: given each key with the sequence number it was remembered at, and
/// how many the cache may hold *after* the insertion, this is the keys to drop.
///
/// Here rather than inline at the one call site, which is why this exists.
/// `share.rs` wrote the eviction as a `while` loop inside a
/// `#[tauri::command]` — a function no test in this crate can call, because it
/// takes an `AppHandle`. Reversing `min_by_key` to `max_by_key` there evicts the
/// **newest** entries, the ones whose tiles are on screen, so a full shelf
/// re-runs OCR on everything visible on every render, forever. Clippy and all
/// 156 tests stayed green. That is verbatim the failure this module's header
/// names, and verbatim the reason `overflow` was split out for the other two
/// caches — the third one never got it.
///
/// The boundary is stated once too. `overflow` keeps `len() <= limit`; the loop
/// evicted at `len() >= limit` *before* inserting, so the two spellings of one
/// rule were an off-by-one apart.
pub fn make_room<K: Clone>(entries: impl Iterator<Item = (K, u64)>, limit: usize) -> Vec<K> {
    let mut seen: Vec<(K, u64)> = entries.collect();
    // Room for the one about to go in.
    let keep = limit.saturating_sub(1);
    if seen.len() <= keep {
        return Vec::new();
    }

    seen.sort_unstable_by_key(|(_, at)| *at);
    let excess = seen.len() - keep;
    seen.into_iter().take(excess).map(|(key, _)| key).collect()
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
/// second is ordinary.
///
/// `Hash` and `Eq` because one caller keys a `HashMap` on this — `share.rs`'s
/// scan cache. The other two turn it into a filename with `key()` and need
/// neither. No `Ord`: it was derived under a comment saying "so callers can
/// compare versions rather than only test equality", and no caller compares.
///
/// Both halves of that were a derive justified by a sentence nobody had
/// checked: the retraction of `Ord` was appended to a claim that all three
/// callers keyed a map, which the retraction's own next clause contradicted.
#[derive(Clone, PartialEq, Eq, Hash, Debug)]
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
    fn a_shelf_wide_cache_holds_more_than_the_largest_shelf() {
        // The derivation that ended two hand-written copies of this number, and
        // nothing read it — `MARGIN` to 0, or `MAX_PINNED` dropped from the sum,
        // both left every test green. Both files this replaced record having
        // *already* been fixed once for hand-writing the number too small, which
        // is a cache that overflows exactly when the shelf it serves is full.
        assert!(
            shelf_wide_limit() > crate::settings::MAX_ITEMS + crate::settings::MAX_PINNED,
            "a full shelf fills the cache that exists to serve it",
        );

        // And the room above it is real, not a rounding: a shelf at its cap plus
        // a handful of arrivals must still not evict a tile that is on screen.
        assert!(
            shelf_wide_limit() >= crate::settings::MAX_ITEMS + crate::settings::MAX_PINNED + 10,
            "the margin is too thin to survive a burst of captures",
        );
    }

    #[test]
    fn making_room_in_a_keyed_cache_drops_the_oldest_too() {
        // The same property with a direction, for the map-shaped cache. It had
        // no test at all: the rule was a `while` loop inside a
        // `#[tauri::command]`, which no test in this crate can call, so
        // reversing it evicted the *newest* entries — the ones whose tiles are
        // on screen — and a full shelf re-ran OCR on all of them on every
        // render. Clippy and every test stayed green.
        // Room is made for the one about to be inserted, so a cache of three
        // with a limit of three loses one — and it is the oldest, whatever
        // order the map hands them back in.
        assert_eq!(
            make_room(vec![("b", 2), ("a", 1), ("c", 3)].into_iter(), 3),
            vec!["a"],
            "the newest entry was evicted",
        );

        // Well under the limit, nothing goes.
        assert!(make_room(vec![("a", 1), ("b", 2)].into_iter(), 9).is_empty());

        // Exactly one short of full, still nothing: the insertion fits.
        assert!(make_room(vec![("a", 1), ("b", 2)].into_iter(), 3).is_empty());

        // Far over — every extra goes, oldest first, and the survivors are the
        // newest.
        assert_eq!(
            make_room(vec![("a", 1), ("b", 2), ("c", 3), ("d", 4)].into_iter(), 2),
            vec!["a", "b", "c"],
        );

        // A limit of zero cannot underflow into "keep everything".
        assert_eq!(make_room(vec![("a", 1)].into_iter(), 0), vec!["a"]);
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
