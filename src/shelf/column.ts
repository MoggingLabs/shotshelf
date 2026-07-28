/**
 * The auto-popup column: what has just landed, and how long it stays in view.
 *
 * This is a different lifetime from the shelf itself, and keeping the two
 * apart is the point. A card leaving the column costs you nothing — the
 * capture is still on the shelf when you next open it. The timer here decides
 * how long the popup is in your way, not how long anything is kept.
 *
 * No DOM and no timer of its own: the caller ticks it. That keeps expiry a
 * pure function of "what time is it", which is testable, instead of something
 * you can only observe by waiting a minute.
 */

import { COLUMN_MAX_CARDS } from "./geometry.ts";

/** How long a capture stays in the auto-popup column. */
export const COLUMN_MS = 60_000;

interface ColumnEntry {
  id: string;
  /** Unix milliseconds after which this card should go. */
  expires: number;
}

/**
 * Why the column is being held open.
 *
 * There is more than one reason at a time — the pointer is over the popover
 * *and* the window has focus — and they start and stop independently. Modelled
 * as a set rather than a flag because releasing a hold is not idempotent: it
 * pushes every card's deadline forward a full window. With one boolean, the
 * pointer leaving a focused window released a hold the focus still wanted,
 * resetting every deadline and resuming ageing behind the other holder's back.
 */
export type HoldReason = "pointer" | "focus";

export class ColumnQueue {
  /** Newest first, matching the order they are shown in. */
  #entries: ColumnEntry[] = [];
  /** Every reason the column is currently being held open. */
  readonly #holds = new Set<HoldReason>();

  get size(): number {
    return this.#entries.length;
  }

  get isEmpty(): boolean {
    return this.#entries.length === 0;
  }

  get held(): boolean {
    return this.#holds.size > 0;
  }

  /** The captures showing, newest first. */
  ids(): readonly string[] {
    return this.#entries.map((entry) => entry.id);
  }

  /**
   * Show a capture. Re-adding one already showing is ignored rather than
   * refreshing it, so a duplicate catch cannot keep a card alive indefinitely.
   *
   * The queue is capped well above what the column can display: the extra are
   * there so cards behind the visible ones can take their place as they
   * expire, without holding the whole shelf in memory twice.
   */
  add(id: string, now: number = Date.now()): boolean {
    if (this.#entries.some((entry) => entry.id === id)) return false;
    this.#entries.unshift({ id, expires: now + COLUMN_MS });
    this.#entries.splice(COLUMN_MAX_CARDS * 3);
    return true;
  }

  /** Taking a capture off the shelf takes it out of the popup too. */
  remove(id: string): boolean {
    const index = this.#entries.findIndex((entry) => entry.id === id);
    if (index === -1) return false;
    this.#entries.splice(index, 1);
    return true;
  }

  clear(): void {
    this.#entries = [];
  }

  /**
   * Drop every hold at once.
   *
   * For the moments where the events that would have released them cannot
   * arrive: the window is hidden, or a native drag has taken the pointer.
   * Counts as the last release, so the cards still get a full window.
   */
  releaseAll(now: number = Date.now()): void {
    if (this.#holds.size === 0) return;
    this.#holds.clear();
    for (const entry of this.#entries) entry.expires = now + COLUMN_MS;
  }

  /**
   * Hold or release the column for one reason.
   *
   * The column ages only once *every* reason has let go. Releasing the last
   * one pushes every deadline forward by a full window rather than letting
   * cards vanish the instant the pointer leaves — a card that was about to
   * expire when you started reading it should still be there when you look up.
   */
  hold(reason: HoldReason, held: boolean, now: number = Date.now()): void {
    // Sizes rather than the `held` getter either side of the mutation:
    // TypeScript treats a `const` alias of a getter as pinned, so narrowing
    // the alias narrows the getter too, and the compiler concluded the second
    // read could never be false — which is exactly the transition being
    // tested for.
    const holdersBefore = this.#holds.size;

    if (held) this.#holds.add(reason);
    else this.#holds.delete(reason);

    // Only the transition from "held by something" to "held by nothing" earns
    // the deadline reset; anything else would let a repeatedly-toggled reason
    // keep a card alive indefinitely.
    if (holdersBefore > 0 && this.#holds.size === 0) {
      for (const entry of this.#entries) entry.expires = now + COLUMN_MS;
    }
  }

  /**
   * Drop cards whose time is up. Returns true if anything actually went, which
   * is the caller's cue to resize the window or put it away.
   */
  expire(now: number = Date.now()): boolean {
    if (this.held) return false;

    const before = this.#entries.length;
    this.#entries = this.#entries.filter((entry) => entry.expires > now);
    return this.#entries.length !== before;
  }
}
