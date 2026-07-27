import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { icon } from "./icons";
import { initSettings, settingsOpen } from "./settings";
import {
  addCapture,
  applySettings,
  isDragging,
  mountShelf,
  restorePinned,
  type Capture,
} from "./shelf";

/**
 * How long a capture-triggered peek stays on screen before dismissing itself.
 * A shelf that appears on every screenshot and *stays* is the thing people
 * end up disabling, so a peek is deliberately short-lived.
 */
const PEEK_MS = 4000;
/** Shorter grace once the pointer has left again — you already looked. */
const PEEK_AFTER_HOVER_MS = 1200;

function el<T extends HTMLElement>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`Shotshelf: missing element ${selector}`);
  return node;
}

const shelfWindow = getCurrentWindow();
const mark = el<HTMLElement>("#shelf-mark");
const alert = el<HTMLElement>("#shelf-alert");
const root = el<HTMLElement>(".shelf");

const settingsButton = el<HTMLButtonElement>("#shelf-settings");
const hideButton = el<HTMLButtonElement>("#shelf-hide");
settingsButton.prepend(icon("settings", 14));
hideButton.prepend(icon("minus", 14));

mountShelf(el<HTMLElement>("#shelf-items"), el<HTMLElement>("#shelf-count"));

// ── Popover lifetime ─────────────────────────────────────────────────────
// The shelf hangs off the tray icon rather than living on screen, so the only
// interesting question is when it should leave.

let peekTimer: number | undefined;
let hovering = false;

function dismiss(): void {
  window.clearTimeout(peekTimer);
  void invoke("hide_shelf");
}

function schedulePeekEnd(delay: number): void {
  window.clearTimeout(peekTimer);
  peekTimer = window.setTimeout(() => {
    // Anything that means "I am using this" wins over the timer.
    if (hovering || isDragging() || settingsOpen()) return;
    dismiss();
  }, delay);
}

root.addEventListener("pointerenter", () => {
  hovering = true;
  window.clearTimeout(peekTimer);
});

root.addEventListener("pointerleave", () => {
  hovering = false;
  schedulePeekEnd(PEEK_AFTER_HOVER_MS);
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") dismiss();
});

// Clicking outside a popover closes it. A drag is the exception: handing a file
// to the OS takes focus away, and vanishing mid-drag would break the one
// feature the shelf exists for.
void shelfWindow.onFocusChanged(({ payload: focused }) => {
  if (focused) {
    window.clearTimeout(peekTimer);
    return;
  }
  if (isDragging() || settingsOpen()) return;
  dismiss();
});

hideButton.addEventListener("click", dismiss);

if (!import.meta.env.DEV) {
  window.addEventListener("contextmenu", (event) => event.preventDefault());
}

// ── Captures ─────────────────────────────────────────────────────────────

void listen<Capture>("capture://new", ({ payload }) => {
  addCapture(payload);
  // Peek without focus: you are usually still typing in whatever you captured.
  void invoke("show_shelf", { focus: false });
  schedulePeekEnd(PEEK_MS);
});

// The launch peek dismisses itself the same way a capture's does.
schedulePeekEnd(PEEK_MS);

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
