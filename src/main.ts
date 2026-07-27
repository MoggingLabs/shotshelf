import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { icon } from "./icons";
import { initSettings } from "./settings";
import { addCapture, applySettings, mountShelf, restorePinned, type Capture } from "./shelf";

function el<T extends HTMLElement>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`Shotshelf: missing element ${selector}`);
  return node;
}

const shelfWindow = getCurrentWindow();
const mark = el<HTMLElement>("#shelf-mark");
const alert = el<HTMLElement>("#shelf-alert");

const settingsButton = el<HTMLButtonElement>("#shelf-settings");
const hideButton = el<HTMLButtonElement>("#shelf-hide");
settingsButton.prepend(icon("settings", 14));
hideButton.prepend(icon("minus", 14));

mountShelf(el<HTMLElement>("#shelf-items"), el<HTMLElement>("#shelf-count"));

// Hiding never quits: the tray icon is how the shelf comes back.
hideButton.addEventListener("click", () => {
  void shelfWindow.hide();
});

// A shelf is a widget, not a web page — but keep the webview context menu in
// dev so devtools stay one right-click away.
if (!import.meta.env.DEV) {
  window.addEventListener("contextmenu", (event) => event.preventDefault());
}

void listen<Capture>("capture://new", ({ payload }) => {
  addCapture(payload);
  // Surface the shelf, but never steal focus: you are usually still typing in
  // whatever you just captured.
  void shelfWindow.show();
});

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
    // Worth interrupting for: with no folders, only clipboard captures arrive.
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
  return [`Watching ${dirs.length} folder${dirs.length === 1 ? "" : "s"} + the clipboard`, ...dirs].join(
    "\n",
  );
}
