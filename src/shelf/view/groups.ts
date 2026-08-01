/**
 * Day grouping.
 *
 * A shelf of forty identical cards is a wall. Dating them gives the eye
 * somewhere to rest and makes "the one from yesterday" findable.
 *
 * Pure, and separate from the rendering that uses it, because the ordering is
 * the part that has been wrong before — twice, both times inside `dayKey`,
 * whose docstring in `format.ts` is where the two failures are written down.
 * Not repeated here: this file carried its own paraphrase of that example and
 * had it backwards, which is what a second copy of an explanation is for.
 */

import { dayKey } from "../../format.ts";

export interface DayGroup<T> {
  /** Sortable `YYYY-MM-DD`. */
  key: string;
  /** A timestamp from the group, for labelling it. */
  ts: number;
  items: T[];
}

/**
 * Split captures into day groups, newest day first.
 *
 * Grouping is by key rather than by runs of adjacent items, because the shelf
 * is ordered by when captures were *added*, not by when they were taken: a pin
 * restored at startup can be a week older than the capture after it.
 */
export function groupByDay<T extends { ts: number }>(items: readonly T[]): DayGroup<T>[] {
  const groups = new Map<string, DayGroup<T>>();

  for (const item of items) {
    const key = dayKey(item.ts);
    const existing = groups.get(key);
    if (existing) existing.items.push(item);
    else groups.set(key, { key, ts: item.ts, items: [item] });
  }

  // Descending: today at the top, and lexical order is chronological because
  // the key is zero-padded.
  return [...groups.values()].sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));
}
