/**
 * Which captures are picked out.
 *
 * Exists for one reason: a before and an after are two captures, and so is a
 * sequence of steps. Dragging them one at a time into a conversation loses the
 * ordering that made them worth sending together.
 *
 * Pure, like the store — no DOM, no IPC — so the awkward parts (range
 * selection across a list that is grouped by day, an anchor that has since
 * been removed) are testable without a browser.
 */

export class Selection {
  /**
   * Insertion-ordered, which is **not** the order they are handed over in.
   *
   * A `Set` remembers when each id was added, and for a range selection that
   * is the order the shelf shows them in only by coincidence — shift-clicking
   * upwards, or ctrl-clicking a fourth card between two already picked, both
   * produce an insertion order that has nothing to do with the list. Handing
   * over is ordered by capture time in `Shelf.#pickedItems`, which is what
   * makes a before and an after arrive as a before and an after.
   *
   * This docstring used to claim the opposite, which is a live trap: a reader
   * trusting it could delete that sort as redundant and silently reverse the
   * pair for one of the two gestures.
   */
  readonly #picked = new Set<string>();
  /** Where a range selection counts from. */
  #anchor: string | undefined;

  /**
   * The card the keyboard should move from — the one last *acted on*, not the
   * last in on-screen order.
   *
   * `extendTo` clears and rebuilds `#picked` top-to-bottom, so after a range
   * selected *upwards* the last entry of `ids()` is the bottom of the range,
   * which is the opposite end from the card the user shift-clicked.
   * `moveSelection` read `ids().at(-1)` and so stepped downwards from the wrong
   * card on the next ArrowUp.
   */
  focus(): string | undefined {
    return this.#anchor ?? [...this.#picked].pop();
  }

  has(id: string): boolean {
    return this.#picked.has(id);
  }

  /** In the order they were picked, which is not an order to hand over in. */
  ids(): string[] {
    return [...this.#picked];
  }

  clear(): void {
    this.#picked.clear();
    this.#anchor = undefined;
  }

  /** Pick exactly this one, dropping anything else. */
  only(id: string): void {
    this.#picked.clear();
    this.#picked.add(id);
    this.#anchor = id;
  }

  /** Add or remove one, leaving the rest alone. */
  toggle(id: string): void {
    if (this.#picked.has(id)) {
      this.#picked.delete(id);
      // The anchor has to move off something no longer picked, or the next
      // range counts from a card that is not selected.
      if (this.#anchor === id) this.#anchor = [...this.#picked].pop();
    } else {
      this.#picked.add(id);
      this.#anchor = id;
    }
  }

  /**
   * Extend from the anchor to `id`, in the order the shelf is showing.
   *
   * `order` is passed in rather than remembered because the shelf's order
   * changes underneath a selection — a capture landing, a retention sweep —
   * and a range is only meaningful against what is on screen right now.
   */
  extendTo(id: string, order: readonly string[]): void {
    const anchor = this.#anchor;
    if (anchor === undefined || !order.includes(anchor)) {
      this.only(id);
      return;
    }

    const from = order.indexOf(anchor);
    const to = order.indexOf(id);
    if (to === -1) return;

    const [start, end] = from <= to ? [from, to] : [to, from];
    this.#picked.clear();
    for (const between of order.slice(start, end + 1)) this.#picked.add(between);
    // The anchor stays put, so shift-clicking again re-extends from the same
    // place rather than walking down the list.
    this.#anchor = anchor;
  }

  /**
   * Drop anything no longer on the shelf.
   *
   * Captures leave underneath a selection all the time — the retention sweep,
   * the item cap — and a selection holding ids that no longer exist hands
   * missing files to a drag.
   */
  retain(existing: readonly string[]): void {
    const live = new Set(existing);
    for (const id of this.#picked) {
      if (!live.has(id)) this.#picked.delete(id);
    }
    if (this.#anchor !== undefined && !live.has(this.#anchor)) {
      this.#anchor = [...this.#picked].pop();
    }
  }
}

/**
 * The order a selection is handed over in.
 *
 * One defined order, used by everything that acts on a selection.
 * {@link Selection.ids} cannot provide it: a ctrl-click appends, so it yields
 * click order, while a shift-range rebuilds the set in the order the shelf is
 * showing — which is newest-first. Anything reading that order directly
 * therefore handed a before/after pair over backwards for one gesture and
 * correctly for the other, which is a bug that looks like working software.
 *
 * Capture time is the answer under both gestures. The path breaks ties so two
 * captures sharing a millisecond — legal, since identity is `ts:path` — cannot
 * fall back to the ordering this exists to avoid.
 *
 * Here rather than on `Shelf`, which is a DOM-bound facade whose own header
 * says it decides no rules. This is a rule, and it is the one a comparison
 * depends on; in the facade it could only be reached through a browser.
 */
export function inHandoverOrder<T extends { ts: number; path: string }>(
  picked: readonly T[],
): T[] {
  return [...picked].sort((a, b) => a.ts - b.ts || a.path.localeCompare(b.path));
}
