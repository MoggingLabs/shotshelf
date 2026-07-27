/**
 * Shelf state + rendering.
 *
 * The shelf is always on top and always running, so it never re-renders the
 * whole strip: a new capture prepends one node and drops at most one off the
 * end. Nothing here reads or writes the capture files themselves — removing a
 * tile takes it off the shelf and leaves the file exactly where it is.
 */

import { startDrag } from "@crabnebula/tauri-plugin-drag";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";

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
/** Pointer travel before a press on a tile becomes a drag rather than a click. */
const DRAG_THRESHOLD_PX = 6;
/** How long the copy button confirms itself. */
const COPIED_MS = 1100;

/** What the Rust side hands back to feed a native drag. */
interface DragSource {
  path: string;
  icon: string;
}

/** What ffmpeg could tell us about a recording. */
interface VideoDetails {
  poster: string | null;
  durationMs: number | null;
  bytes: number;
}

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

  // The poster frame is ours; the recording is not. Only the cache is cleared.
  if (removed?.kind === "video") {
    void invoke("forget_video", { path: removed.path }).catch(() => {});
  }

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
    actions(capture, name),
  );

  if (capture.kind === "video") {
    el.append(playBadge());
    // ffmpeg runs on the Rust side; the tile shows its film glyph until the
    // poster frame comes back, and keeps it if one never does.
    void describeVideo(el, capture);
  }

  // Press-and-move on the tile itself hands the capture to the OS. The action
  // buttons are excluded so copy and remove stay clickable.
  el.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    if ((event.target as HTMLElement).closest(".tile__action")) return;
    armDrag(el, capture, event);
  });

  return el;
}

/**
 * Wait for real pointer travel before starting a drag, so a click on a tile
 * stays a click and the strip can still be scrolled.
 */
function armDrag(node: HTMLElement, capture: Capture, start: PointerEvent): void {
  const from = { x: start.clientX, y: start.clientY };

  const onMove = (move: PointerEvent) => {
    const travelled = Math.hypot(move.clientX - from.x, move.clientY - from.y);
    if (travelled < DRAG_THRESHOLD_PX) return;
    disarm();
    void beginDrag(node, capture);
  };

  const disarm = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", disarm);
    window.removeEventListener("pointercancel", disarm);
  };

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", disarm);
  window.addEventListener("pointercancel", disarm);
}

/**
 * Hand the real file to the OS via `tauri-plugin-drag`. `mode: "copy"` is the
 * important part: dragging a capture out must never move the original.
 */
async function beginDrag(node: HTMLElement, capture: Capture): Promise<void> {
  node.classList.add("tile--dragging");
  const done = () => node.classList.remove("tile--dragging");

  try {
    const source = await invoke<DragSource>("prepare_drag", {
      path: capture.path,
      kind: capture.kind,
    });
    // Cancelling a drag just resolves with "Cancelled" — nothing to undo.
    await startDrag({ item: [source.path], icon: source.icon, mode: "copy" }, done);
  } catch (error) {
    console.error("[shotshelf] could not drag that capture out", error);
  } finally {
    done();
  }
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
  // The webview would otherwise start its own HTML5 image drag and shadow the
  // native one, which is what actually carries the file to other apps.
  img.draggable = false;
  // The file can be moved or deleted behind our back; say so rather than
  // showing a broken image.
  img.addEventListener("error", () => img.replaceWith(missingThumb()));
  return img;
}

/** Shown until ffmpeg produces a poster frame, and kept if it can't. */
function videoThumb(): HTMLElement {
  const el = document.createElement("div");
  el.className = "tile__thumb tile__thumb--glyph";
  el.textContent = "🎬";
  return el;
}

/** Marks a tile as a recording even once it looks like a still. */
function playBadge(): HTMLElement {
  const el = document.createElement("span");
  el.className = "tile__play";
  el.textContent = "▶";
  return el;
}

/**
 * Swap the film glyph for a real frame and put the recording's length and size
 * on the tile. A failure here is not worth surfacing — the tile stays useful,
 * and it still drags out the original file.
 */
async function describeVideo(el: HTMLElement, capture: Capture): Promise<void> {
  let details: VideoDetails;
  try {
    details = await invoke<VideoDetails>("video_details", { path: capture.path });
  } catch (error) {
    console.error("[shotshelf] could not read that recording", error);
    return;
  }

  const meta = el.querySelector<HTMLElement>(".tile__time");
  if (meta) meta.textContent = describeSize(details);

  if (!details.poster) return;

  const glyph = el.querySelector(".tile__thumb");
  if (!glyph) return;

  const frame = document.createElement("img");
  frame.className = "tile__thumb";
  frame.src = convertFileSrc(details.poster);
  frame.alt = fileName(capture.path);
  frame.decoding = "async";
  frame.draggable = false;
  // If the frame won't load, go back to the film glyph rather than leaving a
  // broken image on the shelf.
  frame.addEventListener("error", () => frame.replaceWith(videoThumb()));
  glyph.replaceWith(frame);
}

function describeSize(details: VideoDetails): string {
  const size = formatBytes(details.bytes);
  return details.durationMs === null
    ? size
    : `${formatDuration(details.durationMs)} · ${size}`;
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;

  const units = ["kB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }

  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit] ?? "GB"}`;
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

function actions(capture: Capture, name: string): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "tile__actions";
  wrap.append(copyButton(capture, name), removeButton(capture, name));
  return wrap;
}

/** For the apps that take a paste but refuse a file drop. */
function copyButton(capture: Capture, name: string): HTMLElement {
  const button = document.createElement("button");
  button.className = "tile__action";
  button.type = "button";
  button.title = `Copy ${name} to the clipboard`;
  button.textContent = "⧉";

  button.addEventListener("click", () => {
    void invoke("copy_capture", { path: capture.path, kind: capture.kind })
      .then(() => confirmOn(button, "✓"))
      .catch((error: unknown) => {
        console.error("[shotshelf] could not copy that capture", error);
        confirmOn(button, "!");
      });
  });

  return button;
}

function removeButton(capture: Capture, name: string): HTMLElement {
  const button = document.createElement("button");
  button.className = "tile__action tile__action--remove";
  button.type = "button";
  button.title = `Remove ${name} from the shelf (the file stays on disk)`;
  button.textContent = "×";
  button.addEventListener("click", () =>
    removeItem(`${capture.ts}:${capture.path}`),
  );
  return button;
}

function confirmOn(button: HTMLElement, glyph: string): void {
  const original = button.textContent;
  button.textContent = glyph;
  window.setTimeout(() => {
    button.textContent = original;
  }, COPIED_MS);
}

function fileName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}
