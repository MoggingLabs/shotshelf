import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { icon } from "./icons";
import { initSettings, settingsOpen } from "./settings";
import {
  addCapture,
  applySettings,
  columnHeight,
  columnIsEmpty,
  holdColumn,
  isDragging,
  mountShelf,
  noteCapture,
  restorePinned,
  setMode,
  type Capture,
} from "./shelf";

/** How long the shelf stays up after launch, so a running app looks like one. */
const LAUNCH_MS = 4000;

function el<T extends HTMLElement>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`Shotshelf: missing element ${selector}`);
  return node;
}

const shelfWindow = getCurrentWindow();

// Windows rounds the window through DWM at a fixed 8px, so the panel's own
// radius has to match it there — see `window::round_corners`. The user agent is
// enough to tell the two apart and costs no dependency.
if (navigator.userAgent.includes("Windows")) {
  document.documentElement.dataset["os"] = "windows";
}

const mark = el<HTMLElement>("#shelf-mark");
const alert = el<HTMLElement>("#shelf-alert");
const root = el<HTMLElement>(".shelf");

const settingsButton = el<HTMLButtonElement>("#shelf-settings");
const hideButton = el<HTMLButtonElement>("#shelf-hide");
settingsButton.prepend(icon("settings", 14));
hideButton.prepend(icon("minus", 14));

mountShelf(el<HTMLElement>("#shelf-items"), el<HTMLElement>("#shelf-count"), () => {
  // A card aged out. Either the column needs to be shorter, or it is done.
  if (opened) return;
  if (columnIsEmpty()) dismiss();
  else showColumn();
});

// ── Popover lifetime ─────────────────────────────────────────────────────
//
// Two shapes, two rules:
//
// * **column** — a capture landed. A narrow strip sized to just the cards it
//   is holding, never focused, that empties itself a card at a time and then
//   drops back into the tray.
// * **browse** — you asked for it. The full grid, and it stays put while you
//   work in other windows until you actually close it.

let launchTimer: number | undefined;
/**
 * Whether the popover is open because you asked for it.
 *
 * Distinct from the render mode: the shelf starts in the browse *shape* for
 * its launch appearance, but nobody asked for it, so a capture arriving then
 * should still pop the column.
 */
let opened = false;

/**
 * The window is down. Front-end state only — this must not ask Rust to hide
 * anything, because `hide()` emits `shelf://hidden` and calling back would
 * re-enter it on every emit, the same loop `adoptBrowse` exists to avoid.
 */
function adoptHidden(): void {
  window.clearTimeout(launchTimer);
  opened = false;
  // Whatever shape it was in, the next capture gets the column.
  setMode("column");
}

function dismiss(): void {
  adoptHidden();
  void invoke("hide_shelf");
}

/** Put the column on screen at whatever height its cards need right now. */
function showColumn(): void {
  root.dataset["mode"] = "column";
  void invoke("show_shelf", { focus: false, height: columnHeight() });
}

/**
 * Rust has already sized, anchored, shown and focused the window by the time
 * this runs — all that is left is to render the right shape.
 *
 * It must not call back into `show_shelf`: `open()` emits this event, so doing
 * so re-entered `open()` on every emit and re-opened the window forever, which
 * made every dismissal look broken.
 */
function adoptBrowse(): void {
  opened = true;
  root.dataset["mode"] = "browse";
  setMode("browse");
}

// Hovering or focusing the column stops its cards ageing out under the pointer.
root.addEventListener("pointerenter", () => holdColumn(true));
root.addEventListener("pointerleave", () => holdColumn(false));

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") dismiss();
});

// Note what is deliberately absent: nothing dismisses on focus loss. An opened
// popover is sticky by design, and the column is never focused in the first
// place — it is the card timers that end it.
void shelfWindow.onFocusChanged(({ payload: focused }) => {
  holdColumn(focused);
  if (focused) window.clearTimeout(launchTimer);
});

hideButton.addEventListener("click", dismiss);

if (!import.meta.env.DEV) {
  window.addEventListener("contextmenu", (event) => event.preventDefault());
}

// ── Captures ─────────────────────────────────────────────────────────────

void listen<Capture>("capture://new", ({ payload }) => {
  // Open on purpose? Then don't reshape the window under you — just add it.
  if (opened) {
    addCapture(payload);
    return;
  }

  noteCapture(payload);
  showColumn();
});

// Shown once at launch, then treated exactly like an empty column.
launchTimer = window.setTimeout(() => {
  if (!isDragging() && !settingsOpen()) dismiss();
}, LAUNCH_MS);

// Settings first: the shelf reads its limits from them, and pinned captures
// have to be back before anything new lands on top.
void initSettings(() => applySettings())
  .then((settings) => restorePinned(settings))
  .catch((error: unknown) => {
    console.error("[shotshelf] could not load settings", error);
    say("Settings could not be loaded — running on defaults.");
  });

void invoke<string[]>("catch_watch_dirs")
  .then((dirs) => {
    console.info("[shotshelf] watching", dirs);
    mark.classList.add("shelf__mark--live");
    mark.title = describeWatch(dirs);
    if (dirs.length === 0) say("No capture folders found — watching the clipboard only.");
  })
  .catch((error: unknown) => {
    console.error("[shotshelf] could not read the watch folders", error);
    say("The catch engine is unavailable — no captures will be picked up.");
  });

// Rust shows the window when the tray is clicked or the hotkey fires; this
// only reshapes the front-end to match.
void listen("shelf://opened", () => adoptBrowse());

// And the other direction: closing from the tray, its menu or the hotkey hides
// the window in Rust without the front-end ever hearing about it.
void listen("shelf://hidden", () => adoptHidden());

/** The alert strip stays out of the way until there is something to say. */
function say(message: string): void {
  alert.textContent = message;
  alert.removeAttribute("hidden");
}

function describeWatch(dirs: string[]): string {
  if (dirs.length === 0) return "Watching the clipboard only";
  return [
    `Watching ${dirs.length} folder${dirs.length === 1 ? "" : "s"} + the clipboard`,
    ...dirs,
  ].join("\n");
}
