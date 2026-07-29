//! Poster frames and metadata for recordings.
//!
//! A recording is just a file until you can see what is in it, so every video
//! capture gets one frame pulled out with the bundled ffmpeg sidecar. The
//! binary ships inside the app — nothing is ever fetched at runtime, and
//! ffmpeg only ever reads the local file it is pointed at.
//!
//! The source recording is never modified: ffmpeg writes its frame into the
//! app cache directory and nowhere else.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_shell::{process::CommandEvent, ShellExt};

use crate::webview_path::existing_file;

/// Seek before grabbing the frame — the opening frame of a screen recording is
/// very often black, a fade-in, or a desktop mid-redraw.
const SEEK_SECONDS: &str = "1";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoDetails {
    /// Cached poster frame, absent if ffmpeg could not produce one. The tile
    /// keeps its film glyph in that case.
    pub poster: Option<String>,
    pub duration_ms: Option<u64>,
    pub bytes: u64,
}

/// Keep at most this many cached frames.
///
/// Sized against what the shelf can actually hold, which is more than the item
/// cap: pins are exempt from it, so `max_items` (up to 200) plus `MAX_PINNED`
/// (500) is 700 tiles. The old number was 200, justified by "a shelf capped at
/// 200 items cannot legitimately need more" — which was simply wrong about
/// pins, and meant a shelf with many pinned recordings evicted frames that
/// were still on screen and re-derived them with ffmpeg every half hour.
///
/// Derived rather than copied. Both numbers were written out here by hand
/// while living private in `settings.rs`, so raising the item cap would have
/// made 750 too small and this paragraph false — and re-introduced the exact
/// failure it records. The margin stays a decision made here.
const POSTER_CACHE_LIMIT: usize = crate::cache::shelf_wide_limit();

/// Drop the oldest cached frames. Called on a timer from `lib.rs`.
///
/// Frames are deleted when their tile leaves the shelf, but that relies on
/// every route out remembering to ask — and one of them didn't. This is the
/// backstop: the cache is ours, it is derived data, and nothing here can cost
/// anyone a capture.
pub fn prune_cache<R: Runtime>(app: &AppHandle<R>) {
    let Ok(dir) = poster_dir(app) else { return };
    // One file per recording. Through `cache::prune`, shared with the hand-off
    // cache — see that module for why the sort direction is the thing worth
    // testing.
    crate::cache::prune(&dir, POSTER_CACHE_LIMIT, crate::cache::Entry::File);
}

/// Poster frames are rendered through the asset protocol like any other
/// capture, so the cache directory needs the same grant the watched folders
/// get — without it the shelf silently shows broken images.
pub fn allow_reading_posters<R: Runtime>(app: &AppHandle<R>) {
    match poster_dir(app) {
        Ok(dir) => {
            // A cache Shotshelf writes itself; the folder is the unit.
            #[allow(clippy::disallowed_methods)]
            if let Err(err) = app.asset_protocol_scope().allow_directory(&dir, false) {
                crate::diag::warn(&format!("poster frames will not display: {err}"));
            }
        }
        Err(err) => crate::diag::warn(&format!("no poster cache directory: {err}")),
    }
}

/// Async so ffmpeg runs off the UI thread; the tile updates when it lands.
#[tauri::command]
pub async fn video_details<R: Runtime>(
    app: AppHandle<R>,
    path: String,
) -> Result<VideoDetails, String> {
    // Both of this module's commands take a path from the webview and used
    // to go straight to `fs::metadata`, with none of the checking its
    // siblings in `share.rs` and `edit.rs` do.
    let source = existing_file(&app, &path)?;

    // The filesystem prelude runs on a blocking worker, not on the runtime.
    //
    // `metadata`, `create_dir_all` and a `read_dir` over up to 750 cache
    // entries, once per video tile — and the shelf builds every tile at once.
    // `edit.rs` was moved off the runtime for exactly this, and this function
    // was named in the same finding; only one of the two was fixed then.
    let lookup_app = app.clone();
    let lookup_source = source.clone();
    let (bytes, key, dir, hit) = tauri::async_runtime::spawn_blocking(move || {
        let meta = std::fs::metadata(&lookup_source).map_err(|err| err.to_string())?;
        let bytes = meta.len();
        let key = cache_key(&lookup_source, &meta);
        let dir = poster_dir(&lookup_app)?;
        // Keyed on path *and* mtime, so a re-recorded file gets a fresh frame
        // but relaunching the app reuses what is already there.
        let hit = cached(&dir, &key);
        Ok::<_, String>((bytes, key, dir, hit))
    })
    .await
    .map_err(|err| err.to_string())??;

    if let Some((poster, duration_ms)) = hit {
        return Ok(VideoDetails {
            poster: Some(poster.to_string_lossy().into_owned()),
            duration_ms,
            bytes,
        });
    }

    // ffmpeg writes the frame itself. Piping it back through the sidecar's
    // stdout corrupts the JPEG — the bytes come through mangled — so the only
    // thing that crosses that boundary is stderr, which is text by nature.
    // Named per *operation*, not per recording.
    //
    // `video_details` is reachable once per tile and the shelf builds every
    // tile at once, so two calls for one recording overlap routinely — and a
    // shared staging name let the second ffmpeg truncate the file the first
    // had finished, whereupon the first's `rename` published a partial JPEG.
    // `handoff.rs` documents this exact race and solves it with a nonce; this
    // module predates that pass and did not receive it until now.
    static NONCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let ticket = NONCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let staged = dir.join(format!("{key}.{ticket}.staging.jpg"));
    let duration_ms = extract_frame(&app, &source, &staged).await;

    // Named only once the length is known, so a cache hit never needs a second
    // ffmpeg run just to say how long the clip is.
    let poster = if has_frame(&staged) {
        let target = dir.join(cache_name(&key, duration_ms));
        std::fs::rename(&staged, &target).map_err(|err| err.to_string())?;
        Some(target.to_string_lossy().into_owned())
    } else {
        let _ = std::fs::remove_file(&staged);
        None
    };

    Ok(VideoDetails {
        poster,
        duration_ms,
        bytes,
    })
}

/// Drop a recording's cached frame once its tile leaves the shelf. Only ever
/// touches the cache — the recording itself is not ours to delete.
#[tauri::command]
pub fn forget_video<R: Runtime>(app: AppHandle<R>, path: String) {
    let Ok(dir) = poster_dir(&app) else { return };
    let Ok(source) = existing_file(&app, &path) else {
        return;
    };
    let Ok(meta) = std::fs::metadata(&source) else {
        return;
    };

    let prefix = cache_prefix(&cache_key(&source, &meta));
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return;
    };

    for entry in entries.flatten() {
        if entry.file_name().to_string_lossy().starts_with(&prefix) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// Pulls one frame into `target` and reports the clip's length. A recording
/// that will not decode still belongs on the shelf as a draggable file, so
/// every failure here is quiet.
async fn extract_frame<R: Runtime>(
    app: &AppHandle<R>,
    source: &Path,
    target: &Path,
) -> Option<u64> {
    let mut duration_ms = None;

    // A clip shorter than the seek point yields no frame at all, so fall back
    // to the very first one.
    for seek in [SEEK_SECONDS, "0"] {
        match run_ffmpeg(app, source, seek, target).await {
            Ok(reported) => {
                duration_ms = duration_ms.or(reported);
                if has_frame(target) {
                    return duration_ms;
                }
            }
            Err(err) => {
                // The filename only, for the reason `catch/mod.rs` gives: a
                // capture's path carries client and project names, and this
                // now goes to a file that outlives the session.
                crate::diag::warn(&format!(
                    "no poster frame for {}: {err}",
                    source.file_name().unwrap_or_default().to_string_lossy()
                ));
                return duration_ms;
            }
        }
    }

    duration_ms
}

async fn run_ffmpeg<R: Runtime>(
    app: &AppHandle<R>,
    source: &Path,
    seek: &str,
    target: &Path,
) -> Result<Option<u64>, String> {
    // Start each attempt from nothing, so a leftover file can't read as success.
    let _ = std::fs::remove_file(target);

    let source_arg = source.to_string_lossy().into_owned();
    let target_arg = target.to_string_lossy().into_owned();

    // No more than a few at a time, and never forever.
    //
    // The scan path got both of these — a semaphore of 2 (in `share.rs`) and a
    // deadline — and this did not, though it spawns an external process per
    // tile and the shelf builds every tile at once. A malformed container that
    // wedges ffmpeg held a task for the life of the app.
    let _permit = frame_limit()
        .clone()
        .acquire_owned()
        .await
        .map_err(|err| err.to_string())?;

    let run = app
        .shell()
        .sidecar("ffmpeg")
        .map_err(|err| err.to_string())?
        .args([
            "-hide_banner",
            "-nostdin",
            "-y",
            // Seeking before -i is the fast path: ffmpeg jumps rather than
            // decoding everything up to that point.
            "-ss",
            seek,
            "-i",
            &source_arg,
            "-frames:v",
            "1",
            "-q:v",
            "4",
            &target_arg,
        ])
        .spawn()
        .map_err(|err| err.to_string())?;

    // Spawned rather than awaited to completion, because the deadline has to
    // reach the *process*.
    //
    // `timeout` on `.output()` drops the future and nothing else: the plugin's
    // `CommandChild` has no `Drop` that kills, so a wedged ffmpeg kept running
    // — still holding CPU, still able to be writing into the staging file this
    // function is about to publish or delete. `ocr.rs` gets this right with an
    // explicit `kill()`; this module had the deadline and not the kill.
    let (mut events, child) = run;
    let mut stderr = Vec::new();

    let collect = async {
        while let Some(event) = events.recv().await {
            match event {
                CommandEvent::Stderr(chunk) => stderr.extend_from_slice(&chunk),
                CommandEvent::Terminated(_) => break,
                _ => {}
            }
        }
        stderr
    };

    match tokio::time::timeout(crate::limits::FRAME_TIMEOUT, collect).await {
        Ok(stderr) => Ok(parse_duration(&String::from_utf8_lossy(&stderr))),
        Err(_) => {
            // Killed and then given a moment to actually die. `kill` only
            // signals; without the pause the caller went straight on to decide
            // whether to publish the staging file, which the dying process may
            // still have been writing into.
            let _ = child.kill();
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            Err("ffmpeg took too long on this recording".to_owned())
        }
    }
}

/// How many recordings may be decoded at once — see `limits::FRAMES`, which
/// holds this bound beside the other two so the set can be read together.
fn frame_limit() -> &'static std::sync::Arc<tokio::sync::Semaphore> {
    static LIMIT: std::sync::OnceLock<std::sync::Arc<tokio::sync::Semaphore>> =
        std::sync::OnceLock::new();
    crate::limits::shared(&LIMIT, crate::limits::FRAMES)
}

fn has_frame(target: &Path) -> bool {
    // A JPEG, not merely a non-empty file.
    //
    // Length alone published whatever a killed ffmpeg had managed to write:
    // the timeout kills the process, but a truncated file is still non-empty,
    // and the rename that follows caches it under path+mtime for that file's
    // life. Two bytes of magic is the difference between "a frame" and
    // "something was there".
    let Ok(bytes) = std::fs::read(target) else {
        return false;
    };
    bytes.len() > 2 && bytes[0] == 0xFF && bytes[1] == 0xD8
}

/// ffmpeg reports `Duration: 00:00:12.34, start: ...` on stderr. A stream with
/// no known length says `N/A`, which simply fails to parse.
fn parse_duration(stderr: &str) -> Option<u64> {
    let value = stderr.split("Duration: ").nth(1)?.split(',').next()?.trim();

    let mut parts = value.split(':');
    let hours: u64 = parts.next()?.trim().parse().ok()?;
    let minutes: u64 = parts.next()?.trim().parse().ok()?;
    let seconds: f64 = parts.next()?.trim().parse().ok()?;

    // Whole seconds stay in `u64` and only the fraction goes through `f64`,
    // so nothing depends on a 52-bit mantissa holding an hour count. The old
    // form converted `hours * 3600 + minutes * 60` to `f64` and back, which is
    // exact for any duration ffmpeg will ever report but for no stated reason.
    let whole = hours * 3600 + minutes * 60;
    let fraction = seconds.max(0.0);
    // `max(0.0)` is the guard, and clippy cannot see through it either.
    // ffmpeg reports a duration in seconds; `max(0.0)` is the lower guard and
    // no recording is 2^64 seconds long.
    #[allow(clippy::cast_sign_loss, clippy::cast_possible_truncation)]
    let extra = fraction as u64;
    // Whole seconds, as before: the badge reads "1:23", so the sub-second part
    // has never been shown and the test below pins the truncation. What changed
    // is only that the hour count no longer makes a round trip through `f64`.
    Some((whole + extra) * 1000)
}

fn cached(dir: &Path, key: &str) -> Option<(PathBuf, Option<u64>)> {
    let prefix = cache_prefix(key);

    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(suffix) = name.strip_prefix(&prefix) else {
            continue;
        };
        let duration_ms = suffix.trim_end_matches(".jpg").parse::<u64>().ok();
        return Some((entry.path(), duration_ms));
    }

    None
}

/// What every cached frame for one capture is named with.
///
/// The one place the layout is written. It had three copies — here, in
/// `cached`, and in `forget_video` — and the joining test only reached two of
/// them, so a change to the naming would have left `forget_video` matching
/// nothing and quietly leaking a frame per removed recording.
///
/// The trailing separator is deliberate and load-bearing twice over. It ends
/// the fixed-width key so `_na` cannot be read as part of it, and it is `_`
/// where the staging name uses `.` — which is what keeps a half-written frame
/// out of both `cached`'s scan and `forget_video`'s sweep.
fn cache_prefix(key: &str) -> String {
    format!("{key}_")
}

/// Duration rides along in the file name so a cache hit needs no second ffmpeg
/// run just to say how long the clip is.
fn cache_name(key: &str, duration_ms: Option<u64>) -> String {
    let prefix = cache_prefix(key);
    match duration_ms {
        Some(ms) => format!("{prefix}{ms}.jpg"),
        None => format!("{prefix}na.jpg"),
    }
}

/// Which *version of which file* a cached frame belongs to.
///
/// Through `cache::Version`, shared with the hand-off and scan caches. This
/// keyed on **seconds** while `handoff.rs` cited it as the precedent for
/// keying on milliseconds — so re-recording within one second served the
/// previous clip's frame, in the cache being held up as the example of not
/// doing that. It also used `DefaultHasher`, whose algorithm std does not
/// promise to keep stable between releases: a toolchain upgrade would have
/// silently invalidated every cached frame.
fn cache_key(source: &Path, meta: &std::fs::Metadata) -> String {
    crate::cache::Version::from_meta(source, meta).key()
}

fn poster_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    crate::dirs::cache(app, "posters")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_duration_ffmpeg_prints() {
        let stderr = "  Duration: 00:00:12.34, start: 0.000000, bitrate: 1234 kb/s";
        assert_eq!(parse_duration(stderr), Some(12_000));

        let long = "  Duration: 01:02:03.00, start: 0.000000";
        assert_eq!(parse_duration(long), Some(3_723_000));
    }

    #[test]
    fn survives_a_stream_with_no_known_length() {
        // Live captures and some containers report this rather than a time.
        assert_eq!(parse_duration("  Duration: N/A, start: 0.000000"), None);
        assert_eq!(parse_duration("no duration here at all"), None);
    }

    #[test]
    fn a_truncated_frame_is_not_a_frame() {
        // ffmpeg killed on the timeout leaves a non-empty file, and the rename
        // that follows would cache it under path+mtime for that file's whole
        // life — a permanently broken thumbnail with no way to retry.
        //
        // Named separately because nothing reached this predicate at all: the
        // two magic bytes could be deleted, leaving a bare length check, with
        // the suite green. That is the entire difference between "a frame" and
        // "something was there".
        // The module idiom: a process-scoped directory under the system temp,
        // rather than a new dependency for one test.
        let dir = std::env::temp_dir().join(format!("shotshelf-frame-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("a scratch directory");

        let missing = dir.join("absent.jpg");
        assert!(
            !has_frame(&missing),
            "a file that is not there is not a frame"
        );

        let empty = dir.join("empty.jpg");
        std::fs::write(&empty, b"").expect("write");
        assert!(!has_frame(&empty), "an empty file is not a frame");

        // Non-empty, and long enough to pass a length check on its own — this
        // is what a killed ffmpeg actually leaves behind.
        let garbage = dir.join("killed.jpg");
        std::fs::write(&garbage, b"not a jpeg at all").expect("write");
        assert!(!has_frame(&garbage), "length alone is not the test");

        // The JPEG start-of-image marker, and nothing else about the file is
        // valid — which is the point: this predicate decides "did ffmpeg begin
        // writing a JPEG", not "is this a whole image".
        let real = dir.join("frame.jpg");
        std::fs::write(&real, [0xFF, 0xD8, 0xFF, 0xE0, 0x00]).expect("write");
        assert!(has_frame(&real), "a JPEG header is a frame");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn duration_survives_a_round_trip_through_the_cache_name() {
        // The length rides in the filename so a cache hit needs no second
        // ffmpeg run; a mismatch here would silently show the wrong duration.
        // Through `cache_prefix`, not a fourth hand-written copy of the
        // layout: writing the literal again here made the test agree with
        // itself rather than with the code that reads these names.
        let name = cache_name("deadbeef00000000", Some(8_000));
        let suffix = name
            .strip_prefix(&cache_prefix("deadbeef00000000"))
            .expect("prefix must match what `cached` looks for");
        assert_eq!(
            suffix.trim_end_matches(".jpg").parse::<u64>().ok(),
            Some(8_000)
        );
    }

    #[test]
    fn an_unknown_duration_still_produces_a_usable_name() {
        let name = cache_name("0000000000000001", None);
        assert!(name.ends_with("_na.jpg"));
        assert!(name.starts_with(&cache_prefix("0000000000000001")));
    }

    #[test]
    fn every_reader_of_the_cache_agrees_on_one_name() {
        // `cached` finds a frame, `forget_video` deletes one, `cache_name`
        // writes one — three call sites that must agree exactly. They held
        // three separate copies of the layout, and the tests above reached
        // only two of them, so a change here would have left `forget_video`
        // matching nothing: every removed recording leaking its frame, for
        // the life of the cache.
        let key = "0123456789abcdef";
        let prefix = cache_prefix(key);

        // The layout, written out once. Every other assertion in this module
        // calls `cache_prefix` on both sides of the comparison, which agrees
        // with itself for *any* implementation: make it return `""` and each
        // one still passes, because `starts_with("")` is true of every string.
        // Deleting the discriminator that keeps one capture's sweep off
        // another's frames was a green change. This is the one place the shape
        // is stated rather than re-derived.
        assert_eq!(prefix, "0123456789abcdef_");

        assert!(cache_name(key, Some(1)).starts_with(&prefix));
        assert!(cache_name(key, None).starts_with(&prefix));

        // A different capture's frames must not be swept by this one's
        // prefix — the key is fixed-width precisely so it cannot be.
        assert!(!cache_name("0123456789abcdee", Some(1)).starts_with(&prefix));

        // And the staged, half-written frame is matched by none of them: it
        // separates with `.` where a finished one uses `_`.
        let staged = format!("{key}.7.staging.jpg");
        assert!(
            !staged.starts_with(&prefix),
            "a partial frame must not be served as a cache hit or swept as a finished one",
        );
    }
}
