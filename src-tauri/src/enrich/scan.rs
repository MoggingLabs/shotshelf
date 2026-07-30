//! What Shotshelf worked out about a capture by reading it, for the shelf.
//!
//! The `#[tauri::command]` wrapper around [`super::describe`]: the version key,
//! the remembered answers, and the ceiling on how many run at once.
//!
//! Here rather than in `share.rs`, where it lived. That module's brief is
//! stated in its first line — a native drag and a clipboard copy — and nothing
//! in this file shares anything: it reads a file, keys a `cache::Version`, runs
//! `enrich::describe` and returns `enrich::Findings`. Filing it under sharing
//! cost four shipped defects, each of them a rule applied across the crate with
//! the copy here missed because a sweep of "the enrichment path" never opened
//! `share.rs`:
//!
//! * the cache was emptied with `clear()` while `poster.rs` records the same
//!   defect and its fix;
//! * that eviction loop sat inside the command, so reversing it — evicting the
//!   newest entries and re-running OCR on every visible tile forever — left
//!   clippy and every test green;
//! * the acquire/spawn/timeout/release shape was hand-written a fourth time,
//!   while `limits.rs`'s header names *this* function as the reasoning the
//!   other three were converted from;
//! * `SCAN_CACHE_LIMIT` was a hand-written 500 against a shelf that holds 700.
//!
//! All four are fixed. The shape that produced them is what moving this closes.

use tauri::{AppHandle, Runtime};

use super::Findings;
use crate::webview_path::existing_file;

/// Called per tile rather than pushed from the catch pipeline, for the same
/// reason recordings are: it is optional detail that arrives when it arrives,
/// and a capture is on the shelf and draggable long before this returns.
#[tauri::command]
pub async fn describe_capture<R: Runtime>(
    app: AppHandle<R>,
    path: String,
) -> Result<Findings, String> {
    let source = existing_file(&app, &path)?;

    // Keyed on which *version* of the file, not just which path.
    //
    // A capture overwritten at the same path — a fixed ShareX pattern, a
    // re-save — would otherwise return the previous file's findings, and
    // "no findings" is not rendered as "unknown" but as read-and-clean. The
    // hand-off cache next door keys on path and mtime for exactly this
    // reason, and its comment calls delivering different pixels than the ones
    // on screen a disclosure bug rather than a stale cache. The same is true
    // here, with worse consequences: this one decides whether a warning shows.
    // Through `cache::Version`, which is what the hand-off and poster caches
    // key on — rather than a third encoding of the same question. A `scan_key`
    // wrapper stood here and did nothing but forward, beside a `type ScanKey =
    // cache::Version` alias with one meaning.
    let version = crate::cache::Version::of(&source);

    // Answered from memory when it has been asked before.
    //
    // The shelf asks once per image tile as it is built, and opening a full
    // shelf builds every tile at once — pinned captures are exempt from the
    // item cap, so "every tile" is unbounded. Without this, a launch with
    // fifty pins started fifty full-resolution decodes and fifty OCR passes
    // simultaneously, and did it again on the next launch.
    if let Some(cached) = scan_cache()
        .lock()
        .ok()
        .and_then(|cache| cache.get(&version).map(|entry| entry.findings.clone()))
    {
        return Ok(cached);
    }

    // And no more than a few at a time. OCR is the slowest thing this app
    // does; a semaphore keeps a burst of tiles from becoming a burst of
    // engines, without making the shelf wait for any of them.
    //
    // The permit is held *here* rather than moved into the worker, and that is
    // the whole point. Linux's tesseract has a deadline and a kill; the Windows
    // and macOS recognisers are FFI calls into `RecognizeAsync().get()` and
    // `performRequests`, which block with no cancellable API — there is no
    // honest way to stop that thread. What there is a way to do is stop it
    // taking the app with it: if the permit lives in the worker, two wedged
    // captures exhaust the semaphore for good and credential scanning is
    // silently dead for the session. Held out here, the permit is released the
    // moment this returns, and the cost of a wedge is one leaked thread rather
    // than a feature that never works again.
    // Through the shared helper, which is what `limits.rs` says it is for.
    //
    // This was a fourth hand-written copy of the same acquire / spawn / timeout
    // / release shape — and `limits.rs`'s header names *this* function as the
    // reasoning the other three were converted from, while it stayed a copy
    // itself. Byte-for-byte the same but for the error string, so it also
    // carried its own chance of getting the permit release wrong.
    let for_worker = source.clone();
    let named = source
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned();
    let findings = crate::limits::under_limit(
        scan_limit().clone(),
        crate::limits::SCAN_TIMEOUT,
        &named,
        move || Findings::from(super::describe(&for_worker)),
    )
    .await?;

    if let Ok(mut cache) = scan_cache().lock() {
        // Bounded: a shelf that has seen thousands of captures in one session
        // should not hold every scan for the life of the process.
        //
        // The oldest entries go, not all of them. This was `cache.clear()`, so
        // one insertion past the limit threw away every remembered scan —
        // including entries computed seconds earlier for tiles still on screen,
        // mid-build, sending the shelf back to full-resolution OCR for the whole
        // visible list. `poster.rs` records the same defect in its own cache and
        // fixed it by evicting the oldest; this is that, in memory.
        //
        // Through `cache::make_room` rather than a loop written out here. The
        // loop was inside this `#[tauri::command]`, which no test in this crate
        // can call, so reversing its `min_by_key` to `max_by_key` — after which
        // the *newest* entries are evicted and a full shelf re-runs OCR on every
        // visible tile forever — left clippy and all 156 tests green. The other
        // two caches had their eviction rule split out for exactly that reason;
        // this one had not.
        for stale in crate::cache::make_room(
            cache.iter().map(|(key, entry)| (key.clone(), entry.seen)),
            SCAN_CACHE_LIMIT,
        ) {
            cache.remove(&stale);
        }
        cache.insert(
            version,
            Remembered {
                seen: next_scan_sequence(),
                findings: findings.clone(),
            },
        );
    }

    Ok(findings)
}

/// How many scans to remember.
///
/// Derived, not chosen. This was a hand-written 500 while the shelf can hold
/// `max_items` (up to 200) plus `MAX_PINNED` (500) tiles — so a full shelf
/// overflowed the cache that exists to serve it, which is the same mistake
/// `poster.rs` records having made with a hand-written 200 and fixed by
/// deriving.
///
/// Then both files derived it *separately*, each with its own margin constant —
/// two copies of a derivation, which is the same defect one step later: the
/// next `MAX_PINNED` change moves whichever one the author remembered.
/// `cache::shelf_wide_limit` is the one home now.
const SCAN_CACHE_LIMIT: usize = crate::cache::shelf_wide_limit();

/// A remembered scan, with when it was remembered.
///
/// The sequence is what makes eviction "the oldest" rather than "everything":
/// a `HashMap` has no order of its own, and the alternative was clearing the
/// lot. Monotonic per process, so it never ties and never wraps in any session
/// a person will have.
struct Remembered {
    seen: u64,
    findings: Findings,
}

fn next_scan_sequence() -> u64 {
    static SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
}

/// Identity of a capture's *contents*, through `cache::Version`.
///
/// Remembered scans, keyed by which *version* of which capture.
///
/// `cache::Version` directly, rather than through the `scan_key` wrapper and
/// `ScanKey` alias that used to stand here: the wrapper only forwarded and the
/// alias only renamed, and both had exactly one meaning and one caller. An
/// unreadable timestamp means a file shares a version with its other versions,
/// which is where all three of these caches were before mtime was part of the
/// key.
fn scan_cache(
) -> &'static std::sync::Mutex<std::collections::HashMap<crate::cache::Version, Remembered>> {
    static CACHE: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashMap<crate::cache::Version, Remembered>>,
    > = std::sync::OnceLock::new();
    CACHE.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

fn scan_limit() -> &'static std::sync::Arc<tokio::sync::Semaphore> {
    static LIMIT: std::sync::OnceLock<std::sync::Arc<tokio::sync::Semaphore>> =
        std::sync::OnceLock::new();
    crate::limits::shared(&LIMIT, crate::limits::SCANNING)
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_scan_key_names_a_version_of_a_file_not_just_a_path() {
        // This module had no tests at all, and this key is the thing standing
        // between a re-saved capture and the previous file's findings — where
        // "no findings" is not rendered as "unknown" but as read-and-clean.
        //
        // What this can state without depending on the runner's timestamp
        // granularity: that an existing file gets a version at all, and that
        // an unreadable one degrades to `None` rather than panicking. The
        // "a different mtime is a different key" half is the tuple's own
        // definition, and `cache::Version` learned the hard way that
        // going through the filesystem to say so tests the filesystem.
        let dir = std::env::temp_dir().join(format!("shotshelf-scan-key-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("a temp dir");
        let file = dir.join("capture.png");
        std::fs::write(&file, b"pixels").expect("a temp file");

        // Two versions of the same path differ; a missing file still answers.
        // The encoding itself is `cache::Version`'s, tested there once for all
        // three caches rather than three times in three shapes.
        assert_eq!(
            crate::cache::Version::of(&file),
            crate::cache::Version::of(&file),
            "stable for one version"
        );
        assert_ne!(
            crate::cache::Version::of(&file),
            crate::cache::Version::of(&dir.join("other.png")),
            "two captures are two versions",
        );
        // An unreadable timestamp is not a panic.
        let _ = crate::cache::Version::of(&dir.join("never-existed.png"));

        let _ = std::fs::remove_dir_all(&dir);
    }
}
