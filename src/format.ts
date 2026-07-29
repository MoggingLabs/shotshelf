/**
 * Pure formatting helpers.
 *
 * Split out of the shelf so they can be tested without a DOM or a Tauri
 * runtime — importing the shelf pulls in the drag plugin and the asset
 * protocol, neither of which exists under `node --test`.
 */

/**
 * `0:08`, `1:05`, `12:30`, `1:02:03`.
 *
 * The hour field appears only when there is one, so the common case stays two
 * fields wide on a small badge. Without it a one-hour screencast read `62:03`,
 * which is not a duration anyone writes — and `docs/USAGE.md` says the badge
 * carries "their length".
 */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  const rest = String(seconds % 60).padStart(2, "0");

  if (minutes < 60) return `${minutes}:${rest}`;
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}:${rest}`;
}

/**
 * `133 kB`, `1.4 MB`. Deliberately not `48 B` for a 135kB file, which is what
 * a stale byte count once displayed.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${Math.round(bytes)} B`;

  const units = ["kB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }

  // Rounded first, then re-checked against the unit.
  //
  // The unit was chosen from the unrounded value, so 1,048,064 bytes left
  // `value` at 1023.5 and `toFixed(0)` printed **"1024 kB"** on a recording
  // badge that should read "1.0 MB". A whole band of sizes below every power of
  // 1024 rendered in the unit below the one they belong to.
  const digits = value < 10 ? 1 : 0;
  if (Number(value.toFixed(digits)) >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }

  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit] ?? "GB"}`;
}

/** Handles both separators: capture paths arrive from Windows and from macOS. */
export function fileName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}

/** `Today`, `Yesterday`, or a date. `now` is injectable so tests can pin it. */
export function dayLabel(ts: number, now: number = Date.now()): string {
  const today = new Date(now);
  const midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();

  // Yesterday's boundary is computed the same way today's is — by asking the
  // calendar — rather than by subtracting 24 hours from it.
  //
  // A local day is not always 86,400,000 ms. The day a clock springs forward
  // is 23 hours, so `midnight - 86_400_000` landed an hour *before* yesterday
  // began and labelled the last hour of the day before that "Yesterday"; the
  // day it falls back is 25 hours, so the same expression landed an hour
  // *after*, and captures taken in yesterday's first hour were filed under a
  // date heading while the rest of that day sat under "Yesterday". Twice a
  // year, on the two days a person is most likely to notice a clock.
  //
  // `Date` handles a zero or negative day-of-month by rolling into the
  // previous month, so no special case is needed at a month or year boundary.
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1).getTime();

  if (ts >= midnight) return "Today";
  if (ts >= yesterday) return "Yesterday";
  // The year appears only when it is not this one.
  //
  // Without it, a pin from 26 July last year and one from 26 July this year both
  // headed a section "26 July" — two correct groups (`dayKey` carries the year)
  // under one heading. Pinned captures ignore retention and the item cap and
  // survive restarts, so that pair is ordinary rather than exotic.
  const when = new Date(ts);
  const sameYear = when.getFullYear() === today.getFullYear();
  return when.toLocaleDateString([], {
    day: "numeric",
    month: "long",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/**
 * Groups captures onto the same day heading, and orders those headings.
 *
 * `YYYY-MM-DD`, so comparing two keys as strings compares them as dates —
 * which is the whole point, and has been wrong twice.
 *
 * Without zero-padding the comparison is character by character, so
 * `2026-11-5` sorts *below* `2026-5-9`: `1` is less than `5` at the fifth
 * character, and the rest is never read. The shelf sorts descending, so that
 * put May at the top of the list and November underneath it — an older day
 * above a newer one, which is exactly the ordering the grouping exists to
 * provide.
 *
 * And `getMonth()` is zero-based, so writing it out unadjusted dated every
 * capture to the month before the one it was taken in.
 *
 * Local time, deliberately: captures are grouped by the day *you* took them,
 * not by the day it was in UTC.
 */
export function dayKey(ts: number): string {
  const date = new Date(ts);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}
