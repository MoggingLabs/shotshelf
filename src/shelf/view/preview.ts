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
 *
 * The lifetime — what "open" means, who may end an open, who owes the browse
 * window back — belongs to `Overlay`, shared with the editor. It was written
 * out here too once, and the two copies drifted.
 */

import { convertFileSrc } from "@tauri-apps/api/core";

import { browseShelf, previewShelf } from "../bridge.ts";
import { Overlay, readable } from "../overlay.ts";
import type { ShelfItem } from "../types.ts";

interface Shown {
  id: string;
  node: HTMLElement;
}

const overlay = new Overlay<Shown>({
  teardown: (shown) => shown.node.remove(),
  restore: () => void browseShelf(),
});

/** Whether a quick look is on screen, or about to be. */
export function previewIsOpen(): boolean {
  return overlay.isOpen;
}

/** Which capture it is showing, so the shelf can tell when that one leaves. */
export function previewedId(): string | undefined {
  return overlay.live?.id;
}

/**
 * Show a capture at readable size.
 *
 * Recordings are deliberately excluded: a still frame blown up is not a
 * preview of a video, and playing one is a media player, not a shelf.
 */
export async function showPreview(item: ShelfItem, host: HTMLElement): Promise<void> {
  if (item.kind === "video") return;

  await overlay.show(async (stale) => {
    // The picture is measured before the window is asked for, because the
    // window's shape should follow the capture's rather than the other way
    // round — a portrait screenshot in a landscape window is mostly background.
    const picture = new Image();
    picture.src = convertFileSrc(item.path);

    // A capture that cannot be measured still gets a preview, in a screen's
    // shape: one that refuses to open is worse than one that is the wrong
    // shape.
    const measured = await readable(picture);
    if (stale()) return undefined;
    const aspect = measured
      ? measured.naturalWidth / Math.max(measured.naturalHeight, 1)
      : 16 / 9;

    await previewShelf(aspect);
    if (stale()) return undefined;

    const frame = document.createElement("div");
    frame.className = "preview";

    picture.className = "preview__picture";
    picture.alt = item.path;
    picture.draggable = false;
    frame.append(picture);
    host.append(frame);

    return { id: item.id, node: frame };
  });
}

/**
 * Close the quick look because the user backed out, and put the window back.
 *
 * Returns whether it consumed the gesture — true while one is merely opening
 * too, so a keystroke that cancels a pending open does not also fall through
 * to dismissing the popover behind it.
 */
export function hidePreview(): boolean {
  return overlay.close();
}

/** Tear the quick look down because the window itself is going away. */
export function discardPreview(): void {
  overlay.discard();
}
