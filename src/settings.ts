/**
 * The settings surface.
 *
 * Deliberately small: where the shelf sits, how long captures stay, and the
 * shortcut that summons it. Everything lives in a local JSON file — no
 * accounts, no sync, nothing leaves the device.
 */

import { invoke } from "@tauri-apps/api/core";
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
  pinned: PinnedItem[];
}

/**
 * Mirrors the Rust defaults so the shelf has sane limits from its very first
 * frame — a capture can land before the settings file has been read.
 */
const DEFAULTS: Settings = {
  retentionHours: null,
  maxItems: 50,
  hotkey: "CommandOrControl+Shift+S",
  pinned: [],
};

let current: Settings = DEFAULTS;
let announce: (settings: Settings) => void = () => {};

function el<T extends HTMLElement>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`Shotshelf: missing element ${selector}`);
  return node;
}

const panel = () => el<HTMLElement>("#settings-panel");
const note = () => el<HTMLElement>("#settings-note");

export function currentSettings(): Settings {
  return current;
}

export async function initSettings(
  onChange: (settings: Settings) => void,
): Promise<Settings> {
  announce = onChange;
  current = await invoke<Settings>("get_settings");

  el<HTMLButtonElement>("#shelf-settings").addEventListener("click", toggle);

  bind<HTMLSelectElement>("#setting-retention", (input) => ({
    retentionHours: input.value === "" ? null : Number(input.value),
  }));
  bind<HTMLInputElement>("#setting-max", (input) => ({ maxItems: Number(input.value) }));
  bind<HTMLInputElement>("#setting-hotkey", (input) => ({ hotkey: input.value.trim() }));

  fill();

  return current;
}

export function settingsOpen(): boolean {
  return !panel().hasAttribute("hidden");
}

/** Pins are edited from the tiles, not from this panel. */
export async function persistPinned(pinned: PinnedItem[]): Promise<void> {
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
}
