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
  /** Insertion-ordered, which is the order they will be handed over in. */
  readonly #picked = new Set<string>();
  /** Where a range selection counts from. */
  #anchor: string | undefined;

  has(id: string): boolean {
    return this.#picked.has(id);
  }

  /** In the order they were picked. */
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
