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

import { browseShelf, previewShelf } from "../bridge.ts";
import { OverlayTicket } from "../overlay-ticket.ts";
import type { ShelfItem } from "../types.ts";

/** The preview currently on screen, if any. */
let open: { id: string; node: HTMLElement } | undefined;
/**
 * Opening, superseding and abandoning, shared with the editor.
 *
 * This module used to keep its own copy of these three flags and the rules
 * around them. The copies drifted: the editor learned to clear `opening` when
 * a close cancels an open in flight, and this one did not — so a capture that
 * never decoded wedged the shelf for the session.
 */
const lifetime = new OverlayTicket();

/** Whether a quick look is on screen, or about to be. */
export function previewIsOpen(): boolean {
  return open !== undefined || lifetime.opening;
}

/** Which capture it is showing, so the shelf can tell when that one leaves. */
export function previewedId(): string | undefined {
  return open?.id;
}

/**
 * Show a capture at readable size.
 *
 * Recordings are deliberately excluded: a still frame blown up is not a
 * preview of a video, and playing one is a media player, not a shelf.
 */
export async function showPreview(item: ShelfItem, host: HTMLElement): Promise<void> {
  if (item.kind === "video" || lifetime.opening) return;
  teardown();

  const ticket = lifetime.begin();
  try {
    await mount(ticket, item, host);
  } finally {
    lifetime.finish();
  }
}

async function mount(ticket: number, item: ShelfItem, host: HTMLElement): Promise<void> {
  // The picture is measured before the window is asked for, because the
  // window's shape should follow the capture's rather than the other way
  // round — a portrait screenshot in a landscape window is mostly background.
  const picture = new Image();
  picture.src = convertFileSrc(item.path);
  const aspect = await naturalAspect(picture);
  if (lifetime.stale(ticket)) return;

  await previewShelf(aspect);
  // Cancelled while Rust was resizing: the window has already grown, so the
  // close that cancelled this still owes the restore it could not do.
  if (lifetime.stale(ticket)) {
    if (!lifetime.abandoned) void browseShelf();
    return;
  }

  const frame = document.createElement("div");
  frame.className = "preview";
  frame.dataset["id"] = item.id;

  picture.className = "preview__picture";
  picture.alt = item.path;
  picture.draggable = false;
  frame.append(picture);

  host.append(frame);
  open = { id: item.id, node: frame };
}

/**
 * Close the quick look because the user backed out, and put the window back.
 *
 * Returns whether it consumed the gesture — true while one is merely opening
 * too, so a keystroke that cancels a pending open does not also fall through
 * to dismissing the popover behind it.
 */
export function hidePreview(): boolean {
  const pending = lifetime.close();
  if (!open) return pending;

  teardown();
  void browseShelf();
  return true;
}

/**
 * Tear the quick look down because the window itself is going away.
 *
 * No restore, for the same reason the editor has no restore on this path:
 * showing the window again is the opposite of what the user asked for. Without
 * it the picture outlived the hide and the next capture popped a column with a
 * full-size screenshot painted over it.
 */
export function discardPreview(): void {
  lifetime.discard();
  teardown();
}

function teardown(): void {
  open?.node.remove();
  open = undefined;
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
    // Neither `load` nor `error` is guaranteed to fire — a file on a
    // disconnected share, or one still being written. Without a deadline the
    // open never ends, `opening` stays true, and the shelf stops answering
    // Space and Escape for the rest of the session. The editor's `load` has
    // carried this for a round; this one did not.
    const giveUp = window.setTimeout(() => resolve(16 / 9), MEASURE_TIMEOUT_MS);
    const settle = (aspect: number): void => {
      window.clearTimeout(giveUp);
      resolve(aspect);
    };

    picture.addEventListener(
      "load",
      () => settle(picture.naturalWidth / Math.max(picture.naturalHeight, 1)),
      { once: true },
    );
    picture.addEventListener("error", () => settle(16 / 9), { once: true });
  });
}

/** How long to wait for a capture to report its shape before assuming one. */
const MEASURE_TIMEOUT_MS = 15_000;
