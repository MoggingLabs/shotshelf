/**
 * The settings client, shared by both windows.
 *
 * Rust owns the store; this module is every window's view of it. The shelf
 * loads it at boot and reacts to changes; the settings window edits it. The
 * two stay honest through `settings://changed`, which Rust emits after every
 * successful save — so a save made in either window moves both, and a value
 * Rust clamped comes back as what was actually stored.
 *
 * The form itself lives in `src/settings-window/` — this file deliberately
 * holds no DOM beyond nothing at all, because it is imported by both pages.
 * Everything lives in a local JSON file — no accounts, no sync, nothing
 * leaves the device.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { until, type Wait } from "./retry.ts";
// The neutral types module, not the shelf itself: the shelf imports this file
// for `persistPinned`, and pointing back at it would be a cycle.
import type { CaptureKind } from "./shelf/types.ts";
import type { WatchState } from "./status.ts";

export interface PinnedItem {
  path: string;
  kind: CaptureKind;
  ts: number;
}

export interface Settings {
  retentionHours: number | null;
  maxItems: number;
  hotkey: string;
  /**
   * Hand over a smaller copy of a capture instead of the original.
   *
   * Declared here as well as in Rust because it is load-bearing on both
   * sides: it was shipped typed only in Rust, and survived a settings save
   * purely because the payload is spread from the raw response. The first
   * caller to build a `Settings` from this interface would have silently
   * reset it.
   */
  downscaleExports: boolean;
  /**
   * Ask the release feed whether a newer build exists, at launch. The only
   * network call Shotshelf makes; off means it opens no socket at all.
   */
  checkForUpdates: boolean;
  /**
   * Which corner the popover docks to. The four spellings are pinned to
   * Rust's `DOCK_CORNERS` by the corner picker and the e2e that drives it;
   * an unknown value comes back normalised to the default.
   */
  dockCorner: "bottom-right" | "bottom-left" | "top-right" | "top-left";
  /** Which monitor carries the corner: the primary, or the one the cursor is on. */
  dockMonitor: "primary" | "cursor";
  /**
   * Register Shotshelf to start at login. Off by default — the app never adds
   * itself to startup unasked. The choice roams with the account; each
   * machine's login item is reconciled to it at launch.
   */
  startAtLogin: boolean;
  /**
   * Which palette the UI wears. `"system"` follows the OS; the spellings are
   * pinned to Rust's `THEMES` and an unknown value comes back normalised.
   */
  theme: "system" | "light" | "dark";
  /**
   * Folders the user chose to watch beyond the per-OS defaults. Absolute
   * paths, exactly as the picker returned them.
   */
  watchAdded: string[];
  /**
   * Default folders the user chose to stop watching, by exact resolved path.
   * A subtraction rather than a materialised list, so Restore defaults is
   * just clearing it — stock folders come back, added ones stay.
   */
  watchRemoved: string[];
  pinned: PinnedItem[];
}

/**
 * Mirrors the Rust defaults so the shelf has sane limits from its very first
 * frame — a capture can land before the settings file has been read.
 */
export const DEFAULTS: Settings = {
  retentionHours: null,
  maxItems: 50,
  hotkey: "CommandOrControl+Shift+S",
  downscaleExports: false,
  checkForUpdates: true,
  dockCorner: "bottom-right",
  dockMonitor: "primary",
  startAtLogin: false,
  theme: "system",
  watchAdded: [],
  watchRemoved: [],
  pinned: [],
};

let current: Settings = DEFAULTS;

export function currentSettings(): Settings {
  return current;
}

/**
 * Whether the stored settings were ever read.
 *
 * Load-bearing, because everything that *writes* settings replaces the whole
 * list it is given. The webview starts running while Rust's `setup` hook is
 * still going — Tauri builds config windows before it — so `get_settings` can
 * land before the store is managed and come back an error. When it did, this
 * module kept `DEFAULTS`, which has `pinned: []`, `restorePinned` never ran,
 * and the shelf showed no pins. Pinning anything then sent a one-element list
 * to `set_pinned`, which replaced the file. Every previous pin was gone, and
 * the only thing the user had seen was "running on defaults".
 */
let loaded = false;

/**
 * How long to keep re-asking for the stored settings.
 *
 * `get_settings` cannot answer until `app.manage(stored)`, which comes after
 * `settings::load` reads the preferences root — `%APPDATA%` under a roaming or
 * redirected profile, where every read is an SMB round trip.
 *
 * Five seconds rather than the catch engine's minute, and the difference is
 * the point: this waits only for a file read a few statements into `setup`,
 * while the engine resolves and opens watches on possibly-remote folders.
 *
 * Giving up early is not merely a slow start: `persistPinned` refuses to write
 * when settings were never loaded — that guard is what stops an empty list
 * overwriting the user's pins — so an exhausted retry leaves the shelf unable
 * to save a pin for the rest of the session.
 */
const SETTINGS_WAIT: Wait = {
  attempts: 20,
  everyMs: 250,
  // Anything, deliberately. Unlike the catch engine, Rust has no distinct
  // "not ready" answer here: an unmanaged store surfaces as Tauri's own
  // "state not managed", which is not a contract this side should match on.
  transient: () => true,
};

/** Read the stored settings, retrying while Rust's setup is still going. */
export async function loadSettings(): Promise<Settings> {
  current = await until(() => invoke<Settings>("get_settings"), SETTINGS_WAIT);
  loaded = true;
  return current;
}

/**
 * Save a patch on top of the current settings. Resolves with what Rust
 * actually stored — clamps and normalisations included — and rejects with
 * Rust's own sentence when the save was refused (a hotkey another app owns,
 * a login item the OS would not take).
 */
export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  // Same rule as `persistPinned`: this sends the whole settings object,
  // `pinned` included, so writing it before the stored one was read would
  // replace the user's pins with an empty list.
  if (!loaded) {
    throw new Error("Settings could not be loaded, so they cannot be saved.");
  }
  current = await invoke<Settings>("set_settings", {
    settings: { ...current, ...patch },
  });
  return current;
}

/**
 * Hear about every successful save, from any window.
 *
 * The payload is what Rust stored. `current` is updated before the callback
 * runs, so `currentSettings()` inside a listener already answers the new
 * truth. The registration promise is the caller's to watch — a subscription
 * that failed is a window that silently stops tracking the store.
 */
export function onSettingsChanged(changed: (settings: Settings) => void): Promise<unknown> {
  return listen<Settings>("settings://changed", ({ payload }) => {
    current = payload;
    loaded = true;
    changed(payload);
  });
}

/** Pins are edited from the tiles, never from the settings window. */
export async function persistPinned(pinned: PinnedItem[]): Promise<void> {
  // Refuses to write a list built on defaults.
  //
  // `set_pinned` replaces the stored list outright, so writing while the real
  // one was never read destroys it. Better to lose this session's pin than
  // every pin the user has.
  if (!loaded) {
    console.error("[shotshelf] not saving pins: settings were never loaded");
    return;
  }

  current = { ...current, pinned };
  try {
    await invoke("set_pinned", { pinned });
  } catch (error) {
    console.error("[shotshelf] could not save pinned captures", error);
    throw error instanceof Error ? error : new Error(String(error));
  }
}

/** Show and focus the settings window — the gear's whole job now. */
export function openSettingsWindow(): Promise<void> {
  return invoke("open_settings");
}

/** Ask the feed once, for the About section's button. Resolves to a sentence. */
export function checkForUpdatesNow(): Promise<string> {
  return invoke<string>("check_for_updates");
}

/**
 * What the catch engine is really watching — the Capturing section's list.
 * Rejects with the engine's "still starting" sentence while it comes up; the
 * caller retries, exactly as the shelf's boot does.
 */
export function watchStateNow(): Promise<WatchState> {
  return invoke<WatchState>("catch_watch_dirs");
}

/** Open one of the About links in the system browser, by name. */
export function openLink(which: "repo" | "usage" | "issues"): Promise<void> {
  return invoke("open_link", { which });
}

/**
 * Ask the OS for a folder to watch. `null` is the user closing the picker —
 * an answer, not an error. The webview never composes a path: what comes
 * back is what the user clicked in their own file chooser.
 */
export function chooseWatchFolder(): Promise<string | null> {
  return invoke<string | null>("choose_watch_folder");
}
