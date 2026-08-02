/**
 * The picture on a card.
 *
 * A card is a fixed 16:9 but captures are any shape at all, so a thumbnail is
 * *fitted* rather than cropped: cropping an odd-shaped capture to its middle
 * is how tiles became unrecognisable before, and a screenshot keeps its
 * meaning at the top — title bars, headers, the first line of a terminal.
 *
 * The bars that fitting leaves are filled with a blurred blow-up of the
 * capture itself, so the dead space still belongs to the capture rather than
 * reading as an empty tile.
 */

import { convertFileSrc } from "@tauri-apps/api/core";

import { icon } from "../../icons.ts";

/** Which glyph stands in when there is no picture to show. */
export type GlyphKind = "film" | "alert";

/**
 * Rendered straight from disk through the asset protocol — never inlined as
 * base64, which would put whole screenshots in the DOM. The URL shape differs
 * per OS (`http://asset.localhost/…` on Windows, `asset://localhost/…` on
 * macOS); `convertFileSrc` picks the right one and the CSP allows both.
 */
export function imageThumb(path: string, name: string): HTMLImageElement {
  const img = document.createElement("img");
  img.className = "tile__thumb";
  img.src = convertFileSrc(path);
  img.alt = name;
  img.loading = "lazy";
  img.decoding = "async";
  // The webview would otherwise start its own HTML5 image drag and shadow the
  // native one, which is what actually carries the file to other apps.
  img.draggable = false;
  return img;
}

/**
 * `label` is what a screen reader hears for the card's picture area. The
 * glyph is `aria-hidden` like every icon, so without it a recording tile —
 * or a missing file — had no text at all beyond its buttons.
 */
export function glyphThumb(kind: GlyphKind, label: string, modifier?: string): HTMLElement {
  const el = document.createElement("div");
  el.className = `tile__thumb tile__thumb--glyph${modifier ? ` tile__thumb--${modifier}` : ""}`;
  el.append(icon(kind, 24));
  const said = document.createElement("span");
  said.className = "sr-only";
  said.textContent = label;
  el.append(said);
  return el;
}

/**
 * The card-level missing state: the rim that says "this file has gone" at a
 * glance. The glyph swap alone changed only the picture area, and nothing on
 * the card said anything was wrong until you hovered for the filename.
 */
export function markMissing(tile: HTMLElement): void {
  tile.classList.add("tile--missing");
}

/**
 * The blurred fill behind a thumbnail.
 *
 * Set as a custom property rather than another element so replacing the
 * thumbnail — a poster frame arriving, a missing file falling back to a glyph
 * — cannot leave a mismatched layer behind it.
 */
export function setWash(tile: HTMLElement, path: string | null): void {
  if (path === null) tile.style.removeProperty("--wash");
  else tile.style.setProperty("--wash", `url("${convertFileSrc(path)}")`);
}

/**
 * Swap whatever is on the card for a different picture, keeping the wash in
 * step. Used when a recording's poster frame arrives, and when a file has gone
 * missing and the card falls back to a warning glyph.
 */
export function replaceThumb(tile: HTMLElement, next: HTMLElement, wash: string | null): void {
  const current = tile.querySelector(".tile__thumb");
  if (!current) return;
  current.replaceWith(next);
  setWash(tile, wash);
}
