/**
 * Wiring, and only wiring.
 *
 * Every rule this app has lives in a module that can be tested on its own —
 * what the shelf keeps, when the popover is up, what a card looks like. This
 * file exists to introduce them to each other and to the events coming out of
 * Rust, and it should stay boring enough that nothing has to be debugged here.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { icon } from "./icons.ts";
import { Popover } from "./popover.ts";
import { currentSettings, initSettings, settingsOpen } from "./settings.ts";
import { textRecognitionAvailable } from "./shelf/bridge.ts";
import { Shelf, type Capture } from "./shelf/index.ts";
import { noteScanUnavailable, say, showWatchState } from "./status.ts";

function el<T extends HTMLElement>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`Shotshelf: missing element ${selector}`);
  return node;
}

// Windows rounds the window through DWM at a fixed 8px, so the panel's own
// radius has to match it there — see `window::round_corners`. The user agent is
// enough to tell the two apart and costs no dependency.
if (navigator.userAgent.includes("Windows")) {
  document.documentElement.dataset["os"] = "windows";
}

const shelfWindow = getCurrentWindow();
const root = el<HTMLElement>(".shelf");

const settingsButton = el<HTMLButtonElement>("#shelf-settings");
const hideButton = el<HTMLButtonElement>("#shelf-hide");
settingsButton.prepend(icon("settings", 14));
hideButton.prepend(icon("minus", 14));

const shelf = new Shelf(el<HTMLElement>("#shelf-items"), el<HTMLElement>("#shelf-count"), {
  onColumnChange: () => popover.onColumnChange(),
  limits: () => currentSettings(),
});

const popover = new Popover(root, shelf, {
  // An OS drag steals focus and the settings panel is a deliberate act; a
  // launch appearance must not vanish out from under either.
  busy: () => shelf.dragging || settingsOpen(),
});

shelf.start();
popover.scheduleLaunchDismissal();

// ── Input ────────────────────────────────────────────────────────────────

// Hovering or focusing the column stops its cards ageing out under the pointer.
root.addEventListener("pointerenter", () => shelf.holdColumn("pointer", true));
root.addEventListener("pointerleave", () => shelf.holdColumn("pointer", false));

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") popover.dismiss();
});

hideButton.addEventListener("click", () => popover.dismiss());

// Note what is deliberately absent: nothing dismisses on focus loss. An opened
// popover is sticky by design, and the column is never focused in the first
// place — it is the card timers that end it.
void shelfWindow.onFocusChanged(({ payload: focused }) => popover.onFocusChanged(focused));

if (!import.meta.env.DEV) {
  window.addEventListener("contextmenu", (event) => event.preventDefault());
}

// ── Events out of Rust ───────────────────────────────────────────────────

void listen<Capture>("capture://new", ({ payload }) => popover.catch(payload));

// Rust shows or hides the window on a tray click, a menu item or the hotkey;
// these only reshape the front-end to match. Neither may call back into Rust.
void listen("shelf://opened", () => popover.adoptBrowse());
void listen("shelf://hidden", () => popover.adoptHidden());

// ── Start-up ─────────────────────────────────────────────────────────────

// Settings first: the shelf reads its limits from them, and pinned captures
// have to be back before anything new lands on top.
void initSettings(() => shelf.applySettings())
  .then((settings) => shelf.restorePinned(settings))
  .catch((error: unknown) => {
    console.error("[shotshelf] could not load settings", error);
    say("Settings could not be loaded — running on defaults.");
  });

void invoke<string[]>("catch_watch_dirs")
  .then(async (dirs) => {
    showWatchState(dirs);
    // Said after the watch state, so it lands in the same tooltip.
    if (!(await textRecognitionAvailable())) noteScanUnavailable();
  })
  .catch((error: unknown) => {
    console.error("[shotshelf] could not read the watch folders", error);
    say("The catch engine is unavailable — no captures will be picked up.");
  });
