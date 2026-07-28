/**
 * The settings surface.
 *
 * Deliberately small: where the shelf sits, how long captures stay, and the
 * shortcut that summons it. Everything lives in a local JSON file — no
 * accounts, no sync, nothing leaves the device.
 */

import { invoke } from "@tauri-apps/api/core";

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
   * all, which is the point of offering the switch to someone who chose this
   * app for being local-only.
   */
  checkForUpdates: boolean;
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

/** How many times to re-ask before giving up. The race is milliseconds wide. */
const LOAD_ATTEMPTS = 5;
const LOAD_RETRY_MS = 120;

async function readStored(): Promise<Settings> {
  let last: unknown;
  for (let attempt = 0; attempt < LOAD_ATTEMPTS; attempt += 1) {
    try {
      return await invoke<Settings>("get_settings");
    } catch (error) {
      // Almost always "state not managed" — start-up has not reached
      // `app.manage` yet. Worth re-asking rather than losing the user's pins.
      last = error;
      await new Promise((resume) => setTimeout(resume, LOAD_RETRY_MS));
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
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
  try {
    await invoke("set_pinned", { pinned });
  } catch (error) {
    console.error("[shotshelf] could not save pinned captures", error);
  }
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
}
