/**
 * One capture, big enough to read.
 *
 * The shelf is 225 wide. That is enough to *recognise* a screenshot — which is
 * what a thumbnail is for — and nowhere near enough to read one. Without this,
 * checking which of two similar captures you are about to send means opening
 * it in another app, which is exactly the round trip the shelf exists to save.
 *
 * The window itself grows, rather than an overlay appearing inside a 225px
 * panel: there is no arrangement of a picture inside that width that makes
 * small text legible. Rust owns the sizing because only Rust knows the work
 * area; this asks for a size and lays the picture out in whatever it gets.
 */

import { convertFileSrc } from "@tauri-apps/api/core";

import { closePreview, previewShelf } from "../bridge.ts";
import type { ShelfItem } from "../types.ts";

/** The preview currently on screen, if any. */
let open: { id: string; node: HTMLElement } | undefined;
/**
 * Set while one is being opened.
 *
 * `open` is undefined for the whole span between measuring the picture and
 * mounting it, so it cannot answer "is one opening?" — and holding Space put a
 * keydown in every one of those spans, stacking a preview per press.
 */
let opening = false;

export function previewIsOpen(): boolean {
  return open !== undefined || opening;
}

/**
 * Show a capture at readable size.
 *
 * Recordings are deliberately excluded: a still frame blown up is not a
 * preview of a video, and playing one is a media player, not a shelf.
 */
export async function showPreview(item: ShelfItem, host: HTMLElement): Promise<void> {
  if (item.kind === "video" || opening) return;
  closePreview_(host);

  opening = true;
  try {
    await mount(item, host);
  } finally {
    opening = false;
  }
}

async function mount(item: ShelfItem, host: HTMLElement): Promise<void> {

  // The picture is measured before the window is asked for, because the
  // window's shape should follow the capture's rather than the other way
  // round — a portrait screenshot in a landscape window is mostly background.
  const picture = new Image();
  picture.src = convertFileSrc(item.path);
  const aspect = await naturalAspect(picture);

  await previewShelf(aspect);

  const frame = document.createElement("div");
  frame.className = "preview";
  frame.dataset["id"] = item.id;

  picture.className = "preview__picture";
  picture.alt = item.path;
  picture.draggable = false;
  frame.append(picture);

  host.append(frame);
  host.dataset["preview"] = "true";
  open = { id: item.id, node: frame };
}

/** Put the window back to the browse view. */
export function hidePreview(host: HTMLElement): void {
  if (!open) return;
  closePreview_(host);
  void closePreview();
}

function closePreview_(host: HTMLElement): void {
  open?.node.remove();
  open = undefined;
  delete host.dataset["preview"];
}

/**
 * The capture's own width-to-height ratio.
 *
 * Falls back to a screen's shape when the picture cannot be measured — a
 * missing file, a format the webview will not decode — because a preview that
 * refuses to open is worse than one that is the wrong shape.
 */
function naturalAspect(picture: HTMLImageElement): Promise<number> {
  if (picture.complete && picture.naturalWidth > 0) {
    return Promise.resolve(picture.naturalWidth / picture.naturalHeight);
  }

  return new Promise((resolve) => {
    picture.addEventListener(
      "load",
      () => resolve(picture.naturalWidth / Math.max(picture.naturalHeight, 1)),
      { once: true },
    );
    picture.addEventListener("error", () => resolve(16 / 9), { once: true });
  });
}
