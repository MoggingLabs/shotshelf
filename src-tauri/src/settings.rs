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
    /// Pinned capture paths and the catch watermark. Must not roam — see
    /// [`pins_path`].
    pins: PathBuf,
    current: Mutex<Settings>,
    /// The newest capture seen, mirrored in memory so the catch path does not
    /// read a file per capture.
    last_capture: Mutex<u64>,
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
        {
            let mut current = self.lock();
            current.pinned = allowed_pins(pinned);
        }
        // Only the local file: a pin toggle changes nothing in the preferences.
        self.persist_local();
    }

    /// Write both files.
    ///
    /// Two files, because they have different rules about leaving the machine.
    /// The preferences file carries everything except `pinned`; the pins file
    /// carries only `pinned`, and lives where nothing syncs it.
    /// The newest capture the shelf has been told about, in Unix ms.
    pub fn last_capture_ms(&self) -> u64 {
        *self
            .last_capture
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Record that a capture this recent has reached the shelf.
    ///
    /// Only ever moves forward: captures do not arrive in order — a backfill
    /// hands over yesterday's after today's have already landed — and a
    /// watermark that went backwards would re-offer everything in between on
    /// the next launch.
    ///
    /// Writes **only the local file**, not the preferences beside it. This
    /// used to call the full `persist`, which rewrites-and-renames both files;
    /// and its caller is `CaptureSink::emit`, so every single screenshot
    /// triggered an atomic rewrite of a preferences file in which nothing had
    /// changed, synchronously, on the folder-watcher thread — which may be
    /// watching an SMB share. Two records with two lifetimes and two writers
    /// sharing one write path was the seam being wrong, not just slow.
    pub fn note_capture(&self, ts: u64) {
        {
            let mut newest = self
                .last_capture
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if ts <= *newest {
                return;
            }
            *newest = ts;
        }
        self.persist_local();
    }

    /// Write the local file — pins and the watermark — and nothing else.
    fn persist_local(&self) {
        let local = LocalState {
            pinned: self.lock().pinned.clone(),
            last_capture_ms: self.last_capture_ms(),
        };
        if let Err(err) = write(&self.pins, &local) {
            crate::diag::warn(&format!("could not save pins: {err}"));
        }
    }

    fn persist(&self, settings: &Settings) {
        let preferences = Settings {
            pinned: Vec::new(),
            ..settings.clone()
        };
        if let Err(err) = write(&self.path, &preferences) {
            crate::diag::warn(&format!("could not save settings: {err}"));
        }
        self.persist_local();
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
    load_from(settings_path(app), pins_path(app))
}

/// The file half, with the two locations passed in.
///
/// Split out so the migration can be tested. It is the one path in this module
/// that can destroy a user's pins — it decides which of two files wins, and
/// what happens when either is unreadable — and it had no test, because
/// everything it did was behind an `AppHandle`.
fn load_from(path: Option<PathBuf>, pins: Option<PathBuf>) -> SettingsStore {
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

    // Pins from their own file, falling back to whatever the preferences file
    // still carries.
    //
    // That fallback is the migration: an install from before the split has its
    // pins in `settings.json`, and they are read once, then written to the new
    // file by the `persist` below. Nothing is deleted from the old file by
    // hand — the next write of `settings.json` omits `pinned` anyway, because
    // `persist` blanks it.
    let mut current = current;
    let local = pins
        .as_ref()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|raw| match read_local_state(strip_bom(&raw)) {
            Ok(state) => Some(state),
            // Said out loud, like the preferences file four lines up.
            //
            // This used to be `.ok()`. A corrupt `pinned.json` therefore lost
            // every pin in silence, fell back to the preferences file — which
            // `persist` has been blanking since the split — and the next pin
            // toggle overwrote the corrupt file, destroying the only copy a
            // user could have hand-repaired.
            Err(err) => {
                crate::diag::warn(&format!(
                    "pinned captures could not be read, so none were restored: {err}"
                ));
                None
            }
        });

    if let Some(state) = local {
        current.pinned = state.pinned;
    }
    let last_capture = local_watermark(&pins);

    let store = SettingsStore {
        path: path.unwrap_or_default(),
        pins: pins.unwrap_or_default(),
        current: Mutex::new(sanitise(current)),
        last_capture: Mutex::new(last_capture),
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

/// What Shotshelf keeps locally: the pins, and how far the catch engine got.
///
/// One file, because both are the same kind of thing — state about *this
/// machine's captures* — and both must stay off a roaming profile.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LocalState {
    pub pinned: Vec<PinnedItem>,
    /// The newest capture the shelf has been told about, in Unix ms.
    ///
    /// A watermark, and the thing that stops a launch undoing `Remove`.
    /// Taking a capture off the shelf is deliberately shelf-only — the file
    /// stays on disk — so without this every removed capture from the last day
    /// came back on the next launch. `catch::to_backfill` only offers captures
    /// newer than this.
    pub last_capture_ms: u64,
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

/// The watermark from the local state file, or zero if there is not one yet.
///
/// Zero means "offer everything in the window", which is right for a fresh
/// install and right after a corrupt file: the alternative is a launch that
/// silently brings nothing back.
/// Parse the local state file, in either shape it has ever had.
///
/// It shipped for one round as a bare JSON array of pins, then gained an
/// object with the capture watermark beside them. Reading only the object
/// meant an existing file failed to parse, the corrupt-file warning fired, and
/// every pin was lost — then the first capture overwrote the only copy that
/// could have been repaired by hand. That is the same defect the previous
/// migration was written to avoid, one round later, in the same file.
///
/// Nobody has an installed build (there are no release tags), so the blast
/// radius is anyone who built from source in between — which is not nobody,
/// and is not a reason to skip six lines.
fn read_local_state(raw: &str) -> Result<LocalState, serde_json::Error> {
    match serde_json::from_str::<LocalState>(raw) {
        Ok(state) => Ok(state),
        Err(object_error) => match serde_json::from_str::<Vec<PinnedItem>>(raw) {
            // The older shape: pins only, and no watermark yet. Zero is right
            // for that — it means "offer everything in the window", which is
            // what the previous version did anyway.
            Ok(pinned) => Ok(LocalState {
                pinned,
                last_capture_ms: 0,
            }),
            // Neither shape. Report the object error, which is the one a
            // reader of the current file wants.
            Err(_) => Err(object_error),
        },
    }
}

fn local_watermark(pins: &Option<PathBuf>) -> u64 {
    pins.as_ref()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|raw| read_local_state(strip_bom(&raw)).ok())
        .map_or(0, |state| state.last_capture_ms)
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

    /// A temp directory of this test's own.
    fn workspace(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("shotshelf-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("a temp dir");
        dir
    }

    #[test]
    fn pins_from_before_the_split_are_migrated_rather_than_lost() {
        // The upgrade path. Before this round pins lived in `settings.json`;
        // they now live in a local-only file, and an existing install has to
        // keep them. This is the one code path that can destroy a user's pins,
        // and it had no test.
        let dir = workspace("migrate");
        let roaming = dir.join("settings.json");
        let local = dir.join("pinned.json");
        let kept = somewhere("still-pinned.png");

        // An old install: everything in one file.
        std::fs::write(
            &roaming,
            serde_json::to_string(&Settings {
                max_items: 33,
                pinned: vec![pin(&kept)],
                ..Settings::default()
            })
            .expect("serialises"),
        )
        .expect("an old settings file");

        let store = load_from(Some(roaming.clone()), Some(local.clone()));

        assert_eq!(store.get().pinned.len(), 1, "the pin survived the upgrade");
        assert_eq!(store.get().pinned[0].path, kept);
        assert_eq!(store.get().max_items, 33, "and so did the preferences");

        // And it has been written to its new home immediately, so the next
        // launch does not depend on the old file still being readable.
        let moved = std::fs::read_to_string(&local).expect("pins were migrated");
        assert!(moved.contains("still-pinned"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_local_file_wins_when_both_hold_pins() {
        // After a migration the roaming file still carries whatever it had
        // until the next write blanks it. The local file is the live one.
        let dir = workspace("both");
        let roaming = dir.join("settings.json");
        let local = dir.join("pinned.json");

        std::fs::write(
            &roaming,
            serde_json::to_string(&Settings {
                pinned: vec![pin(&somewhere("stale.png"))],
                ..Settings::default()
            })
            .expect("serialises"),
        )
        .expect("a settings file");
        std::fs::write(
            &local,
            serde_json::to_string(&LocalState {
                pinned: vec![pin(&somewhere("current.png"))],
                last_capture_ms: 42,
            })
            .expect("serialises"),
        )
        .expect("a pins file");

        let store = load_from(Some(roaming), Some(local));

        assert_eq!(store.get().pinned.len(), 1);
        assert!(store.get().pinned[0].path.contains("current"));
        assert_eq!(store.last_capture_ms(), 42, "the watermark came back too");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_corrupt_pins_file_costs_the_pins_but_not_the_settings() {
        // And it must not silently fall back to the roaming file, which
        // `persist` has been blanking since the split — that would look like
        // "you had no pins" rather than "your pins could not be read".
        let dir = workspace("corrupt");
        let roaming = dir.join("settings.json");
        let local = dir.join("pinned.json");

        std::fs::write(
            &roaming,
            serde_json::to_string(&Settings {
                max_items: 77,
                ..Settings::default()
            })
            .expect("serialises"),
        )
        .expect("a settings file");
        std::fs::write(&local, b"{ this is not json").expect("a corrupt pins file");

        let store = load_from(Some(roaming), Some(local.clone()));

        assert!(store.get().pinned.is_empty());
        assert_eq!(store.get().max_items, 77, "preferences are unaffected");
        // The corrupt file is left alone until something actually writes, so a
        // user still has a copy to repair by hand.
        assert!(std::fs::read_to_string(&local).is_ok_and(|raw| raw.contains("not json")));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_pins_file_from_the_previous_shape_is_still_read() {
        // `pinned.json` shipped for one round as a bare array and then became
        // an object with the watermark beside it. Reading only the object lost
        // every pin — and then the first capture overwrote the file, so there
        // was nothing left to repair.
        let dir = workspace("shape");
        let local = dir.join("pinned.json");
        let kept = somewhere("from-the-old-shape.png");

        std::fs::write(
            &local,
            serde_json::to_string(&vec![pin(&kept)]).expect("serialises"),
        )
        .expect("an old-shape pins file");

        let store = load_from(Some(dir.join("settings.json")), Some(local.clone()));

        assert_eq!(
            store.get().pinned.len(),
            1,
            "the pin survived the shape change"
        );
        assert_eq!(store.get().pinned[0].path, kept);
        assert_eq!(store.last_capture_ms(), 0, "no watermark in the old shape");

        // And it is rewritten in the current shape, so this only happens once.
        store.note_capture(7);
        let rewritten = std::fs::read_to_string(&local).expect("rewritten");
        assert!(rewritten.contains("lastCaptureMs"));
        assert!(rewritten.contains("from-the-old-shape"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_capture_watermark_only_ever_moves_forward() {
        // Deleting the `ts <= *newest` guard left all 116 tests green, while
        // the docstring calls it the thing that stops the shelf "re-offering
        // everything in between on the next launch".
        //
        // It matters because captures genuinely arrive out of order: a backfill
        // hands over yesterday's after today's have already landed, and a
        // watermark that moved backwards would re-offer every capture between
        // the two on the following launch — including ones the user removed.
        let dir = workspace("watermark");
        let store = SettingsStore {
            path: dir.join("settings.json"),
            pins: dir.join("pinned.json"),
            current: Mutex::new(Settings::default()),
            last_capture: Mutex::new(0),
        };

        store.note_capture(500);
        assert_eq!(store.last_capture_ms(), 500);

        store.note_capture(200);
        assert_eq!(
            store.last_capture_ms(),
            500,
            "an older capture must not move it back"
        );

        store.note_capture(500);
        assert_eq!(
            store.last_capture_ms(),
            500,
            "the same capture changes nothing"
        );

        store.note_capture(900);
        assert_eq!(store.last_capture_ms(), 900);

        // And it survives, which is the whole point of writing it down.
        let reloaded = load_from(
            Some(dir.join("settings.json")),
            Some(dir.join("pinned.json")),
        );
        assert_eq!(reloaded.last_capture_ms(), 900);

        let _ = std::fs::remove_dir_all(&dir);
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
            last_capture: Mutex::new(0),
        };
        // Preferences on disk first, as any real install has them.
        store.replace(Settings::default());
        let before = std::fs::read_to_string(&roaming).expect("preferences were written");
        assert!(before.contains("hotkey"));

        store.set_pinned(vec![pin(&secret)]);

        let roamed = std::fs::read_to_string(&roaming).expect("preferences still there");
        assert!(
            !roamed.contains("acme-migration-plan"),
            "a capture path reached the roaming file: {roamed}",
        );
        // Byte-for-byte untouched: a pin toggle changes nothing in the
        // preferences, so it must not rewrite them. It used to — and so did
        // every single capture, through `note_capture`, synchronously on the
        // folder-watcher thread.
        assert_eq!(before, roamed, "a pin toggle rewrote the preferences file");

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
