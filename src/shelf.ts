/**
 * Shelf state + rendering.
 *
 * Tiles are a two-column grid at 16:10 — close enough to a screen's own shape
 * that a capture arrives almost uncropped. The previous 3.8:1 letterbox kept
 * only the middle 46% of a 1080p screenshot and threw away the top, which is
 * exactly where a screenshot keeps its meaning: title bars, headers, the first
 * line of a terminal. Dark captures rendered as empty holes.
 *
 * The shelf is always on top and always running, so it never re-renders the
 * whole strip: a new capture inserts one node and drops at most one off the end.
 * Nothing here reads or writes the capture files themselves — removing a tile
 * takes it off the shelf and leaves the file exactly where it is.
 */

import { startDrag } from "@crabnebula/tauri-plugin-drag";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { icon, solidIcon } from "./icons";
import { currentSettings, persistPinned, type Settings } from "./settings";

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
  /** Pinned captures ignore retention and survive a restart. */
  pinned: boolean;
}

/** What ffmpeg could tell us about a recording. */
interface VideoDetails {
  poster: string | null;
  durationMs: number | null;
  bytes: number;
}

/** What the Rust side hands back to feed a native drag. */
interface DragSource {
  path: string;
  icon: string;
}

/** How often expired captures are swept off the shelf. */
const SWEEP_MS = 15_000;
/** How long a freshly caught tile stays highlighted. */
const HIGHLIGHT_MS = 1400;
/** Pointer travel before a press on a tile becomes a drag rather than a click. */
const DRAG_THRESHOLD_PX = 6;
/** How long the copy button confirms itself. */
const COPIED_MS = 1100;

/** Newest first, matching how the shelf reads top to bottom. */
const items: ShelfItem[] = [];
/** Day heading → the grid its tiles live in, so inserts stay incremental. */
const groups = new Map<string, HTMLElement>();

let list: HTMLElement;
let count: HTMLElement;
/** An OS drag steals focus; the popover must not read that as a dismissal. */
let dragging = false;

export function isDragging(): boolean {
  return dragging;
}

export function mountShelf(listEl: HTMLElement, countEl: HTMLElement): void {
  list = listEl;
  count = countEl;
  showEmptyState();
  window.setInterval(sweep, SWEEP_MS);
}

/** Put pinned captures back after a restart, oldest first so order survives. */
export function restorePinned(settings: Settings): void {
  for (const item of [...settings.pinned].sort((a, b) => a.ts - b.ts)) {
    addCapture(item, { pinned: true, highlight: false });
  }
}

/** Re-apply limits when the settings change; retention is swept on a timer. */
export function applySettings(): void {
  trim();
  sweep();
}

export function addCapture(
  capture: Capture,
  options: { pinned?: boolean; highlight?: boolean } = {},
): void {
  const id = `${capture.ts}:${capture.path}`;
  if (items.some((item) => item.id === id)) return;

  if (items.length === 0) {
    list.replaceChildren();
    groups.clear();
  }

  const pinned = options.pinned ?? false;
  const node = tile(capture, pinned);
  items.unshift({ ...capture, id, node, pinned });
  gridFor(capture.ts).prepend(node);

  if (options.highlight ?? true) {
    node.classList.add("tile--new");
    window.setTimeout(() => node.classList.remove("tile--new"), HIGHLIGHT_MS);
  }

  trim();

  list.scrollTop = 0;
  updateCount();
}

// ── Day grouping ─────────────────────────────────────────────────────────
// A shelf of forty identical tiles is a wall. Dating them gives the eye
// somewhere to rest and makes "the one from yesterday" findable.

function dayKey(ts: number): string {
  const date = new Date(ts);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function dayLabel(ts: number): string {
  const today = new Date();
  const midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();

  if (ts >= midnight) return "Today";
  if (ts >= midnight - 86_400_000) return "Yesterday";
  return new Date(ts).toLocaleDateString([], { day: "numeric", month: "long" });
}

function gridFor(ts: number): HTMLElement {
  const key = dayKey(ts);
  const existing = groups.get(key);
  if (existing) return existing;

  const section = document.createElement("section");
  section.className = "group";
  section.dataset["day"] = key;

  const heading = document.createElement("h2");
  heading.className = "group__label";
  heading.textContent = dayLabel(ts);

  const grid = document.createElement("div");
  grid.className = "group__grid";
  section.append(heading, grid);

  // Newest day first, so a restored pin from last week lands at the bottom.
  const later = [...list.children].find(
    (child) => (child as HTMLElement).dataset["day"]! < key,
  );
  if (later) list.insertBefore(section, later);
  else list.append(section);

  groups.set(key, grid);
  return grid;
}

function pruneEmptyGroups(): void {
  for (const [key, grid] of groups) {
    if (grid.childElementCount > 0) continue;
    grid.parentElement?.remove();
    groups.delete(key);
  }
}

// ── Limits ───────────────────────────────────────────────────────────────

/**
 * Drop the oldest unpinned captures once the shelf is over its limit. Pinned
 * ones are never trimmed — that is the whole point of pinning them.
 */
function trim(): void {
  const { maxItems } = currentSettings();

  for (let index = items.length - 1; index >= 0 && items.length > maxItems; index -= 1) {
    const item = items[index];
    if (!item || item.pinned) continue;
    items.splice(index, 1);
    item.node.remove();
  }

  pruneEmptyGroups();
  if (items.length === 0) showEmptyState();
  else updateCount();
}

/**
 * Retention only ever takes captures off the shelf. The files stay exactly
 * where the OS wrote them.
 */
function sweep(): void {
  const { retentionHours } = currentSettings();
  if (retentionHours === null) return;

  const cutoff = Date.now() - retentionHours * 3_600_000;
  for (const item of items.filter((entry) => !entry.pinned && entry.ts < cutoff)) {
    removeItem(item.id);
  }
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

  pruneEmptyGroups();
  if (items.length === 0) showEmptyState();
  else updateCount();

  void savePins();
}

/** Pins are the only shelf state worth surviving a restart. */
function savePins(): Promise<void> {
  return persistPinned(
    items.filter((item) => item.pinned).map(({ path, kind, ts }) => ({ path, kind, ts })),
  );
}

function togglePin(id: string, button: HTMLButtonElement): void {
  const item = items.find((candidate) => candidate.id === id);
  if (!item) return;

  item.pinned = !item.pinned;
  button.classList.toggle("tile__action--on", item.pinned);
  button.title = pinLabel(item.pinned);
  item.node.classList.toggle("tile--pinned", item.pinned);
  void savePins();
}

function pinLabel(pinned: boolean): string {
  return pinned
    ? "Pinned — kept until you unpin it"
    : "Pin to keep this past the retention window";
}

// Count and layout both key off how many items are on the shelf, so they are
// updated together — a stale `empty` flag centres the grid on nothing.
function updateCount(): void {
  count.textContent =
    items.length === 0
      ? "Shelf"
      : `${items.length} capture${items.length === 1 ? "" : "s"}`;
  list.dataset["empty"] = String(items.length === 0);
  // The popover is hidden most of the time, so the tray icon carries the count.
  void invoke("set_capture_count", { count: items.length }).catch(() => {});
}

function showEmptyState(): void {
  groups.clear();
  list.replaceChildren(emptyState());
  updateCount();
}

function emptyState(): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "empty";

  const frame = document.createElement("div");
  frame.className = "empty__frame";
  frame.append(icon("camera", 26));

  const title = document.createElement("p");
  title.className = "empty__title";
  title.textContent = "Nothing on the shelf";

  const hint = document.createElement("p");
  hint.className = "empty__hint";
  hint.textContent = "Screenshots and recordings land here the moment you take them.";

  wrap.append(frame, title, hint);
  return wrap;
}

// ── Tiles ────────────────────────────────────────────────────────────────

function tile(capture: Capture, pinned: boolean): HTMLElement {
  const name = fileName(capture.path);

  const el = document.createElement("article");
  el.className = "tile";
  el.title = capture.path;
  el.classList.toggle("tile--pinned", pinned);

  el.append(
    capture.kind === "video" ? videoThumb() : imageThumb(capture.path, name),
    label(name),
    actions(capture, name, pinned),
  );

  if (capture.kind === "video") {
    el.append(badge());
    void describeVideo(el, capture);
  }

  // Press-and-move on the tile itself hands the capture to the OS. The action
  // buttons are excluded so copy, pin and remove stay clickable.
  el.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    if ((event.target as HTMLElement).closest(".tile__action")) return;
    armDrag(el, capture, event);
  });

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
  // The webview would otherwise start its own HTML5 image drag and shadow the
  // native one, which is what actually carries the file to other apps.
  img.draggable = false;
  img.addEventListener("error", () => img.replaceWith(glyphThumb("alert", "missing")));
  return img;
}

/** Shown until ffmpeg produces a poster frame, and kept if it can't. */
function videoThumb(): HTMLElement {
  return glyphThumb("film");
}

function glyphThumb(name: "film" | "alert", modifier?: string): HTMLElement {
  const el = document.createElement("div");
  el.className = `tile__thumb tile__thumb--glyph${modifier ? ` tile__thumb--${modifier}` : ""}`;
  el.append(icon(name, 22));
  return el;
}

/** Marks a recording as one even once it looks like a still. */
function badge(): HTMLElement {
  const el = document.createElement("span");
  el.className = "tile__badge";
  el.append(solidIcon("play", 9));
  const text = document.createElement("span");
  text.className = "tile__badge-text";
  el.append(text);
  return el;
}

/** The filename only earns its space on hover; the picture is the identity. */
function label(name: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "tile__label";
  el.textContent = name;
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

  const text = el.querySelector<HTMLElement>(".tile__badge-text");
  if (text) text.textContent = describeSize(details);

  if (!details.poster) return;

  const glyph = el.querySelector(".tile__thumb");
  if (!glyph) return;

  const frame = document.createElement("img");
  frame.className = "tile__thumb";
  frame.src = convertFileSrc(details.poster);
  frame.alt = fileName(capture.path);
  frame.decoding = "async";
  frame.draggable = false;
  frame.addEventListener("error", () => frame.replaceWith(videoThumb()));
  glyph.replaceWith(frame);
}

function describeSize(details: VideoDetails): string {
  const size = formatBytes(details.bytes);
  return details.durationMs === null ? size : `${formatDuration(details.durationMs)} · ${size}`;
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

// ── Actions ──────────────────────────────────────────────────────────────

function actions(capture: Capture, name: string, pinned: boolean): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "tile__actions";
  wrap.append(
    pinButton(`${capture.ts}:${capture.path}`, pinned),
    copyButton(capture, name),
    removeButton(capture, name),
  );
  return wrap;
}

function action(name: Parameters<typeof icon>[0], title: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.className = "tile__action";
  button.type = "button";
  button.title = title;
  button.append(icon(name, 13));
  return button;
}

function pinButton(id: string, pinned: boolean): HTMLButtonElement {
  const button = action("star", pinLabel(pinned));
  button.classList.toggle("tile__action--on", pinned);
  button.addEventListener("click", () => togglePin(id, button));
  return button;
}

/** For the apps that take a paste but refuse a file drop. */
function copyButton(capture: Capture, name: string): HTMLButtonElement {
  const button = action("copy", `Copy ${name} to the clipboard`);

  button.addEventListener("click", () => {
    void invoke("copy_capture", { path: capture.path, kind: capture.kind })
      .then(() => flash(button, true))
      .catch((error: unknown) => {
        console.error("[shotshelf] could not copy that capture", error);
        flash(button, false);
      });
  });

  return button;
}

function removeButton(capture: Capture, name: string): HTMLButtonElement {
  const button = action("close", `Remove ${name} from the shelf (the file stays on disk)`);
  button.classList.add("tile__action--remove");
  button.addEventListener("click", () => removeItem(`${capture.ts}:${capture.path}`));
  return button;
}

function flash(button: HTMLElement, ok: boolean): void {
  button.classList.add(ok ? "tile__action--ok" : "tile__action--bad");
  window.setTimeout(() => button.classList.remove("tile__action--ok", "tile__action--bad"), COPIED_MS);
}

// ── Dragging out ─────────────────────────────────────────────────────────

/**
 * Wait for real pointer travel before starting a drag, so a click on a tile
 * stays a click and the grid can still be scrolled.
 */
function armDrag(node: HTMLElement, capture: Capture, start: PointerEvent): void {
  const from = { x: start.clientX, y: start.clientY };

  const onMove = (move: PointerEvent) => {
    if (Math.hypot(move.clientX - from.x, move.clientY - from.y) < DRAG_THRESHOLD_PX) return;
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
  dragging = true;
  const done = () => {
    node.classList.remove("tile--dragging");
    dragging = false;
  };

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

function fileName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}
