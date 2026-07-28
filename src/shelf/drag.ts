/**
 * Handing a capture to the rest of the desktop.
 *
 * This is the feature the whole shelf exists for, and the one invariant that
 * matters most lives here: a drag-out is a **copy**. The original stays
 * exactly where the OS wrote it, whatever the destination does with what it
 * receives.
 */

import { startDrag } from "@crabnebula/tauri-plugin-drag";

import { prepareDrag } from "./bridge.ts";
import type { ShelfItem } from "./types.ts";

/** Pointer travel before a press on a card becomes a drag rather than a click. */
const DRAG_THRESHOLD_PX = 6;

/**
 * Wait for real pointer travel before starting a drag, so a click on a card
 * stays a click and the list can still be scrolled.
 *
 * Returns a teardown function; the caller uses it to disarm if the shelf is
 * torn down mid-press.
 */
export function armDrag(
  node: HTMLElement,
  item: ShelfItem,
  start: PointerEvent,
  begin: (node: HTMLElement, item: ShelfItem) => void,
): () => void {
  const from = { x: start.clientX, y: start.clientY };

  const disarm = (): void => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", disarm);
    window.removeEventListener("pointercancel", disarm);
  };

  const onMove = (move: PointerEvent): void => {
    if (Math.hypot(move.clientX - from.x, move.clientY - from.y) < DRAG_THRESHOLD_PX) return;
    disarm();
    begin(node, item);
  };

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", disarm);
  window.addEventListener("pointercancel", disarm);

  return disarm;
}

/**
 * Hand the real file to the OS via `tauri-plugin-drag`.
 *
 * `mode: "copy"` is the load-bearing part: dragging a capture out must never
 * move the original off the user's disk.
 */
export async function beginDrag(
  node: HTMLElement,
  items: readonly ShelfItem[],
  onSettled: () => void,
): Promise<void> {
  const [first] = items;
  if (!first) {
    onSettled();
    return;
  }

  node.classList.add("tile--dragging");

  let settled = false;
  const done = (): void => {
    if (settled) return;
    settled = true;
    node.classList.remove("tile--dragging");
    onSettled();
  };

  try {
    // Every picked capture, in the order they were picked — a before and an
    // after are only useful the right way round. Each goes through
    // `prepare_drag` so each is checked for still being on disk, and so each
    // gets sized for hand-off if that is turned on.
    const sources = await Promise.all(items.map((item) => prepareDrag(item.path, item.kind)));
    const paths = sources.map((source) => source.path);
    // The cursor carries the first one's preview; there is no OS drag image
    // for "four files" that is more informative than one of them.
    const icon = sources[0]?.icon ?? "";

    // The drag ends when `done` fires, NOT when this call returns. On Windows
    // `DoDragDrop` blocks until the drop, so the two coincide; on macOS
    // `beginDraggingSessionWithItems` returns immediately, and settling here
    // would declare the drag over while the user is still holding the file.
    // That is not cosmetic: it un-holds the popover, so the launch dismissal
    // and the column's expiry timer both resume mid-drag.
    //
    // Cancelling a drag just resolves the callback with "Cancelled".
    await startDrag({ item: paths, icon, mode: "copy" }, done);
  } catch (error) {
    console.error("[shotshelf] could not drag that capture out", error);
    // Only a failure to *start* settles here — there is no drag to wait for.
    done();
  }
}
