/**
 * The captures the shelf is holding, and nothing else.
 *
 * No DOM, no IPC, no timers. Every rule about what stays and what goes lives
 * here as a plain function of the data, which is the only reason those rules
 * can be tested at all — the previous versions of them were tangled into
 * rendering, and the bugs that shipped (a poster frame leaked because one
 * eviction path cleaned up and the other did not) were bugs of that tangling
 * rather than of the rules themselves.
 *
 * Every method that removes captures *returns* them. Callers need that: a
 * recording leaving the shelf has a cached poster frame to clean up, and the
 * one place that knows how is the caller, not the store. Returning the
 * evictions instead of firing an event keeps that a single, obvious hand-off.
 */

import { type Capture, captureId, type ShelfItem } from "./types.ts";

export class ShelfStore {
  /** Newest first, matching how the shelf reads top to bottom. */
  #items: ShelfItem[] = [];

  get size(): number {
    return this.#items.length;
  }

  /** Newest first. Readonly: mutation goes through the methods below. */
  items(): readonly ShelfItem[] {
    return this.#items;
  }

  find(id: string): ShelfItem | undefined {
    return this.#items.find((item) => item.id === id);
  }

  /**
   * Private: the only thing that ever asked was `add`, one line below.
   *
   * It was `pub`-equivalent surface with no consumer anywhere in the repo —
   * not even a test — and public surface on a store is an invitation to check
   * membership somewhere other than where the deduplication rule lives.
   */
  #holds(id: string): boolean {
    return this.#items.some((item) => item.id === id);
  }

  /**
   * Put a capture on the shelf, newest first.
   *
   * Returns the item, or `undefined` if it was already there. Catching the
   * same capture twice is routine rather than exceptional — Win+PrtSc writes a
   * file *and* fills the clipboard, and a pin restored at startup can be
   * re-caught by the folder watcher moments later.
   */
  add(capture: Capture, options: { pinned?: boolean } = {}): ShelfItem | undefined {
    const id = captureId(capture);
    if (this.#holds(id)) return undefined;

    const item: ShelfItem = { ...capture, id, pinned: options.pinned ?? false };
    this.#items.unshift(item);
    return item;
  }

  /** Take a capture off the shelf. The file on disk is not this class's business. */
  remove(id: string): ShelfItem | undefined {
    const index = this.#items.findIndex((item) => item.id === id);
    if (index === -1) return undefined;
    return this.#items.splice(index, 1)[0];
  }

  /** Returns the new pinned state, or `undefined` if the id is not on the shelf. */
  togglePin(id: string): boolean | undefined {
    const item = this.find(id);
    if (!item) return undefined;
    item.pinned = !item.pinned;
    return item.pinned;
  }

  /**
   * Drop the oldest unpinned captures once there are more than the cap allows.
   *
   * The cap counts unpinned captures only. Pinning is documented as opting out
   * of both the retention window and the item limit, and counting pinned ones
   * against the cap quietly broke that: pin fifty with a cap of fifty and the
   * next capture was evicted the instant it arrived.
   */
  trim(maxItems: number): ShelfItem[] {
    const evicted: ShelfItem[] = [];
    const cap = Math.max(maxItems, 0);

    let unpinned = this.#items.reduce((total, item) => total + (item.pinned ? 0 : 1), 0);

    // Oldest first, so the survivors are the most recent.
    for (let index = this.#items.length - 1; index >= 0 && unpinned > cap; index -= 1) {
      const item = this.#items[index];
      if (!item || item.pinned) continue;
      this.#items.splice(index, 1);
      evicted.push(item);
      unpinned -= 1;
    }

    return evicted;
  }

  /**
   * Drop unpinned captures older than the retention window.
   *
   * A null window means "keep everything", which is why this takes the setting
   * rather than a cutoff: the disabled case belongs with the rule, not with
   * every caller.
   */
  sweep(retentionHours: number | null, now: number = Date.now()): ShelfItem[] {
    if (retentionHours === null) return [];

    const cutoff = now - retentionHours * 3_600_000;
    const evicted = this.#items.filter((item) => !item.pinned && item.ts < cutoff);
    this.#items = this.#items.filter((item) => !evicted.includes(item));
    return evicted;
  }

  /** The pinned captures, in the shape settings persists them. */
  pinned(): Capture[] {
    return this.#items
      .filter((item) => item.pinned)
      .map(({ path, kind, ts }) => ({ path, kind, ts }));
  }
}
