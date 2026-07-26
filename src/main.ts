import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { renderShelf, type Capture } from "./shelf";

function el<T extends HTMLElement>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`Shotshelf: missing element ${selector}`);
  return node;
}

const shelfWindow = getCurrentWindow();
const list = el<HTMLElement>("#shelf-items");
const count = el<HTMLElement>("#shelf-count");
const status = el<HTMLElement>("#shelf-status-text");
const dot = el<HTMLElement>("#shelf-dot");

// Hiding never quits: the tray icon is how the shelf comes back.
el<HTMLButtonElement>("#shelf-hide").addEventListener("click", () => {
  void shelfWindow.hide();
});

// A shelf is a widget, not a web page — but keep the webview context menu in
// dev so devtools stay one right-click away.
if (!import.meta.env.DEV) {
  window.addEventListener("contextmenu", (event) => event.preventDefault());
}

renderShelf(list, count);

// ── Catch engine ────────────────────────────────────────────────────────
// Phase 02 only reports captures; the thumbnail strip arrives in phase 03.

let caught = 0;

void listen<Capture>("capture://new", ({ payload }) => {
  caught += 1;
  console.info("[shotshelf] capture://new", payload);
  status.textContent = `${caught} caught · ${payload.kind} · ${fileName(payload.path)}`;
});

void invoke<string[]>("catch_watch_dirs")
  .then((dirs) => {
    console.info("[shotshelf] watching", dirs);
    dot.classList.add("shelf__dot--live");
    if (caught === 0) status.textContent = describeWatch(dirs);
  })
  .catch((error: unknown) => {
    console.error("[shotshelf] could not read the watch folders", error);
    status.textContent = "Catch engine unavailable";
  });

function describeWatch(dirs: string[]): string {
  if (dirs.length === 0) return "Watching the clipboard — no capture folders found";
  return `Watching ${dirs.length} folder${dirs.length === 1 ? "" : "s"} + clipboard`;
}

function fileName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}
