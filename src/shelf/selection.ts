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
  #cursor: string | undefined;

  /**
   * The card the keyboard moves from — the one the user touched **last**.
   *
   * Distinct from `#anchor`, and the distinction is the whole point. The anchor
   * is where a range *started* and deliberately stays put so shift-clicking
   * again re-extends from it; the cursor is where the user last put their
   * attention, which for `extendTo` is the target they shift-clicked.
   *
   * `moveSelection` originally read `ids().at(-1)`. `extendTo` rebuilds the
   * picked set in on-screen order, so that is the *bottom* of the range
   * whichever end the user came from — right after a downward range and wrong
   * after an upward one, where ArrowUp then stepped down from the far end.
   *
   * The first attempt at this returned `#anchor`, which is wrong in the mirror
   * image: after a downward range B→D the anchor is B, so ArrowDown collapsed
   * the selection onto C — *inside* the range just made — instead of continuing
   * to E. And because the anchor and the bottom coincide for an upward range,
   * the test written for it could not fail. A separate cursor is the only thing
   * that is right at both ends.
   */
  focus(): string | undefined {
    // No fallback: `#cursor` is undefined only when nothing is picked.
    //
    // It used to end `?? [...this.#picked].pop()`, which could never run. Every
    // place that clears the cursor — `clear`, the remove branch of `toggle`,
    // `retain` — assigns the last remaining pick *after* the deletion, so
    // `#cursor === undefined` implies `#picked` is empty and the fallback
    // returned `undefined` too. Removing it also removed a false reading: that
    // the cursor is merely a hint over the picked set, when it is the answer.
    return this.#cursor;
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
    this.#cursor = undefined;
  }

  /** Pick exactly this one, dropping anything else. */
  only(id: string): void {
    this.#picked.clear();
    this.#picked.add(id);
    this.#anchor = id;
    this.#cursor = id;
  }

  /** Add or remove one, leaving the rest alone. */
  toggle(id: string): void {
    if (this.#picked.has(id)) {
      this.#picked.delete(id);
      // The anchor has to move off something no longer picked, or the next
      // range counts from a card that is not selected.
      if (this.#anchor === id) this.#anchor = [...this.#picked].pop();
      // Same for the cursor: the keyboard cannot move from a card the user
      // just unpicked.
      if (this.#cursor === id) this.#cursor = [...this.#picked].pop();
    } else {
      this.#picked.add(id);
      this.#anchor = id;
      this.#cursor = id;
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
    // place rather than walking down the list. The cursor does the opposite: it
    // follows the card just shift-clicked, because that is where the user's
    // attention is and where an arrow key should carry on from.
    this.#anchor = anchor;
    this.#cursor = id;
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
    // A capture swept off the shelf cannot be where the keyboard is.
    if (this.#cursor !== undefined && !live.has(this.#cursor)) {
      this.#cursor = [...this.#picked].pop();
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
