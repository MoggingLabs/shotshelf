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
  item: ShelfItem,
  onSettled: () => void,
): Promise<void> {
  node.classList.add("tile--dragging");

  let settled = false;
  const done = (): void => {
    if (settled) return;
    settled = true;
    node.classList.remove("tile--dragging");
    onSettled();
  };

  try {
    const source = await prepareDrag(item.path, item.kind);
    // Cancelling a drag just resolves with "Cancelled" — nothing to undo.
    await startDrag({ item: [source.path], icon: source.icon, mode: "copy" }, done);
  } catch (error) {
    console.error("[shotshelf] could not drag that capture out", error);
  } finally {
    done();
  }
}
