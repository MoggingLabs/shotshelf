//! What the shelf remembers between launches.
//!
//! Two JSON files, split by what may roam — no accounts, no sync, no network,
//! and deliberately few knobs.
//!
//! `settings.json` lives in the OS config directory, which on Windows **is** the
//! roaming profile. It holds how long captures stay, the item cap, the toggle
//! shortcut, whether copies are downscaled, and whether to check for updates.
//!
//! `pinned.json` lives in the local data directory and holds the pinned capture
//! paths, plus a note of the newest capture seen. It is a separate file
//! precisely so those paths never roam: `persist` blanks `pinned` before
//! serialising the roaming file, and
//! `pinned_paths_are_never_written_to_the_roaming_file` asserts it.
//!
//! An earlier version of this header credited `settings.json` with the pinned
//! paths — the one thing the split exists to keep out of it, and the thing
//! `SECURITY.md` promises cannot be there — and with "where the shelf sits",
//! which no field has held since the shelf became a popover.
//!
//! Capture *contents* are never written to either; only paths and a little
//! metadata.

use std::{
    path::PathBuf,
    sync::{Mutex, MutexGuard},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime};

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
    pub fn set_pinned(&self, pinned: Vec<PinnedItem>) -> Result<(), String> {
        // Through the same function `sanitise` uses. This path skips
        // `sanitise` entirely, which is how a rule applied on the settings
        // surface could miss the pin toggle — and did.
        {
            let mut current = self.lock();
            current.pinned = allowed_pins(pinned);
        }
        // Only the local file: a pin toggle changes nothing in the preferences.
        self.persist_local()
    }

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
        // Discarded on purpose: this is the watermark being written after a
        // capture landed, which nobody is watching. `persist_local` has already
        // logged the reason, and the cost of a failure here is that a relaunch
        // re-offers captures it has seen — an annoyance, not a loss.
        let _ = self.persist_local();
    }

    /// Write the local file — pins and the watermark — and nothing else.
    /// Returns whether the write happened.
    ///
    /// It used to only warn to the log, which is right for a background write
    /// and wrong for one the user just asked for and is watching: on a full disk
    /// or a read-only profile the star lit, nothing was said, and the pin was
    /// gone at the next launch. The log line stays — it is the diagnosis — and
    /// the caller now has something to act on.
    fn persist_local(&self) -> Result<(), String> {
        let local = LocalState {
            pinned: self.lock().pinned.clone(),
            last_capture_ms: self.last_capture_ms(),
        };
        write(&self.pins, &local).map_err(|err| {
            crate::diag::warn(&format!("could not save pins: {err}"));
            format!("Those pins could not be saved: {err}")
        })
    }

    /// Write both files.
    ///
    /// Two, because they have different rules about leaving the machine: the
    /// preferences file carries everything except `pinned`, and the local file
    /// carries the pins *and* the capture watermark and lives where nothing
    /// syncs it. A pin toggle and a capture both take `persist_local` alone —
    /// see `note_capture` for why rewriting preferences per screenshot was a
    /// bug rather than a cost.
    fn persist(&self, settings: &Settings) {
        let preferences = Settings {
            pinned: Vec::new(),
            ..settings.clone()
        };
        if let Err(err) = write(&self.path, &preferences) {
            crate::diag::warn(&format!("could not save settings: {err}"));
        }
        // Both files are written here; the pins half is the same background
        // write as above and its failure is already logged.
        let _ = self.persist_local();
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
    // Whether the file exists but will not parse — distinct from "absent", which
    // is an ordinary first run. Only the first deserves a `.corrupt` copy.
    let mut settings_unreadable = false;

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
                    settings_unreadable = true;
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

    // An unreadable local file is not the same as an absent one, and treating
    // them alike is what made the fallback wrong.
    //
    // Absent means an upgrade: there is no newer copy, so the preferences file
    // is the only copy and reading it is correct. Unreadable means there *is* a
    // newer copy and we cannot read it — the preferences file then holds
    // whatever was there before the split, which is stale by definition, and
    // presenting it as the current pins is a lie that looks like working
    // software. Worse, the next `persist_local` writes that stale list back as
    // if the user had chosen it.
    //
    // So this flag is the difference between "restore nothing and say so" and
    // "migrate". A test asserted the no-fallback rule before this existed and
    // could not have failed: its roaming fixture had no pins either way.
    let unreadable = pins
        .as_ref()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .is_some_and(|raw| read_local_state(strip_bom(&raw)).is_err());

    // The raw text, read once and used twice: `read_local_state` needs it, and
    // so does the watermark, which must be recovered before `set_aside` moves
    // the file out from under it.
    let raw_local = pins
        .as_ref()
        .and_then(|path| std::fs::read_to_string(path).ok());
    let watermark = raw_local
        .as_deref()
        .map(strip_bom)
        .and_then(|raw| read_local_state(raw).ok())
        .map_or(0, |state| state.last_capture_ms);

    let local = raw_local
        .clone()
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
                // Moved aside, not merely left alone.
                //
                // A previous round added this warning and stopped, under a
                // comment saying the overwrite was fixed. It was not:
                // `note_capture` fires on the first capture of the session and
                // `persist_local` then writes an empty list straight over the
                // only copy the user could have repaired by hand. Leaving the
                // file in place means the next write destroys it; a `.corrupt`
                // neighbour is something a person can actually open.
                if let Some(path) = pins.as_ref() {
                    match set_aside(path) {
                        Some(kept) => crate::diag::warn(&format!(
                            "the unreadable file was kept as {}",
                            kept.file_name().unwrap_or_default().to_string_lossy()
                        )),
                        None => crate::diag::warn(
                            "could not set the unreadable pins file aside; it is still in place \
                             and the next write will overwrite it",
                        ),
                    }
                }
                None
            }
        });

    match local {
        Some(state) => current.pinned = state.pinned,
        // Explicitly emptied rather than left holding the preferences file's
        // copy: "your pins could not be read" is the honest state, and it is
        // what the warning above has just told the log.
        None if unreadable => current.pinned = Vec::new(),
        // Absent: the migration path, and `current.pinned` is already whatever
        // the preferences file carried.
        None => {}
    }
    // From the same parse as the pins, rather than a second read of the file.
    //
    // A review raised this as a bug — that `local_watermark` ran after
    // `set_aside` had renamed the file, so a corrupt `pinned.json` cost the
    // watermark too and backfill re-offered removed captures. It does not hold:
    // that helper used `read_local_state`, the same parse as the pins, so a file
    // that will not parse yields 0 whichever order it is read in, and a file
    // that parses never reaches `set_aside`. Written down because the reasoning
    // is not obvious from either site.
    //
    // What *was* worth changing is that the file was opened twice, with the
    // second open depending on the first not having moved it. One read now.
    let last_capture = watermark;

    // A corrupt preferences file is set aside before it is overwritten, exactly
    // as an unreadable pins file is.
    //
    // `persist` writes *both* files, so a `settings.json` that failed to parse
    // was replaced with defaults whenever `pinned.json` happened to be absent —
    // which is what a user following the "delete that too for a clean start"
    // advice produces, and what the launch after a corrupt-pins rescue produces.
    // The pins file has had a `.corrupt` neighbour since round nineteen; the
    // hand-editable file next to it had none.
    if settings_unreadable {
        if let Some(path) = path.as_ref().filter(|path| path.exists()) {
            match set_aside(path) {
                Some(kept) => crate::diag::warn(&format!(
                    "the unreadable settings file was kept as {}",
                    kept.file_name().unwrap_or_default().to_string_lossy()
                )),
                None => crate::diag::warn(
                    "could not set the unreadable settings file aside; it is still in place \
                     and the next write will overwrite it",
                ),
            }
        }
    }

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

/// How many unreadable copies are kept before new ones stop being set aside.
///
/// Small on purpose: these live beside the file they came from — which is the
/// **local** data directory, `dirs::local`, not the preferences one, because
/// `pinned.json` names captures and nothing naming a capture may roam. An
/// unbounded set of them is its own kind of mess.
///
/// They carry capture paths, so `docs/USAGE.md`'s uninstall list names them.
const KEPT_CORRUPT: u32 = 5;

/// Move an unreadable file somewhere the next write will not destroy it.
///
/// Returns where it went, or `None` if it could not be moved at all.
///
/// The name is searched for a free slot rather than fixed. `rename` replaces
/// its destination, so a single `pinned.json.corrupt` was a rotating slot of
/// one: the second corruption silently destroyed the copy the *first* warning
/// had told the user to go and repair — the exact failure this whole branch
/// exists to prevent, one level up.
///
/// Past `KEPT_CORRUPT` the file is left in place and the caller says so. That
/// loses the newest copy rather than the oldest, which is the right way round:
/// by then five earlier ones are already sitting there to be looked at.
fn set_aside(path: &std::path::Path) -> Option<std::path::PathBuf> {
    for attempt in 0..KEPT_CORRUPT {
        let kept = if attempt == 0 {
            path.with_extension("json.corrupt")
        } else {
            path.with_extension(format!("json.corrupt.{attempt}"))
        };

        // `create_new` claims the name and fails if it is taken, so two
        // processes racing here cannot both decide the same slot is free.
        if std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&kept)
            .is_err()
        {
            continue;
        }

        // The placeholder is replaced by the real file; `rename` overwrites it,
        // which is what makes claiming the name first safe.
        if std::fs::rename(path, &kept).is_ok() {
            return Some(kept);
        }

        // The rename failed, so the placeholder is not the file it stands for.
        let _ = std::fs::remove_file(&kept);
        return None;
    }
    None
}

/// Where the preferences file lives: `%APPDATA%\com.mogginglabs.shotshelf\`
/// on Windows, `~/Library/Application Support/com.mogginglabs.shotshelf/` on
/// macOS.
///
/// Preferences only. Pinned paths live somewhere else — see [`pins_path`].
fn settings_path<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    // The one permitted call. `clippy.toml` disallows `dirs::preferences`
    // everywhere else — the script alone matched on how the call is *spelled*,
    // and one module alias walked past it — so the exception lives here, next
    // to the reason: this file writes `settings.json` and nothing else, and
    // `persist` blanks `pinned` before serialising it.
    #[allow(clippy::disallowed_methods)]
    Some(crate::dirs::preferences(app).ok()?.join("settings.json"))
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
    Some(crate::dirs::local(app, "").ok()?.join("pinned.json"))
}

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
    fn a_corrupt_settings_file_is_kept_rather_than_overwritten() {
        // `persist` writes *both* files, so an unreadable `settings.json` was
        // replaced with defaults whenever `pinned.json` was absent — which is
        // what "delete that too for a clean start" produces, and what the launch
        // after a corrupt-pins rescue produces. The pins file has had a
        // `.corrupt` neighbour since round nineteen; the hand-editable file
        // beside it had none.
        let dir = workspace("corrupt-settings");
        let roaming = dir.join("settings.json");
        let local = dir.join("pinned.json");

        std::fs::write(&roaming, "{ this will not parse").expect("a corrupt settings file");
        // Absent on purpose: that is what makes `persist` run.
        assert!(!local.exists());

        let _ = load_from(Some(roaming.clone()), Some(local));

        let kept = dir.join("settings.json.corrupt");
        assert!(kept.exists(), "the unreadable settings file was destroyed");
        assert_eq!(
            std::fs::read_to_string(&kept).expect("readable"),
            "{ this will not parse",
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_second_corruption_does_not_destroy_the_copy_kept_from_the_first() {
        // The warning tells the user an unreadable file was kept for them to
        // repair. `rename` replaces its destination, so a fixed
        // `pinned.json.corrupt` was a rotating slot of one: the second
        // corruption silently deleted the copy the first warning had pointed
        // at. Losing the thing you were just told to go and look at is worse
        // than the corruption.
        let dir = workspace("corrupt-twice");
        let pins = dir.join("pinned.json");

        std::fs::write(&pins, "{ the first corruption }").expect("write");
        let first = set_aside(&pins).expect("the first copy is kept");
        assert_eq!(
            std::fs::read_to_string(&first).expect("readable"),
            "{ the first corruption }"
        );

        std::fs::write(&pins, "{ the second corruption }").expect("write");
        let second = set_aside(&pins).expect("the second copy is kept too");

        assert_ne!(first, second, "the second copy took the first one's name");
        assert_eq!(
            std::fs::read_to_string(&first).expect("the first copy is still there"),
            "{ the first corruption }",
            "the first kept copy was destroyed by the second corruption",
        );
        assert_eq!(
            std::fs::read_to_string(&second).expect("readable"),
            "{ the second corruption }"
        );

        // And the slots are bounded: past the cap the file is left in place
        // and the caller reports that, rather than filling the preferences
        // directory with copies.
        for _ in 2..KEPT_CORRUPT {
            std::fs::write(&pins, "more").expect("write");
            assert!(set_aside(&pins).is_some());
        }
        std::fs::write(&pins, "one too many").expect("write");
        assert!(set_aside(&pins).is_none(), "the cap does not hold");
        assert!(pins.exists(), "the file past the cap is left where it is");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_corrupt_pins_file_costs_the_pins_but_not_the_settings() {
        // And it must not silently fall back to the roaming file — that would
        // show a pre-split copy, stale by definition, as if it were current,
        // and the next write would store it as the user's choice.
        //
        // The roaming fixture below carries a pin *on purpose*. It used to be
        // `Settings::default()`, whose `pinned` is empty, so the assertion held
        // whether or not the fallback happened — it named the rule and could
        // not test it. The fallback did happen.
        let dir = workspace("corrupt");
        let roaming = dir.join("settings.json");
        let local = dir.join("pinned.json");

        std::fs::write(
            &roaming,
            serde_json::to_string(&Settings {
                max_items: 77,
                pinned: vec![PinnedItem {
                    path: "/from/before/the/split.png".into(),
                    kind: CaptureKind::Image,
                    ts: 1,
                }],
                ..Settings::default()
            })
            .expect("serialises"),
        )
        .expect("a settings file");
        std::fs::write(&local, b"{ this is not json").expect("a corrupt pins file");

        let store = load_from(Some(roaming), Some(local.clone()));

        assert!(
            store.get().pinned.is_empty(),
            "an unreadable local file fell back to the stale roaming copy",
        );
        assert_eq!(store.get().max_items, 77, "preferences are unaffected");

        // The unreadable file survives a session that writes.
        //
        // "Left alone until something writes" was the previous claim, and the
        // first capture of any session writes: `note_capture` calls
        // `persist_local`, which put an empty list straight over it. Asserting
        // only that the bytes survive `load` could not see that, so this now
        // writes the way a session does.
        store.note_capture(1_700_000_000_000);
        let kept = dir.join("pinned.json.corrupt");
        assert!(
            std::fs::read_to_string(&kept).is_ok_and(|raw| raw.contains("not json")),
            "the only repairable copy was destroyed",
        );

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
        // Deleting the `ts <= *newest` guard left the whole suite green, while
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

        // **Not written at all**, which is stronger than "written identically".
        //
        // Comparing the bytes could not fail: `persist` blanks `pinned` before
        // serialising, so the buggy write produced a byte-identical file. Both
        // mutations — `set_pinned` and `note_capture` calling the full
        // `persist` — passed the content assertion. The modification time is
        // the only thing that can tell "did not write" from "wrote the same".
        let stamp = |path: &std::path::Path| {
            std::fs::metadata(path)
                .and_then(|meta| meta.modified())
                .expect("a modified time")
        };
        let before_write = stamp(&roaming);
        // Coarse filesystem timestamps would make an immediate rewrite look
        // like no write at all, so put a gap either side of the call.
        std::thread::sleep(std::time::Duration::from_millis(20));

        store
            .set_pinned(vec![pin(&secret)])
            .expect("the pins write succeeds");

        assert_eq!(
            stamp(&roaming),
            before_write,
            "a pin toggle rewrote the preferences file",
        );

        let roamed = std::fs::read_to_string(&roaming).expect("preferences still there");
        assert!(
            !roamed.contains("acme-migration-plan"),
            "a capture path reached the roaming file: {roamed}",
        );

        // And a capture must not rewrite them either — `note_capture` runs on
        // the folder-watcher thread, once per screenshot.
        let before_capture = stamp(&roaming);
        std::thread::sleep(std::time::Duration::from_millis(20));
        store.note_capture(1_700_000_000_000);
        assert_eq!(
            stamp(&roaming),
            before_capture,
            "a capture rewrote the preferences file",
        );

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

/// Applies the new settings as well as storing them, so the shortcut
/// re-registers without a restart.
///
/// "The shelf moves" was in that sentence too, from before the shelf became a
/// popover that parks itself in a corner. Nothing here moves a window.
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
/// Reports a failed write rather than swallowing it.
///
/// This returned `()`, so `invoke("set_pinned", …)` could not reject: on a full
/// disk the star lit, the panel said nothing, and the pin was gone at the next
/// launch — against `docs/USAGE.md`'s promise that pins survive a restart.
pub fn set_pinned(
    store: tauri::State<'_, SettingsStore>,
    pinned: Vec<PinnedItem>,
) -> Result<(), String> {
    store.set_pinned(pinned)
}
