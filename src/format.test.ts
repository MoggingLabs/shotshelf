import assert from "node:assert/strict";
import { test } from "node:test";
import { dayKey, dayLabel, fileName, formatBytes, formatDuration } from "./format.ts";

test("a recording's size is not reported in bytes", () => {
  // The badge once read "48 B" for a 135,725-byte file, because a stale byte
  // count reached the formatter. This is the assertion that would have caught it.
  assert.equal(formatBytes(135_725), "133 kB");
  assert.equal(formatBytes(1024), "1.0 kB");
  assert.equal(formatBytes(900), "900 B");
  assert.equal(formatBytes(5 * 1024 * 1024), "5.0 MB");
  assert.equal(formatBytes(120 * 1024 * 1024), "120 MB");
});

test("a nonsensical size does not render as NaN", () => {
  assert.equal(formatBytes(Number.NaN), "—");
  assert.equal(formatBytes(-1), "—");
});

test("durations read as minutes and seconds", () => {
  assert.equal(formatDuration(8_000), "0:08");
  assert.equal(formatDuration(65_000), "1:05");
  assert.equal(formatDuration(3_723_000), "62:03");
  assert.equal(formatDuration(0), "0:00");
});

test("filenames come off both Windows and macOS paths", () => {
  assert.equal(fileName("C:\\Users\\me\\Pictures\\Screenshots\\Screenshot (2).png"), "Screenshot (2).png");
  assert.equal(fileName("/Users/me/Desktop/Screen Shot.png"), "Screen Shot.png");
  assert.equal(fileName("bare.png"), "bare.png");
});

test("day labels are relative for the recent past only", () => {
  const now = new Date(2026, 6, 27, 14, 30).getTime();

  assert.equal(dayLabel(new Date(2026, 6, 27, 9, 0).getTime(), now), "Today");
  assert.equal(dayLabel(new Date(2026, 6, 27, 0, 1).getTime(), now), "Today");
  assert.equal(dayLabel(new Date(2026, 6, 26, 23, 59).getTime(), now), "Yesterday");
  assert.notEqual(dayLabel(new Date(2026, 6, 20, 12, 0).getTime(), now), "Yesterday");
});

test("day keys sort chronologically as plain strings", () => {
  // Group order relies on comparing these directly, so a January key must sort
  // before a December one rather than "0" before "11" lexically.
  const january = dayKey(new Date(2026, 0, 5).getTime());
  const december = dayKey(new Date(2026, 11, 5).getTime());
  assert.ok(january < december, `${january} should sort before ${december}`);

  const ninth = dayKey(new Date(2026, 5, 9).getTime());
  const tenth = dayKey(new Date(2026, 5, 10).getTime());
  assert.ok(ninth < tenth, `${ninth} should sort before ${tenth}`);
});

test("a day key is the calendar date it says it is", () => {
  // Ordering assertions alone let a zero-based `getMonth()` through for weeks:
  // every key was shifted a month early, and since the shift was uniform,
  // every comparison still passed. Assert the value, not just the relation.
  assert.equal(dayKey(new Date(2026, 0, 5).getTime()), "2026-01-05", "January is 01, not 00");
  assert.equal(dayKey(new Date(2026, 10, 5).getTime()), "2026-11-05", "November is 11, not 10");
  assert.equal(dayKey(new Date(2026, 11, 31).getTime()), "2026-12-31");
});

test("the Yesterday boundary follows the clock, not a 24-hour constant", () => {
  // A local day is 23 hours when the clock springs forward and 25 when it
  // falls back, so `midnight - 86_400_000` misses yesterday's start by an hour
  // twice a year. Assigning `TZ` here is what makes that reachable: Node clears
  // its cached zone on assignment, and CI runs in UTC, which has no DST at all.
  const previous = process.env["TZ"];
  process.env["TZ"] = "Europe/London";

  try {
    // 2026-03-29 01:00 UTC is when London goes to BST, so 2026-03-29 is 23
    // hours long. `now` is noon on the 30th; yesterday is the short day.
    const now = new Date(2026, 2, 30, 12, 0, 0).getTime();
    const yesterdayStarted = new Date(2026, 2, 29, 0, 0, 0).getTime();

    assert.equal(dayLabel(yesterdayStarted, now), "Yesterday");
    // One millisecond earlier is the day before, and must not be "Yesterday" —
    // the 24-hour subtraction reached a whole hour past this point.
    assert.notEqual(dayLabel(yesterdayStarted - 1, now), "Yesterday");
    assert.notEqual(dayLabel(yesterdayStarted - 3_600_000, now), "Yesterday");

    // And the long day, in the other direction: 2026-10-25 is 25 hours, so a
    // capture in its first hour was filed under a date heading while the rest
    // of the same day read "Yesterday".
    const autumnNow = new Date(2026, 9, 26, 12, 0, 0).getTime();
    const autumnStarted = new Date(2026, 9, 25, 0, 30, 0).getTime();
    assert.equal(dayLabel(autumnStarted, autumnNow), "Yesterday");
  } finally {
    if (previous === undefined) delete process.env["TZ"];
    else process.env["TZ"] = previous;
  }
});

test("Yesterday rolls into the previous month and year", () => {
  // `getDate() - 1` is 0 on the first of a month, which `Date` resolves to the
  // last day of the one before — including across a year boundary.
  const firstOfMarch = new Date(2026, 2, 1, 12, 0, 0).getTime();
  assert.equal(dayLabel(new Date(2026, 1, 28, 23, 0, 0).getTime(), firstOfMarch), "Yesterday");

  const newYear = new Date(2026, 0, 1, 12, 0, 0).getTime();
  assert.equal(dayLabel(new Date(2025, 11, 31, 23, 0, 0).getTime(), newYear), "Yesterday");
});

test("a size never renders in the unit below the one it belongs to", () => {
  // The unit was picked from the unrounded value, so 1,048,064 bytes left it at
  // 1023.5 kB and `toFixed(0)` printed "1024 kB" on a badge that should read
  // "1.0 MB". A band of sizes below every power of 1024 was affected.
  assert.equal(formatBytes(1_048_064), "1.0 MB");
  assert.equal(formatBytes(1_048_575), "1.0 MB");
  assert.equal(formatBytes(1_073_741_312), "1.0 GB");
  // And the ordinary cases are untouched.
  assert.equal(formatBytes(1023), "1023 B");
  assert.equal(formatBytes(1024), "1.0 kB");
});
