/**
 * The settings surface.
 *
 * Deliberately small, and this is the whole list: how long captures stay, how
 * many the shelf holds, whether copies are downscaled on the way out, the
 * shortcut that summons it, which corner of which monitor it parks in, and
 * whether it starts at login.
 *
 * "Where the shelf sits" used to head that sentence, was retracted when no
 * field held it any more, and is now true again — `dockCorner`/`dockMonitor`
 * are exactly that, brought back as a deliberate setting rather than the
 * leftover the original was. Everything lives in a local JSON file — no
 * accounts, no sync, nothing leaves the device.
 */

import { invoke } from "@tauri-apps/api/core";

import { until, type Wait } from "./retry.ts";

import { el } from "./dom.ts";
// The neutral types module, not the shelf itself: the shelf imports this file
// for `persistPinned`, and pointing back at it would be a cycle.
import type { CaptureKind } from "./shelf/types.ts";

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
   * Ask the release feed whether a newer build exists, at launch.
   *
   * The only network call Shotshelf makes. Off means it opens no socket at
   * all, which is the point of the setting existing at all — it is hand-edited, not a control in the panel to someone who chose this
   * app for being local-only.
   */
  checkForUpdates: boolean;
  /**
   * Which corner the popover docks to. The four spellings are pinned to
   * Rust's `DOCK_CORNERS` by the panel's own options and the e2e that drives
   * them; an unknown value comes back normalised to the default.
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
  pinned: [],
};

let current: Settings = DEFAULTS;
let announce: (settings: Settings) => void = () => {};

const panel = () => el<HTMLElement>("#settings-panel");
const note = () => el<HTMLElement>("#settings-note");

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
 * while the engine resolves and opens watches on possibly-remote folders. Both
 * budgets now sit at their call sites in front of one shared loop, so the
 * difference is a decision someone made rather than two loops that drifted.
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

async function readStored(): Promise<Settings> {
  return until(() => invoke<Settings>("get_settings"), SETTINGS_WAIT);
}

export async function initSettings(
  onChange: (settings: Settings) => void,
): Promise<Settings> {
  announce = onChange;

  // Wired before the read, not after.
  //
  // Doing it afterwards meant a failed `get_settings` threw past all of this,
  // so the Settings button had no listener and the panel could not be opened
  // at all — a dead control with no explanation. Bound first, clicking it
  // shows the panel and `save` refuses with a reason.
  el<HTMLButtonElement>("#shelf-settings").addEventListener("click", toggle);

  bind<HTMLSelectElement>("#setting-retention", (input) => ({
    retentionHours: input.value === "" ? null : Number(input.value),
  }));
  bind<HTMLInputElement>("#setting-max", (input) => ({ maxItems: Number(input.value) }));
  bind<HTMLInputElement>("#setting-hotkey", (input) => ({ hotkey: input.value.trim() }));
  bind<HTMLInputElement>("#setting-downscale", (input) => ({
    downscaleExports: input.checked,
  }));
  bind<HTMLSelectElement>("#setting-corner", (input) => ({
    dockCorner: input.value as Settings["dockCorner"],
  }));
  bind<HTMLSelectElement>("#setting-monitor", (input) => ({
    dockMonitor: input.value as Settings["dockMonitor"],
  }));
  bind<HTMLInputElement>("#setting-autostart", (input) => ({
    startAtLogin: input.checked,
  }));

  current = await readStored();
  loaded = true;
  fill();

  return current;
}

export function settingsOpen(): boolean {
  return !panel().hasAttribute("hidden");
}

/** Pins are edited from the tiles, not from this panel. */
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
  // Rethrown, not only logged.
  //
  // `set_pinned` used to return `()` on the Rust side, so this could never
  // reject and the `catch` was decoration: on a full disk or a read-only
  // profile the star lit, nothing was said, and the pin was gone at the next
  // launch — against the promise that pins are the one thing that survives a
  // restart. The console line stays for the diagnosis; the caller decides what
  // the user is told.
  try {
    await invoke("set_pinned", { pinned });
  } catch (error) {
    console.error("[shotshelf] could not save pinned captures", error);
    throw error instanceof Error ? error : new Error(String(error));
  }
}


/**
 * Put the panel away if it is up. `true` if it was.
 *
 * Exported so Escape has a rung for it. Without one, Escape in the settings
 * panel fell straight through to `popover.dismiss()`: the window went away and
 * `settingsOpen()` stayed true, because `toggle` is the only thing that
 * restores the `hidden` attribute. From then on `main.ts`'s first guard
 * swallowed every shelf key — arrows, space, Enter, Delete, `e` — and
 * `popover.busy()` stayed true so the launch dismissal never fired, against a
 * panel the column shape renders invisible anyway.
 */
export function closeSettings(): boolean {
  if (!settingsOpen()) return false;
  toggle();
  return true;
}

function toggle(): void {
  const open = panel().hasAttribute("hidden");
  if (open) panel().removeAttribute("hidden");
  else panel().setAttribute("hidden", "");
  el<HTMLElement>("#shelf-settings").classList.toggle("shelf__btn--on", open);
}

function bind<T extends HTMLElement & { value: string }>(
  selector: string,
  read: (input: T) => Partial<Settings>,
): void {
  const input = el<T>(selector);
  input.addEventListener("change", () => void save(read(input)));
}

async function save(patch: Partial<Settings>): Promise<void> {
  // Same rule as `persistPinned`: this sends the whole settings object,
  // `pinned` included, so writing it before the stored one was read would
  // replace the user's pins with an empty list.
  if (!loaded) {
    note().textContent = "Settings could not be loaded, so they cannot be saved.";
    return;
  }

  try {
    // The Rust side returns what it actually stored, so any clamping — or a
    // rejected shortcut — is reflected rather than assumed.
    current = await invoke<Settings>("set_settings", {
      settings: { ...current, ...patch },
    });
    note().textContent = "";
    announce(current);
  } catch (error) {
    note().textContent = String(error);
  }
  fill();
}

function option(value: string, label: string): HTMLOptionElement {
  const node = document.createElement("option");
  node.value = value;
  node.textContent = label;
  return node;
}

function fill(): void {
  // A hand-edited file can hold a value the presets don't cover — show it
  // rather than silently falling back to "Forever".
  const retention = el<HTMLSelectElement>("#setting-retention");
  const held = current.retentionHours === null ? "" : String(current.retentionHours);
  if (![...retention.options].some((choice) => choice.value === held)) {
    retention.append(option(held, `${held} hours`));
  }
  retention.value = held;

  el<HTMLInputElement>("#setting-max").value = String(current.maxItems);
  el<HTMLInputElement>("#setting-hotkey").value = current.hotkey;
  el<HTMLInputElement>("#setting-downscale").checked = current.downscaleExports;
  // These two can trust their options: Rust's `sanitise` normalises an unknown
  // spelling to the default before it ever comes back here, so unlike the
  // retention preset there is no hand-edited value to preserve.
  el<HTMLSelectElement>("#setting-corner").value = current.dockCorner;
  el<HTMLSelectElement>("#setting-monitor").value = current.dockMonitor;
  el<HTMLInputElement>("#setting-autostart").checked = current.startAtLogin;
}
