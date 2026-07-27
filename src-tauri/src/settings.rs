//! What the shelf remembers between launches.
//!
//! A single JSON file in the OS config directory — no accounts, no sync, no
//! network, and deliberately few knobs. It holds where the shelf sits, how long
//! captures stay, the toggle shortcut, and the paths of pinned items. Capture
//! *contents* are never written here; only paths and a little metadata.

use std::{
    path::PathBuf,
    sync::{Mutex, MutexGuard},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};

use crate::catch::CaptureKind;

/// Ctrl+Shift+S on Windows, ⌘⇧S on macOS.
///
/// Registering this globally means the combination stops reaching other apps,
/// and on macOS ⌘⇧S is Save As almost everywhere — so it is the first thing
/// worth changing if it gets in the way. It is a setting for that reason.
pub const DEFAULT_HOTKEY: &str = "CommandOrControl+Shift+S";

/// Which screen edge the shelf docks to. The shelf is a tall narrow strip, so
/// only the two vertical edges make sense for it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Edge {
    Left,
    #[default]
    Right,
}

/// A pinned capture, restored onto the shelf on the next launch.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PinnedItem {
    pub path: String,
    pub kind: CaptureKind,
    pub ts: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    pub edge: Edge,
    /// Monitor name to dock to. `None`, or a monitor that has since been
    /// unplugged, falls back to wherever the shelf already is.
    pub monitor: Option<String>,
    /// Unpinned captures leave the shelf after this long. `None` keeps them
    /// until the shelf is closed. Fractional values are honoured, which is the
    /// only practical way to exercise expiry without waiting an hour.
    pub retention_hours: Option<f64>,
    /// Hard ceiling on unpinned captures, whatever the retention window.
    pub max_items: usize,
    pub hotkey: String,
    pub pinned: Vec<PinnedItem>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            edge: Edge::default(),
            monitor: None,
            retention_hours: None,
            max_items: 50,
            hotkey: DEFAULT_HOTKEY.to_owned(),
            pinned: Vec::new(),
        }
    }
}

/// In-memory copy of the file, so placement and the hotkey can be read without
/// touching the disk on every window event.
pub struct SettingsStore {
    path: PathBuf,
    current: Mutex<Settings>,
}

impl SettingsStore {
    pub fn get(&self) -> Settings {
        self.lock().clone()
    }

    /// Replace the settings and write them out. Returns what was actually
    /// stored so the caller can see any clamping applied.
    pub fn replace(&self, next: Settings) -> Settings {
        let next = sanitise(next);
        *self.lock() = next.clone();
        self.persist(&next);
        next
    }

    /// Narrower edit for the pin toggle, which the settings surface never touches.
    pub fn set_pinned(&self, pinned: Vec<PinnedItem>) {
        let snapshot = {
            let mut current = self.lock();
            current.pinned = pinned;
            current.clone()
        };
        self.persist(&snapshot);
    }

    fn persist(&self, settings: &Settings) {
        if let Err(err) = write(&self.path, settings) {
            eprintln!("shotshelf: could not save settings: {err}");
        }
    }

    fn lock(&self) -> MutexGuard<'_, Settings> {
        self.current
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// Load the settings file, falling back to defaults for anything missing or
/// unreadable — a corrupt settings file should cost you your preferences, not
/// your shelf.
pub fn load<R: Runtime>(app: &AppHandle<R>) -> SettingsStore {
    let path = settings_path(app);

    let current = path
        .as_ref()
        .and_then(|path| std::fs::read_to_string(path).ok())
        // This file is meant to be hand-edited, and plenty of editors —
        // Notepad, PowerShell's `Set-Content -Encoding utf8` — write a UTF-8
        // BOM that serde_json rejects outright. Losing someone's settings over
        // an invisible three bytes is not acceptable.
        .and_then(
            |raw| match serde_json::from_str::<Settings>(strip_bom(&raw)) {
                Ok(settings) => Some(settings),
                Err(err) => {
                    eprintln!("shotshelf: settings file unreadable, using defaults: {err}");
                    None
                }
            },
        )
        .unwrap_or_default();

    let store = SettingsStore {
        path: path.unwrap_or_default(),
        current: Mutex::new(sanitise(current)),
    };

    // Write the defaults out on first run so the file is there to be found and
    // hand-edited, rather than appearing only once something is changed.
    if !store.path.as_os_str().is_empty() && !store.path.exists() {
        store.persist(&store.get());
    }

    store
}

/// Where the file lives: `%APPDATA%\com.mogginglabs.shotshelf\settings.json` on
/// Windows, `~/Library/Application Support/com.mogginglabs.shotshelf/settings.json`
/// on macOS.
fn settings_path<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    let dir = app.path().app_config_dir().ok()?;
    Some(dir.join("settings.json"))
}

fn strip_bom(raw: &str) -> &str {
    raw.strip_prefix('\u{feff}').unwrap_or(raw)
}

fn write(path: &PathBuf, settings: &Settings) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string_pretty(settings)?;
    std::fs::write(path, json)
}

/// Keep hand-edited files from producing a shelf that holds nothing or never
/// forgets anything.
fn sanitise(mut settings: Settings) -> Settings {
    settings.max_items = settings.max_items.clamp(1, 200);
    settings.retention_hours = settings
        .retention_hours
        .filter(|hours| hours.is_finite() && *hours > 0.0);
    if settings.hotkey.trim().is_empty() {
        settings.hotkey = DEFAULT_HOTKEY.to_owned();
    }
    settings
}

#[tauri::command]
pub fn get_settings(store: tauri::State<'_, SettingsStore>) -> Settings {
    store.get()
}

/// Applies the new settings as well as storing them, so the shelf moves and the
/// shortcut re-registers without a restart.
#[tauri::command]
pub fn set_settings<R: Runtime>(
    app: AppHandle<R>,
    store: tauri::State<'_, SettingsStore>,
    settings: Settings,
) -> Result<Settings, String> {
    let previous = store.get();
    let candidate = sanitise(settings);

    // Re-register before storing: a shortcut another app owns must not be
    // written to the file as though it took.
    if candidate.hotkey != previous.hotkey {
        crate::hotkey::rebind(&app, &previous.hotkey, &candidate.hotkey)?;
    }

    let stored = store.replace(candidate);

    if let Some(shelf) = app.get_webview_window(crate::window::SHELF) {
        crate::window::dock(&shelf, &stored);
    }

    Ok(stored)
}

#[tauri::command]
pub fn set_pinned(store: tauri::State<'_, SettingsStore>, pinned: Vec<PinnedItem>) {
    store.set_pinned(pinned);
}

/// The monitors the shelf could be docked to, for the settings surface.
#[tauri::command]
pub fn list_monitors<R: Runtime>(app: AppHandle<R>) -> Vec<String> {
    let Some(shelf) = app.get_webview_window(crate::window::SHELF) else {
        return Vec::new();
    };

    shelf
        .available_monitors()
        .map(|monitors| {
            monitors
                .into_iter()
                .filter_map(|monitor| monitor.name().cloned())
                .collect()
        })
        .unwrap_or_default()
}
