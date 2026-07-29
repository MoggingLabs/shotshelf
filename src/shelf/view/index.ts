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
  readonly #count: HTMLElement;
  readonly #callbacks: TileCallbacks;
  /** Card per capture id, reused across redraws. */
  readonly #tiles = new Map<string, HTMLElement>();

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
    this.#list.dataset["view"] = "column";
    this.#list.dataset["empty"] = "false";

    const grid = document.createElement("div");
    grid.className = "group__grid";
    for (const item of items) grid.append(this.#tileFor(item));

    this.#list.replaceChildren(grid);
    this.#list.scrollTop = 0;
  }

  /** The full shelf, grouped by day, newest first. */
  /**
   * The ids in the order they are on screen right now.
   *
   * Asked of the thing that actually drew the DOM, rather than derived a
   * second time from the same input. Both were computing `groupByDay(items)`
   * and agreeing by convention — the facade's copy is what walked the wrong
   * order in the first place, and the next browse-view feature (a pinned-first
   * section, a filter, a search box) would have changed one and not the other.
   */
  visibleOrder(): string[] {
    return [...this.#list.querySelectorAll<HTMLElement>(".tile")].flatMap((tile) =>
      tile.dataset["id"] === undefined ? [] : [tile.dataset["id"]],
    );
  }

  renderBrowse(items: readonly ShelfItem[]): void {
    this.#list.dataset["view"] = "browse";

    if (items.length === 0) {
      this.#renderEmpty();
      return;
    }

    this.#list.dataset["empty"] = "false";
    this.#list.replaceChildren(
      ...groupByDay(items).map((group) => {
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
    this.#count.textContent =
      size === 0 ? "Shelf" : `${size} capture${size === 1 ? "" : "s"}`;
    this.#list.dataset["empty"] = String(size === 0);
  }

  /**
   * Mark the picked cards. Applied to live elements rather than by redrawing:
   * selection changes on every click, and a redraw per click would be a redraw
   * per click.
   */
  reflectSelection(picked: ReadonlySet<string>): void {
    for (const [id, tile] of this.#tiles) {
      tile.classList.toggle("tile--picked", picked.has(id));
    }
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

  /** Pinning is applied to the live card rather than by rebuilding it. */
  reflectPin(id: string, pinned: boolean): void {
    const tile = this.#tiles.get(id);
    if (tile) reflectPin(tile, pinned);
  }
}
