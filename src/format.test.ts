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
