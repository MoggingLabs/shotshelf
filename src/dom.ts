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
 * An element that may not be there yet.
 *
 * For modules imported by tests that never build a document. `status.ts` is
 * the case that matters: it is imported for its pure formatting and must not
 * throw at import time just because there is no shelf on screen.
 */
export function maybeEl<T extends HTMLElement>(selector: string): T | null {
  return document.querySelector<T>(selector);
}
