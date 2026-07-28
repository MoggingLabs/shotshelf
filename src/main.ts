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

const compareButton = el<HTMLButtonElement>("#shelf-compare");
const settingsButton = el<HTMLButtonElement>("#shelf-settings");
const hideButton = el<HTMLButtonElement>("#shelf-hide");
settingsButton.prepend(icon("settings", 14));
hideButton.prepend(icon("minus", 14));

const shelf = new Shelf(el<HTMLElement>("#shelf-items"), el<HTMLElement>("#shelf-count"), {
  onColumnChange: () => popover.onColumnChange(),
  // A comparison of one capture, or of five, is not a thing.
  onSelectionChange: (picked) => compareButton.toggleAttribute("hidden", picked !== 2),
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

/**
 * The keyboard path.
 *
 * The shelf is a popover you summon with a hotkey, so reaching for the mouse
 * to act on what it shows undoes the point of summoning it that way. Only
 * bound when the shelf is genuinely open — the auto-popup column never takes
 * focus, so it never sees these.
 */
document.addEventListener("keydown", (event) => {
  if (event.defaultPrevented) return;
  // Typing a hotkey into the settings panel is not a shelf command.
  if (settingsOpen() && event.key !== "Escape") return;

  switch (event.key) {
    case "Escape":
      // Escape backs out one level at a time: out of a preview first, and
      // only then out of the shelf. One key that closes two things at once is
      // one key that loses your place.
      if (!shelf.closePreview()) popover.dismiss();
      return;

    case "ArrowDown":
    case "ArrowUp":
      event.preventDefault();
      shelf.moveSelection(event.key === "ArrowDown" ? 1 : -1);
      return;

    case " ":
      event.preventDefault();
      shelf.togglePreview();
      return;

    case "Enter":
      event.preventDefault();
      shelf.copyPicked();
      return;

    case "Delete":
    case "Backspace":
      event.preventDefault();
      shelf.removePicked();
      return;

    default:
      return;
  }
});

hideButton.addEventListener("click", () => popover.dismiss());

compareButton.addEventListener("click", () => {
  void shelf.compare().catch((error: unknown) => {
    console.error("[shotshelf] could not compare those captures", error);
    say("Those two captures could not be compared.");
  });
});

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
  .then((dirs) => showWatchState(dirs))
  .catch((error: unknown) => {
    console.error("[shotshelf] could not read the watch folders", error);
    say("The catch engine is unavailable — no captures will be picked up.");
  })
  // Its own chain, deliberately. Asking whether captures can be checked for
  // credentials is advisory, and hanging it off the watch-folder call meant a
  // failure here was reported as the catch engine being down — a failure
  // attributed to the wrong subsystem is worse than one reported nowhere.
  .finally(() => {
    void textRecognitionAvailable()
      .then((available) => {
        if (!available) noteScanUnavailable();
      })
      .catch(() => {
        // Nothing to tell the user: not knowing whether checking is available
        // is not itself worth a line in the alert strip.
      });
  });
