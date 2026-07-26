/**
 * Shelf state + rendering.
 *
 * The shelf is always on top and always running, so it never re-renders the
 * whole strip: a new capture prepends one node and drops at most one off the
 * end. Nothing here reads or writes the capture files themselves — removing a
 * tile takes it off the shelf and leaves the file exactly where it is.
 */

import { convertFileSrc } from "@tauri-apps/api/core";

export type CaptureKind = "image" | "video";

/** Payload of the Rust `capture://new` event. */
export interface Capture {
  path: string;
  kind: CaptureKind;
  /** Unix milliseconds. */
  ts: number;
}

interface ShelfItem extends Capture {
  id: string;
  node: HTMLElement;
}

/** How many captures the shelf holds before the oldest falls off the end. */
const MAX_ITEMS = 50;
/** How long a freshly caught tile stays highlighted. */
const HIGHLIGHT_MS = 1400;

/** Newest first, matching how the shelf reads top to bottom. */
const items: ShelfItem[] = [];

let list: HTMLElement;
let count: HTMLElement;

export function mountShelf(listEl: HTMLElement, countEl: HTMLElement): void {
  list = listEl;
  count = countEl;
  showEmptyState();
}

export function addCapture(capture: Capture): void {
  const id = `${capture.ts}:${capture.path}`;
  if (items.some((item) => item.id === id)) return;

  if (items.length === 0) list.replaceChildren();

  const node = tile(capture);
  items.unshift({ ...capture, id, node });
  list.prepend(node);

  // Highlight briefly so the eye lands on what just arrived.
  node.classList.add("tile--new");
  window.setTimeout(() => node.classList.remove("tile--new"), HIGHLIGHT_MS);

  while (items.length > MAX_ITEMS) items.pop()?.node.remove();

  list.scrollTop = 0;
  updateCount();
}

/**
 * Take a capture off the shelf. The file on disk is deliberately untouched —
 * the shelf is a view of your captures, not their owner.
 */
function removeItem(id: string): void {
  const index = items.findIndex((item) => item.id === id);
  if (index === -1) return;

  const [removed] = items.splice(index, 1);
  removed?.node.remove();

  if (items.length === 0) showEmptyState();
  else updateCount();
}

// Count and layout both key off how many items are on the shelf, so they are
// updated together — a stale `empty` flag centres and shrinks the tiles.
function updateCount(): void {
  count.textContent = String(items.length);
  list.dataset["empty"] = String(items.length === 0);
}

function showEmptyState(): void {
  list.replaceChildren(emptyState());
  updateCount();
}

function emptyState(): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "empty";

  const frame = document.createElement("div");
  frame.className = "empty__frame";
  frame.textContent = "📸";

  const title = document.createElement("p");
  title.className = "empty__title";
  title.textContent = "The shelf is empty";

  const hint = document.createElement("p");
  hint.className = "empty__hint";
  hint.textContent =
    "Screenshots and recordings will land here the moment you take them.";

  wrap.append(frame, title, hint);
  return wrap;
}

function tile(capture: Capture): HTMLElement {
  const name = fileName(capture.path);

  const el = document.createElement("article");
  el.className = "tile";
  el.title = capture.path;

  el.append(
    capture.kind === "video" ? videoThumb() : imageThumb(capture.path, name),
    caption(name, capture.ts),
    removeButton(`${capture.ts}:${capture.path}`, name),
  );

  return el;
}

/**
 * Rendered straight from disk through the asset protocol — never inlined as
 * base64, which would put whole screenshots in the DOM. The URL shape differs
 * per OS (`http://asset.localhost/…` on Windows, `asset://localhost/…` on
 * macOS); `convertFileSrc` picks the right one and the CSP allows both.
 */
function imageThumb(path: string, name: string): HTMLElement {
  const img = document.createElement("img");
  img.className = "tile__thumb";
  img.src = convertFileSrc(path);
  img.alt = name;
  img.loading = "lazy";
  img.decoding = "async";
  // The file can be moved or deleted behind our back; say so rather than
  // showing a broken image.
  img.addEventListener("error", () => img.replaceWith(missingThumb()));
  return img;
}

/** Poster frames arrive in phase 05; until then a video gets a marker tile. */
function videoThumb(): HTMLElement {
  const el = document.createElement("div");
  el.className = "tile__thumb tile__thumb--glyph";
  el.textContent = "🎬";
  return el;
}

function missingThumb(): HTMLElement {
  const el = document.createElement("div");
  el.className = "tile__thumb tile__thumb--glyph tile__thumb--missing";
  el.textContent = "⚠";
  el.title = "This file is no longer where it was captured";
  return el;
}

function caption(name: string, ts: number): HTMLElement {
  const el = document.createElement("div");
  el.className = "tile__caption";

  const label = document.createElement("span");
  label.className = "tile__name";
  label.textContent = name;

  const time = document.createElement("span");
  time.className = "tile__time";
  time.textContent = new Date(ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  el.append(label, time);
  return el;
}

function removeButton(id: string, name: string): HTMLElement {
  const button = document.createElement("button");
  button.className = "tile__remove";
  button.type = "button";
  button.title = `Remove ${name} from the shelf (the file stays on disk)`;
  button.textContent = "×";
  button.addEventListener("click", () => removeItem(id));
  return button;
}

function fileName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}
