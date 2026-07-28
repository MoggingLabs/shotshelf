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
    /// Unpinned captures leave the shelf after this long. `None` keeps them
    /// until the shelf is closed. Fractional values are honoured, which is the
    /// only practical way to exercise expiry without waiting an hour.
    pub retention_hours: Option<f64>,
    /// Hard ceiling on unpinned captures, whatever the retention window.
    pub max_items: usize,
    pub hotkey: String,
    /// Hand over a smaller copy instead of the original.
    ///
    /// Off by default, deliberately. Every vision model resizes what it is
    /// given to roughly 1568px before looking at it, so for feeding a chat
    /// this is free — but a drag-out is also how captures reach design tools
    /// and bug reports, and silently handing someone a downscaled file when
    /// they asked for their screenshot is the kind of surprise that costs
    /// trust. The original is what was asked for until you say otherwise.
    #[serde(default)]
    pub downscale_exports: bool,
    pub pinned: Vec<PinnedItem>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            retention_hours: None,
            max_items: 50,
            hotkey: DEFAULT_HOTKEY.to_owned(),
            downscale_exports: false,
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
    pub fn set_pinned(&self, mut pinned: Vec<PinnedItem>) {
        // Bounded and checked here too: this path skips `sanitise` entirely,
        // which is how the cap on the settings surface would have been missed.
        //
        // The paths arrive from the webview and are written to disk and read
        // back at the next launch, so an unchecked one is a stray string that
        // outlives the session that produced it. Absolute-only is the same
        // rule `webview_path` applies at the read boundary; this is the write
        // boundary, which the read fix did not cover.
        pinned.retain(|item| crate::webview_path::absolute(&item.path).is_ok());
        pinned.truncate(MAX_PINNED);
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
/// The most pinned captures that will be stored.
///
/// Pins are exempt from the item cap by design, but the list arrives from the
/// webview and is written to disk and re-read — and every entry costs a tile
/// and a credential scan at the next launch. Comfortably more than anyone
/// pins on purpose.
const MAX_PINNED: usize = 500;

fn sanitise(mut settings: Settings) -> Settings {
    settings.max_items = settings.max_items.clamp(1, 200);
    settings.pinned.truncate(MAX_PINNED);
    settings.retention_hours = settings
        .retention_hours
        .filter(|hours| hours.is_finite() && *hours > 0.0);
    if settings.hotkey.trim().is_empty() {
        settings.hotkey = DEFAULT_HOTKEY.to_owned();
    }
    settings
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_defaults_are_the_ones_the_front_end_starts_on() {
        // The same shape is declared in Rust and in `src/settings.ts`, because
        // the shelf needs limits before `get_settings` resolves — a capture can
        // land in that window. Nothing checked the two agreed, and they already
        // drifted once: `downscaleExports` shipped typed only in Rust and
        // survived purely because the payload is spread from the raw response.
        //
        // Both sides now assert against `tests/fixtures/default-settings.json`,
        // so a field added to one and forgotten in the other fails here.
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../../tests/fixtures/default-settings.json"))
                .expect("the shared defaults fixture parses");

        let ours = serde_json::to_value(Settings::default()).expect("settings serialise");
        assert_eq!(
            ours, fixture,
            "Rust defaults have drifted from the shared fixture"
        );
    }

    #[test]
    fn a_utf8_bom_does_not_cost_you_your_settings() {
        // Notepad and PowerShell's `Set-Content -Encoding utf8` both write one,
        // and it silently reverted a whole settings file to defaults.
        let raw = "\u{feff}{\"maxItems\":7}";
        let parsed: Settings = serde_json::from_str(strip_bom(raw)).expect("BOM must be tolerated");
        assert_eq!(parsed.max_items, 7);
    }

    #[test]
    fn missing_keys_fall_back_to_defaults() {
        let parsed: Settings = serde_json::from_str("{}").expect("an empty object is valid");
        assert_eq!(parsed.max_items, 50);
        assert_eq!(parsed.hotkey, DEFAULT_HOTKEY);
    }

    #[test]
    fn keys_from_an_older_version_are_ignored_rather_than_fatal() {
        // `edge` and `monitor` existed before the shelf became a popover.
        let raw = r#"{"edge":"left","monitor":"DISPLAY1","maxItems":9}"#;
        let parsed: Settings = serde_json::from_str(raw).expect("old files must still load");
        assert_eq!(parsed.max_items, 9);
    }

    #[test]
    fn hand_edited_nonsense_is_clamped_rather_than_obeyed() {
        let absurd = Settings {
            max_items: 100_000,
            retention_hours: Some(-4.0),
            hotkey: "   ".to_owned(),
            ..Settings::default()
        };

        let safe = sanitise(absurd);
        assert_eq!(safe.max_items, 200, "a shelf cannot hold 100k items");
        assert_eq!(
            safe.retention_hours, None,
            "negative retention is no retention"
        );
        assert_eq!(
            safe.hotkey, DEFAULT_HOTKEY,
            "an empty shortcut is no shortcut"
        );
    }

    #[test]
    fn a_shelf_that_holds_nothing_is_not_a_shelf() {
        let none = sanitise(Settings {
            max_items: 0,
            ..Settings::default()
        });
        assert_eq!(none.max_items, 1);
    }
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

    Ok(store.replace(candidate))
}

#[tauri::command]
pub fn set_pinned(store: tauri::State<'_, SettingsStore>, pinned: Vec<PinnedItem>) {
    store.set_pinned(pinned);
}
