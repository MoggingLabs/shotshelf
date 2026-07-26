import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { addCapture, mountShelf, type Capture } from "./shelf";

function el<T extends HTMLElement>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`Shotshelf: missing element ${selector}`);
  return node;
}

const shelfWindow = getCurrentWindow();
const status = el<HTMLElement>("#shelf-status-text");
const dot = el<HTMLElement>("#shelf-dot");

mountShelf(el<HTMLElement>("#shelf-items"), el<HTMLElement>("#shelf-count"));

// Hiding never quits: the tray icon is how the shelf comes back.
el<HTMLButtonElement>("#shelf-hide").addEventListener("click", () => {
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

void invoke<string[]>("catch_watch_dirs")
  .then((dirs) => {
    console.info("[shotshelf] watching", dirs);
    dot.classList.add("shelf__dot--live");
    status.textContent = describeWatch(dirs);
  })
  .catch((error: unknown) => {
    console.error("[shotshelf] could not read the watch folders", error);
    status.textContent = "Catch engine unavailable";
  });

function describeWatch(dirs: string[]): string {
  if (dirs.length === 0) return "Watching the clipboard — no capture folders found";
  return `Watching ${dirs.length} folder${dirs.length === 1 ? "" : "s"} + clipboard`;
}
