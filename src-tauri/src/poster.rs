//! Poster frames and metadata for recordings.
//!
//! A recording is just a file until you can see what is in it, so every video
//! capture gets one frame pulled out with the bundled ffmpeg sidecar. The
//! binary ships inside the app — nothing is ever fetched at runtime, and
//! ffmpeg only ever reads the local file it is pointed at.
//!
//! The source recording is never modified: ffmpeg writes its frame into the
//! app cache directory and nowhere else.

use std::{
    collections::hash_map::DefaultHasher,
    hash::{Hash, Hasher},
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_shell::ShellExt;

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

/// Poster frames are rendered through the asset protocol like any other
/// capture, so the cache directory needs the same grant the watched folders
/// get — without it the shelf silently shows broken images.
pub fn allow_reading_posters<R: Runtime>(app: &AppHandle<R>) {
    match poster_dir(app) {
        Ok(dir) => {
            if let Err(err) = app.asset_protocol_scope().allow_directory(&dir, false) {
                eprintln!("shotshelf: poster frames will not display: {err}");
            }
        }
        Err(err) => eprintln!("shotshelf: no poster cache directory: {err}"),
    }
}

/// Async so ffmpeg runs off the UI thread; the tile updates when it lands.
#[tauri::command]
pub async fn video_details<R: Runtime>(
    app: AppHandle<R>,
    path: String,
) -> Result<VideoDetails, String> {
    let source = PathBuf::from(&path);
    let meta = std::fs::metadata(&source).map_err(|err| err.to_string())?;
    let bytes = meta.len();

    let key = cache_key(&source, &meta);
    let dir = poster_dir(&app)?;

    // Keyed on path *and* mtime, so a re-recorded file gets a fresh frame but
    // relaunching the app reuses what is already there.
    if let Some((poster, duration_ms)) = cached(&dir, key) {
        return Ok(VideoDetails {
            poster: Some(poster.to_string_lossy().into_owned()),
            duration_ms,
            bytes,
        });
    }

    // ffmpeg writes the frame itself. Piping it back through the sidecar's
    // stdout corrupts the JPEG — the bytes come through mangled — so the only
    // thing that crosses that boundary is stderr, which is text by nature.
    let staged = dir.join(format!("{key:016x}.staging.jpg"));
    let duration_ms = extract_frame(&app, &source, &staged).await;

    // Named only once the length is known, so a cache hit never needs a second
    // ffmpeg run just to say how long the clip is.
    let poster = if has_frame(&staged) {
        let target = dir.join(cache_name(key, duration_ms));
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
    let source = PathBuf::from(&path);
    let Ok(meta) = std::fs::metadata(&source) else {
        return;
    };

    let prefix = format!("{:016x}_", cache_key(&source, &meta));
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
                eprintln!("shotshelf: no poster frame for {}: {err}", source.display());
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

    let output = app
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
        .output()
        .await
        .map_err(|err| err.to_string())?;

    Ok(parse_duration(&String::from_utf8_lossy(&output.stderr)))
}

fn has_frame(target: &Path) -> bool {
    std::fs::metadata(target)
        .map(|meta| meta.len() > 0)
        .unwrap_or(false)
}

/// ffmpeg reports `Duration: 00:00:12.34, start: ...` on stderr. A stream with
/// no known length says `N/A`, which simply fails to parse.
fn parse_duration(stderr: &str) -> Option<u64> {
    let value = stderr.split("Duration: ").nth(1)?.split(',').next()?.trim();

    let mut parts = value.split(':');
    let hours: u64 = parts.next()?.trim().parse().ok()?;
    let minutes: u64 = parts.next()?.trim().parse().ok()?;
    let seconds: f64 = parts.next()?.trim().parse().ok()?;

    Some(((hours * 3600 + minutes * 60) as f64 + seconds).max(0.0) as u64 * 1000)
}

fn cached(dir: &Path, key: u64) -> Option<(PathBuf, Option<u64>)> {
    let prefix = format!("{key:016x}_");

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

/// Duration rides along in the file name so a cache hit needs no second ffmpeg
/// run just to say how long the clip is.
fn cache_name(key: u64, duration_ms: Option<u64>) -> String {
    match duration_ms {
        Some(ms) => format!("{key:016x}_{ms}.jpg"),
        None => format!("{key:016x}_na.jpg"),
    }
}

fn cache_key(source: &Path, meta: &std::fs::Metadata) -> u64 {
    let mut hasher = DefaultHasher::new();
    source.hash(&mut hasher);
    if let Ok(modified) = meta.modified() {
        if let Ok(since) = modified.duration_since(UNIX_EPOCH) {
            since.as_secs().hash(&mut hasher);
        }
    }
    hasher.finish()
}

fn poster_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|err| err.to_string())?
        .join("posters");
    std::fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    Ok(dir)
}
