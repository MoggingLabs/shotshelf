//! Catch engine — turns OS captures into one `capture://new` event each.
//!
//! Shotshelf is a *watcher*, not a capturer: the OS already writes screenshots
//! and recordings to known folders, and Win+Shift+S / ⌘⌃⇧4 land on the
//! clipboard only. So this module has exactly two inputs —
//! [`folders`] (the `notify` crate) and [`clipboard`]
//! (`tauri-plugin-clipboard`'s native watcher) — and one output, [`CAPTURE_EVENT`].
//!
//! Local-only: everything here reads local files and the local clipboard.

mod clipboard;
mod folders;
mod paths;

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime};

/// Event the shelf front-end listens on. Payload is [`Capture`].
pub const CAPTURE_EVENT: &str = "capture://new";

/// A capture fires once inside this window however many filesystem events the
/// OS produced for it.
const DEDUPE_WINDOW: Duration = Duration::from_secs(3);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CaptureKind {
    Image,
    Video,
}

/// Payload of [`CAPTURE_EVENT`].
#[derive(Debug, Clone, Serialize)]
pub struct Capture {
    /// Absolute path on disk. Stays on the device.
    pub path: String,
    pub kind: CaptureKind,
    /// Unix milliseconds.
    pub ts: u64,
}

/// Classify by extension. `None` means "not a capture" — ignore the file.
pub fn kind_of(path: &Path) -> Option<CaptureKind> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    match ext.as_str() {
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" => Some(CaptureKind::Image),
        "mp4" | "mov" | "mkv" | "webm" => Some(CaptureKind::Video),
        _ => None,
    }
}

/// The one place a capture becomes an event, so de-duplication only has to
/// happen once for both the folder watchers and the clipboard watcher.
#[derive(Default)]
pub struct CaptureSink {
    recent: Mutex<HashMap<PathBuf, Instant>>,
}

impl CaptureSink {
    pub fn emit<R: Runtime>(&self, app: &AppHandle<R>, path: &Path, kind: CaptureKind) {
        if !self.claim(path) {
            return;
        }

        let capture = Capture {
            path: path.display().to_string(),
            kind,
            ts: now_ms(),
        };

        match app.emit(CAPTURE_EVENT, &capture) {
            Ok(()) => println!("shotshelf: caught {:?} {}", kind, capture.path),
            Err(err) => eprintln!("shotshelf: could not emit {CAPTURE_EVENT}: {err}"),
        }
    }

    /// `true` the first time a path shows up inside [`DEDUPE_WINDOW`].
    fn claim(&self, path: &Path) -> bool {
        let mut recent = match self.recent.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        let now = Instant::now();
        recent.retain(|_, seen| now.duration_since(*seen) < DEDUPE_WINDOW);
        // Re-inserting refreshes the timestamp, so a noisy writer stays quiet.
        recent.insert(path.to_path_buf(), now).is_none()
    }
}

/// Keeps the watcher threads alive for the life of the app; held in Tauri state.
pub struct CatchEngine {
    watch_dirs: Vec<PathBuf>,
    /// Dropping the watch stops the `notify` threads.
    _folders: Option<folders::FolderWatch>,
}

/// Start watching. Never fatal: a shelf with a broken watcher is still a shelf,
/// so failures are logged and the rest of the engine carries on.
pub fn start<R: Runtime>(app: &AppHandle<R>, overrides: &[PathBuf]) {
    let watch_dirs = paths::resolve_watch_dirs(app, overrides);
    let sink = std::sync::Arc::new(CaptureSink::default());

    if watch_dirs.is_empty() {
        eprintln!("shotshelf: no capture folders found — clipboard watch only");
    }
    for dir in &watch_dirs {
        println!("shotshelf: watching {}", dir.display());
    }

    let folders = match folders::start(app, &watch_dirs, std::sync::Arc::clone(&sink)) {
        Ok(watch) => Some(watch),
        Err(err) => {
            eprintln!("shotshelf: folder watching unavailable: {err}");
            None
        }
    };

    clipboard::start(app, sink);

    app.manage(CatchEngine {
        watch_dirs,
        _folders: folders,
    });
}

/// Watch-path override. Phase 06 will feed this from the settings file; until
/// then `SHOTSHELF_WATCH_DIRS` (`;`-separated on Windows, `:` elsewhere) is the
/// override hook, and how synthetic fixtures drive the engine in testing.
pub fn overrides_from_env() -> Vec<PathBuf> {
    std::env::var_os("SHOTSHELF_WATCH_DIRS")
        .map(|value| std::env::split_paths(&value).collect())
        .unwrap_or_default()
}

/// Lets the shelf show where it is listening — and phase 06's settings read it back.
#[tauri::command]
pub fn catch_watch_dirs<R: Runtime>(app: AppHandle<R>) -> Vec<String> {
    app.try_state::<CatchEngine>()
        .map(|engine| {
            engine
                .watch_dirs
                .iter()
                .map(|dir| dir.display().to_string())
                .collect()
        })
        .unwrap_or_default()
}

pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|since| since.as_millis() as u64)
        .unwrap_or_default()
}
