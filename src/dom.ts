/**
 * Finding the elements the app is built around.
 *
 * Two lookups, because there are genuinely two cases, and writing them out
 * three times each is how they drifted into meaning different things in
 * different files.
 */

/**
 * An element that must be there.
 *
 * Used for the shelf's own furniture — the list, the title strip, the settings
 * panel. Those ship in `index.html` and a missing one is a broken build, not a
 * condition to handle: failing at start-up with the selector in the message
 * beats every call site downstream guarding against a `null` that cannot
 * happen.
 */
export function el<T extends HTMLElement>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`Shotshelf: missing element ${selector}`);
  return node;
}

/**
 * An element whose absence is not an error.
 *
 * The distinction from [`el`] is about *who* is missing, not about when. `el`
 * is for the structure the app is built on — the shelf, the list, the overlay —
 * where a missing node means the document is not the one this code was written
 * for, and failing loudly is right. This is for the two nodes that report
 * *about* the app: the alert strip and the watch dot. A status line that throws
 * because it has nowhere to write is a worse outcome than a status line that
 * says nothing.
 *
 * The previous justification was false three ways, and each is worth naming
 * because all three are checkable: it said this was for "modules imported by
 * tests that never build a document" (no test imports `status.ts`), that
 * `status.ts` is "imported for its pure formatting" (its only formatter is
 * private; every export touches the DOM or module state), and that it "must not
 * throw at import time" (all four calls are inside function bodies, so nothing
 * runs at import).
 */
export function maybeEl<T extends HTMLElement>(selector: string): T | null {
  return document.querySelector<T>(selector);
}
