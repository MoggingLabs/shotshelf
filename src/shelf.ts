/**
 * Shelf state + rendering.
 *
 * Phase 01 (scaffold) only ever renders the empty state — nothing ingests
 * captures yet. The store and the tile renderer exist so the catch engine
 * (phase 02) and the thumbnail strip (phase 03) plug in without a rewrite.
 */

export type CaptureKind = "image" | "video";

/** Payload of the Rust `capture://new` event. Phase 03 turns these into tiles. */
export interface Capture {
  path: string;
  kind: CaptureKind;
  /** Unix milliseconds. */
  ts: number;
}

export interface ShelfItem {
  /** Stable id for rendering; the absolute path is unique enough for now. */
  id: string;
  /** Absolute path on disk. Local-only — captures never leave the device. */
  path: string;
  /** File name shown on the tile. */
  name: string;
  kind: CaptureKind;
  /** Unix milliseconds of when the capture landed on the shelf. */
  capturedAt: number;
}

/** Newest first, matching how the shelf reads top-to-bottom. */
const items: ShelfItem[] = [];

export function getItems(): readonly ShelfItem[] {
  return items;
}

export function renderShelf(list: HTMLElement, count: HTMLElement): void {
  count.textContent = String(items.length);
  list.dataset["empty"] = String(items.length === 0);
  list.replaceChildren(
    ...(items.length === 0 ? [emptyState()] : items.map(tile)),
  );
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

function tile(item: ShelfItem): HTMLElement {
  const el = document.createElement("article");
  el.className = "tile";
  el.dataset["id"] = item.id;

  const thumb = document.createElement("div");
  thumb.className = "tile__thumb";
  thumb.textContent = item.kind === "video" ? "🎬" : "🖼";

  const meta = document.createElement("div");
  meta.className = "tile__meta";

  const name = document.createElement("div");
  name.className = "tile__name";
  name.textContent = item.name;
  name.title = item.path;

  const sub = document.createElement("div");
  sub.className = "tile__sub";
  sub.textContent = new Date(item.capturedAt).toLocaleTimeString();

  meta.append(name, sub);
  el.append(thumb, meta);
  return el;
}
