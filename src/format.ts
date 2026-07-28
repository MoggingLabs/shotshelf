/**
 * Pure formatting helpers.
 *
 * Split out of the shelf so they can be tested without a DOM or a Tauri
 * runtime — importing `shelf.ts` pulls in the drag plugin and the asset
 * protocol, neither of which exists under `node --test`.
 */

/** `0:08`, `1:05`, `12:30`. */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
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

  if (ts >= midnight) return "Today";
  if (ts >= midnight - 86_400_000) return "Yesterday";
  return new Date(ts).toLocaleDateString([], { day: "numeric", month: "long" });
}

/**
 * Groups captures onto the same day heading, and orders those headings.
 *
 * `YYYY-MM-DD`, so comparing two keys as strings compares them as dates —
 * which is the whole point, and has been wrong twice. Without zero-padding,
 * `2026-11-5` sorted before `2026-5-9` and put December above June. And
 * `getMonth()` is zero-based, so writing it out unadjusted dated every capture
 * to the month before the one it was taken in.
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
