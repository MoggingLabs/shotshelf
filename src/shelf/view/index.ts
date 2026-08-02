/**
 * Turning shelf state into DOM, and nothing else.
 *
 * Both views are redrawn wholesale. The column holds a handful of cards and
 * the browse view is only redrawn when you open it or a capture lands while it
 * is on screen — which is rare, because the popover is hidden nearly all the
 * time. Two incremental paths would be two places to get pin state and day
 * grouping subtly wrong, and that is exactly where the bugs were.
 *
 * What makes wholesale redraws cheap is that cards are cached and reused: a
 * redraw re-appends existing elements rather than re-fetching every picture.
 * A card is only built once and only discarded when its capture leaves the
 * shelf, which is also the only moment its poster frame needs cleaning up.
 */

import { dayLabel } from "../../format.ts";
import type { ShelfItem } from "../types.ts";
import { reflectPin } from "./actions.ts";
import { groupByDay } from "./groups.ts";
import { buildTile, emptyState, type TileCallbacks } from "./tile.ts";

export class ShelfView {
  readonly #list: HTMLElement;
  /** What the last render put on screen, in that order. See `visibleOrder`. */
  #order: readonly string[] = [];
  readonly #count: HTMLElement;
  readonly #callbacks: TileCallbacks;
  /** Card per capture id, reused across redraws. */
  readonly #tiles = new Map<string, HTMLElement>();
  /** What the title currently reports, so the pick count can share the slot. */
  #size = 0;
  #picked = 0;

  /**
   * Forget every built tile, so the next render makes them again.
   *
   * For one case: a thumbnail that failed because the asset-protocol scope was
   * not open yet. The image `error` handler is `{ once: true }` and this map
   * hands the same node back on every later render, so a capture restored at
   * launch — before the catch engine finishes granting the scope on its worker —
   * showed "the file has gone" for a file that was there, permanently.
   *
   * The alternative tried first was granting the scope from the stored pin list,
   * which let a hand-edited `pinned.json` admit any absolute path. Rebuilding
   * the tiles fixes the rendering without widening what Rust will read.
   */
  forgetTiles(): void {
    for (const tile of this.#tiles.values()) tile.remove();
    this.#tiles.clear();
  }

  constructor(list: HTMLElement, count: HTMLElement, callbacks: TileCallbacks) {
    this.#list = list;
    this.#count = count;
    this.#callbacks = callbacks;
  }

  #tileFor(item: ShelfItem): HTMLElement {
    const existing = this.#tiles.get(item.id);
    if (existing) return existing;

    const tile = buildTile(item, this.#callbacks);
    this.#tiles.set(item.id, tile);
    return tile;
  }

  /**
   * Forget a capture's card. Called as it leaves the shelf, which is the one
   * moment the cache must shrink — otherwise a long-running tray app keeps
   * every card it has ever drawn.
   */
  release(id: string): void {
    this.#tiles.get(id)?.remove();
    this.#tiles.delete(id);
  }

  /** The narrow popup: just what has landed, no day headings, no chrome. */
  renderColumn(items: readonly ShelfItem[]): void {
    this.#order = items.map((item) => item.id);
    this.#list.dataset["view"] = "column";
    this.#list.dataset["empty"] = "false";

    const grid = document.createElement("div");
    grid.className = "group__grid";
    for (const item of items) grid.append(this.#tileFor(item));

    this.#list.replaceChildren(grid);
    this.#list.scrollTop = 0;
  }

  /**
   * The ids in the order they are on screen right now.
   *
   * Recorded by the renderers as they draw, rather than derived a second time
   * from the same input — the facade's copy is what walked the wrong order in
   * the first place, and the next browse-view feature (a pinned-first section,
   * a filter, a search box) would have changed one and not the other.
   *
   * Recorded rather than read back out of the DOM, which was the first attempt:
   * that wrote each id into a `data-id` attribute and parsed it back, putting
   * identity in the DOM when the view already knew it. It also only answered
   * for browse mode, leaving the column re-deriving its own order — the same
   * two-places-one-rule shape, one branch down.
   */
  visibleOrder(): readonly string[] {
    return this.#order;
  }

  /** The full shelf, grouped by day, newest first. */
  renderBrowse(items: readonly ShelfItem[]): void {
    this.#list.dataset["view"] = "browse";

    if (items.length === 0) {
      this.#order = [];
      this.#renderEmpty();
      return;
    }

    // Grouped once, and the order that produces is what `visibleOrder` reports.
    const grouped = groupByDay(items);
    this.#order = grouped.flatMap((group) => group.items.map((item) => item.id));

    // `replaceChildren` collapses `scrollHeight` and clamps `scrollTop` to
    // zero, and this runs on every removal, every retention sweep and every
    // capture landing while browse is open — each of which yanked the list
    // back to the top and lost the reader's place.
    const scrolled = this.#list.scrollTop;

    this.#list.dataset["empty"] = "false";
    this.#list.replaceChildren(
      ...grouped.map((group) => {
        const section = document.createElement("section");
        section.className = "group";
        section.dataset["day"] = group.key;

        const heading = document.createElement("h2");
        heading.className = "group__label";
        heading.textContent = dayLabel(group.ts);

        const grid = document.createElement("div");
        grid.className = "group__grid";
        for (const item of group.items) grid.append(this.#tileFor(item));

        section.append(heading, grid);
        return section;
      }),
    );

    this.#list.scrollTop = scrolled;
  }

  #renderEmpty(): void {
    this.#list.dataset["view"] = "browse";
    this.#list.dataset["empty"] = "true";
    this.#list.replaceChildren(emptyState());
  }

  /**
   * The count and the empty flag move together. They did not once, and a
   * stale flag left the grid centring itself on nothing.
   */
  setCount(size: number): void {
    this.#size = size;
    this.#renderCount();
    this.#list.dataset["empty"] = String(size === 0);
  }

  /**
   * The title reports the pick while one exists — "2 of 7 picked" — because
   * nothing else did: at three or more picked, Edit and Compare both vanish
   * and no signal anywhere said a selection was live, right before Delete
   * acted on all of it. It also bridges the distance to Edit/Compare, which
   * appear in this strip when the pick makes them meaningful.
   */
  #renderCount(): void {
    if (this.#picked > 0 && this.#size > 0) {
      this.#count.textContent = `${this.#picked} of ${this.#size} picked`;
      return;
    }
    this.#count.textContent =
      this.#size === 0 ? "Shelf" : `${this.#size} capture${this.#size === 1 ? "" : "s"}`;
  }

  /**
   * Mark the picked cards. Applied to live elements rather than by redrawing:
   * selection changes on every click, and a redraw per click would be a redraw
   * per click.
   *
   * The cursor — the card the arrows move from — gets its own class only in a
   * multi-pick: with one card picked it *is* the cursor, and a second
   * treatment on the same card would be noise.
   */
  reflectSelection(picked: ReadonlySet<string>, cursor: string | undefined): void {
    for (const [id, tile] of this.#tiles) {
      tile.classList.toggle("tile--picked", picked.has(id));
      tile.classList.toggle("tile--cursor", picked.size > 1 && id === cursor);
    }
    this.#picked = picked.size;
    this.#renderCount();
  }

  /**
   * Bring a card into view.
   *
   * For the keyboard: arrowing past the fold has to move the list, or the
   * selection walks somewhere the user cannot see.
   */
  scrollIntoView(id: string): void {
    this.#tiles.get(id)?.scrollIntoView({ block: "nearest" });
  }

  /**
   * Take the list out of the focus order while an overlay covers it.
   *
   * Without this, Tab inside the editor walked four invisible tile controls
   * — pin, copy, reveal and Remove, the last of which removes the capture
   * being edited — before it ever reached the toolbar.
   */
  setListInert(inert: boolean): void {
    this.#list.inert = inert;
  }

  /** Pinning is applied to the live card rather than by rebuilding it. */
  reflectPin(id: string, pinned: boolean): void {
    const tile = this.#tiles.get(id);
    if (tile) reflectPin(tile, pinned);
  }
}
