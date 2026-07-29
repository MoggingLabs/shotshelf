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

/// serde needs a function for a non-`false` default.
const fn yes() -> bool {
    true
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
    /// Ask the release feed whether a newer build exists, at launch.
    ///
    /// On by default, and the only network call the app makes. Off means the
    /// app opens no socket at all, which is the point of offering it.
    #[serde(default = "yes")]
    pub check_for_updates: bool,
    pub pinned: Vec<PinnedItem>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            retention_hours: None,
            max_items: 50,
            hotkey: DEFAULT_HOTKEY.to_owned(),
            downscale_exports: false,
            check_for_updates: true,
            pinned: Vec::new(),
        }
    }
}

/// In-memory copy of the file, so placement and the hotkey can be read without
/// touching the disk on every window event.
pub struct SettingsStore {
    /// Preferences. May roam.
    path: PathBuf,
    /// Pinned capture paths. Must not roam — see [`pins_path`].
    pins: PathBuf,
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
        // Through the same function `sanitise` uses. This path skips
        // `sanitise` entirely, which is how a rule applied on the settings
        // surface could miss the pin toggle — and did.
        let snapshot = {
            let mut current = self.lock();
            current.pinned = allowed_pins(pinned);
            current.clone()
        };
        self.persist(&snapshot);
    }

    /// Write both files.
    ///
    /// Two files, because they have different rules about leaving the machine.
    /// The preferences file carries everything except `pinned`; the pins file
    /// carries only `pinned`, and lives where nothing syncs it.
    fn persist(&self, settings: &Settings) {
        let preferences = Settings {
            pinned: Vec::new(),
            ..settings.clone()
        };
        if let Err(err) = write(&self.path, &preferences) {
            crate::diag::warn(&format!("could not save settings: {err}"));
        }
        if let Err(err) = write(&self.pins, &settings.pinned) {
            crate::diag::warn(&format!("could not save pins: {err}"));
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
                    crate::diag::warn(&format!("settings file unreadable, using defaults: {err}"));
                    None
                }
            },
        )
        .unwrap_or_default();

    let pins = pins_path(app);

    // Pins from their own file, falling back to whatever the preferences file
    // still carries.
    //
    // That fallback is the migration: an install from before the split has its
    // pins in `settings.json`, and they are read once, then written to the new
    // file by the `persist` below. Nothing is deleted from the old file by
    // hand — the next write of `settings.json` omits `pinned` anyway, because
    // `persist` blanks it.
    let mut current = current;
    let stored_pins = pins
        .as_ref()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|raw| serde_json::from_str::<Vec<PinnedItem>>(strip_bom(&raw)).ok());
    if let Some(from_own_file) = stored_pins {
        current.pinned = from_own_file;
    }

    let store = SettingsStore {
        path: path.unwrap_or_default(),
        pins: pins.unwrap_or_default(),
        current: Mutex::new(sanitise(current)),
    };

    // Write both out on first run so the files are there to be found and
    // hand-edited, rather than appearing only once something is changed — and
    // so a migrated set of pins lands in its new home immediately.
    let missing = |path: &PathBuf| !path.as_os_str().is_empty() && !path.exists();
    if missing(&store.path) || missing(&store.pins) {
        store.persist(&store.get());
    }

    store
}

/// Where the preferences file lives: `%APPDATA%\com.mogginglabs.shotshelf\`
/// on Windows, `~/Library/Application Support/com.mogginglabs.shotshelf/` on
/// macOS.
///
/// Preferences only. Pinned paths live somewhere else — see [`pins_path`].
fn settings_path<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    let dir = app.path().app_config_dir().ok()?;
    Some(dir.join("settings.json"))
}

/// Where pinned capture paths live: **local** app data, never roaming.
///
/// Split out from the preferences file, which is in `app_config_dir` — and on
/// Windows that is `%APPDATA%`, the *roaming* profile, which a domain roaming
/// profile or Enterprise State Roaming copies to a network share at logoff.
///
/// A hotkey and an item cap can roam; up to `MAX_PINNED` absolute capture
/// paths cannot. This codebase already says so twice, in two other places:
/// `catch/clipboard.rs` rejects that exact directory for clipboard captures in
/// exactly those words, and `catch/mod.rs` refuses to log capture paths because
/// "a capture's path carries client and project names just as readily" as a
/// window title. SECURITY.md's promise is that nothing a capture touches leaves
/// the machine, and five hundred of their paths syncing to a file share is that
/// promise broken by the settings file.
fn pins_path<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    let dir = app.path().app_local_data_dir().ok()?;
    Some(dir.join("pinned.json"))
}

fn strip_bom(raw: &str) -> &str {
    raw.strip_prefix('\u{feff}').unwrap_or(raw)
}

/// Written to a neighbour and renamed into place.
///
/// `fs::write` truncates and then writes, so a crash or a full disk between
/// the two leaves a truncated file — which `load` correctly degrades to
/// defaults, silently costing the user every pin. This is the one file whose
/// loss is visible: `handoff.rs` and `poster.rs` both stage-then-rename and
/// both explain why, and this one did not.
///
/// Three writers still go direct, each for a stated reason: `clipboard.rs` is
/// guarded by a single writer thread and a grace window, `share.rs`'s drag
/// preview is an idempotent icon, and `edit.rs` uses `create_new` — which
/// cannot overwrite — and removes a half-written file itself.
fn write<T: Serialize>(path: &PathBuf, value: &T) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string_pretty(value)?;

    let staged = path.with_extension("json.part");
    std::fs::write(&staged, json)?;
    // A rename is atomic, so the settings file is either the old one or the
    // new one — never half of either.
    if let Err(err) = std::fs::rename(&staged, path) {
        let _ = std::fs::remove_file(&staged);
        return Err(err);
    }
    Ok(())
}

/// The most pinned captures that will be stored.
///
/// Pins are exempt from the item cap by design, but the list arrives from the
/// webview and is written to disk and re-read — and every entry costs a tile
/// and a credential scan at the next launch. Comfortably more than anyone
/// pins on purpose.
const MAX_PINNED: usize = 500;

/// What the item cap may be set to.
///
/// Written here, in `index.html` as the number input's `min`/`max`, and — from
/// this round — in `tests/fixtures/settings-bounds.json`, which is what joins
/// the two. Two hand-maintained copies of one rule in two languages had
/// nothing checking they agreed: raise the clamp and the input still refuses
/// the new values; lower it and the input offers values that are silently
/// clamped with no explanation. The repo already solved this class twice, for
/// the default settings and the secret kinds, and did not extend it here.
const MIN_ITEMS: usize = 1;
const MAX_ITEMS: usize = 200;

/// The pinned list as it is allowed to reach the disk.
///
/// One function because there are two write paths into the same file —
/// `set_pinned` for the pin toggle, and `sanitise` for the settings surface,
/// which carries `pinned` in its payload too. The rule was written out in both
/// and landed in one of them first; a comment then claimed both were covered
/// while the only test called `sanitise`. Joined here so a single test reaches
/// both, and so the next rule added cannot land in one place only.
///
/// Absolute-only is the same rule `webview_path` applies at the read boundary.
/// These paths arrive from the webview and are read back at the next launch,
/// so an unchecked one is a stray string that outlives the session.
fn allowed_pins(mut pinned: Vec<PinnedItem>) -> Vec<PinnedItem> {
    pinned.retain(|item| crate::webview_path::absolute(&item.path).is_ok());
    pinned.truncate(MAX_PINNED);
    pinned
}

/// Keep hand-edited files, and the webview, from producing a shelf that holds
/// nothing, never forgets anything, or remembers a path it cannot use.
fn sanitise(mut settings: Settings) -> Settings {
    settings.max_items = settings.max_items.clamp(MIN_ITEMS, MAX_ITEMS);
    settings.pinned = allowed_pins(std::mem::take(&mut settings.pinned));
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

    fn pin(path: &str) -> PinnedItem {
        PinnedItem {
            path: path.to_owned(),
            kind: CaptureKind::Image,
            ts: 0,
        }
    }

    /// An absolute path that is absolute on the platform running the test.
    fn somewhere(name: &str) -> String {
        if cfg!(windows) {
            format!(r"C:\Users\someone\Pictures\{name}")
        } else {
            format!("/home/someone/Pictures/{name}")
        }
    }

    #[test]
    fn pinned_paths_are_never_written_to_the_roaming_file() {
        // On Windows `app_config_dir` is `%APPDATA%` — the roaming profile,
        // which a domain roaming profile or Enterprise State Roaming copies to
        // a network share at logoff. Up to `MAX_PINNED` absolute capture paths
        // were going there, and a capture's path carries client and project
        // names as readily as a window title does. This codebase rejects that
        // directory for captures in `catch/clipboard.rs` and refuses to log
        // capture paths in `catch/mod.rs`; the settings file was doing both.
        let dir = std::env::temp_dir().join(format!("shotshelf-pins-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("a temp dir");

        let roaming = dir.join("settings.json");
        let local = dir.join("pinned.json");
        let secret = somewhere("acme-migration-plan.png");

        let store = SettingsStore {
            path: roaming.clone(),
            pins: local.clone(),
            current: Mutex::new(Settings::default()),
        };
        store.set_pinned(vec![pin(&secret)]);

        let roamed = std::fs::read_to_string(&roaming).expect("preferences were written");
        assert!(
            !roamed.contains("acme-migration-plan"),
            "a capture path reached the roaming file: {roamed}",
        );
        // And the preferences really are still there — the split must not cost
        // the user their settings.
        assert!(roamed.contains("hotkey"));

        let kept = std::fs::read_to_string(&local).expect("pins were written");
        assert!(kept.contains("acme-migration-plan"), "the pin was not kept");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_item_cap_bounds_match_the_control_that_offers_them() {
        // Against the shared fixture, which `keyboard.spec.ts` asserts the
        // HTML input against. Neither side can move alone.
        #[derive(serde::Deserialize)]
        struct Bound {
            min: usize,
            max: usize,
        }
        #[derive(serde::Deserialize)]
        struct Bounds {
            #[serde(rename = "maxItems")]
            max_items: Bound,
        }

        let bounds: Bounds =
            serde_json::from_str(include_str!("../../tests/fixtures/settings-bounds.json"))
                .expect("the bounds fixture parses");

        assert_eq!(MIN_ITEMS, bounds.max_items.min);
        assert_eq!(MAX_ITEMS, bounds.max_items.max);

        // And the clamp really uses them.
        let low = sanitise(Settings {
            max_items: 0,
            ..Settings::default()
        });
        assert_eq!(low.max_items, MIN_ITEMS);
        let high = sanitise(Settings {
            max_items: 100_000,
            ..Settings::default()
        });
        assert_eq!(high.max_items, MAX_ITEMS);
    }

    #[test]
    fn a_relative_pinned_path_is_never_written_to_disk() {
        // Pinned paths arrive from the webview and are read back at the next
        // launch, so an unchecked one outlives the session that produced it.
        //
        // Both write paths have to drop it — `set_pinned` for the pin toggle,
        // and `sanitise` because the settings payload carries `pinned` too.
        // The check landed in one of them first and nothing noticed; this
        // test's own claim to cover both was false, because it only ever
        // called `sanitise`. Stated against `allowed_pins`, which is now the
        // only place either path can get a pinned list past.
        let keep = somewhere("keep.png");
        let cleaned = allowed_pins(vec![pin("Pictures/relative.png"), pin(&keep)]);

        assert_eq!(cleaned.len(), 1, "the relative path was dropped");
        assert_eq!(cleaned[0].path, keep);

        // And the settings surface reaches it, so the payload's `pinned` is
        // filtered on the way through too.
        let via_settings = sanitise(Settings {
            pinned: vec![pin("Pictures/relative.png"), pin(&keep)],
            ..Settings::default()
        });
        assert_eq!(via_settings.pinned.len(), 1);
    }

    #[test]
    fn the_pinned_list_cannot_grow_without_bound() {
        let keep = somewhere("a.png");
        assert_eq!(
            allowed_pins((0..MAX_PINNED + 50).map(|_| pin(&keep)).collect()).len(),
            MAX_PINNED,
        );

        let cleaned = sanitise(Settings {
            pinned: (0..MAX_PINNED + 50).map(|_| pin(&keep)).collect(),
            ..Settings::default()
        });

        assert_eq!(cleaned.pinned.len(), MAX_PINNED);
    }

    #[test]
    fn a_failed_settings_write_leaves_the_previous_file_intact() {
        // Staged and renamed, so the file is either the old one or the new
        // one. `fs::write` truncates first, and `load` degrades a truncated
        // file to defaults — silently costing the user every pin.
        //
        // Asserted by making the rename *fail*: an earlier version wrote the
        // defaults twice and compared the file to itself, which holds for any
        // correct write and passed against plain truncate-then-write.
        let dir = std::env::temp_dir().join("shotshelf-settings-atomic-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp dir");

        let path = dir.join("settings.json");
        let first = Settings {
            max_items: 7,
            ..Settings::default()
        };
        write(&path, &first).expect("first write");
        let before = std::fs::read_to_string(&path).expect("readable");

        // A directory where the staging file needs to go: the write fails
        // before it can touch the real settings.
        std::fs::create_dir_all(dir.join("settings.json.part")).expect("blocker");
        // Sanity: the blocker is what makes this test mean anything.
        assert!(dir.join("settings.json.part").is_dir());
        let second = Settings {
            max_items: 9,
            ..Settings::default()
        };
        assert!(write(&path, &second).is_err(), "the write reported failure");

        assert_eq!(
            std::fs::read_to_string(&path).expect("still readable"),
            before,
            "the previous settings survived a failed write",
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

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
