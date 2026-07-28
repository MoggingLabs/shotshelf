import assert from "node:assert/strict";
import { test } from "node:test";

import { ColumnQueue, COLUMN_MS } from "./column.ts";
import { columnHeight, CARD_GAP, CARD_HEIGHT, COLUMN_MAX_CARDS, COLUMN_PADDING } from "./geometry.ts";

test("the column shows newest first", () => {
  const column = new ColumnQueue();
  column.add("a", 0);
  column.add("b", 0);
  assert.deepEqual(column.ids(), ["b", "a"]);
});

test("a duplicate catch cannot keep a card alive forever", () => {
  const column = new ColumnQueue();
  column.add("a", 0);

  assert.equal(column.add("a", COLUMN_MS - 1), false, "re-adding is ignored, not a refresh");
  assert.equal(column.expire(COLUMN_MS + 1), true, "so it still expires on its original deadline");
  assert.ok(column.isEmpty);
});

test("cards expire once their minute is up", () => {
  const column = new ColumnQueue();
  column.add("a", 0);
  column.add("b", 30_000);

  assert.equal(column.expire(COLUMN_MS - 1), false, "nothing due yet");
  assert.equal(column.expire(COLUMN_MS + 1), true);
  assert.deepEqual(column.ids(), ["b"], "only the one that was due");
});

test("expire reports whether anything went, so the window is only resized when it must be", () => {
  const column = new ColumnQueue();
  column.add("a", 0);
  assert.equal(column.expire(1), false);
});

test("a held column does not age", () => {
  const column = new ColumnQueue();
  column.add("a", 0);
  column.hold(true, 0);

  assert.equal(column.expire(COLUMN_MS * 10), false, "you are plainly still using it");
  assert.equal(column.size, 1);
});

test("releasing a hold gives every card a full window again", () => {
  const column = new ColumnQueue();
  column.add("a", 0);
  column.hold(true, 0);
  column.hold(false, COLUMN_MS * 10);

  assert.equal(
    column.expire(COLUMN_MS * 10 + 1),
    false,
    "a card must not vanish the instant the pointer leaves",
  );
  assert.equal(column.expire(COLUMN_MS * 11 + 1), true);
});

test("holding twice is not a way to extend a card twice", () => {
  const column = new ColumnQueue();
  column.add("a", 0);
  column.hold(true, 0);
  column.hold(true, COLUMN_MS * 5);
  column.hold(false, COLUMN_MS * 5);
  assert.equal(column.expire(COLUMN_MS * 6 + 1), true);
});

test("removing a capture from the shelf takes it out of the column", () => {
  const column = new ColumnQueue();
  column.add("a", 0);
  assert.equal(column.remove("a"), true);
  assert.equal(column.remove("a"), false);
  assert.ok(column.isEmpty);
});

test("the queue holds more than it shows, so expired cards can be replaced", () => {
  const column = new ColumnQueue();
  for (let index = 0; index < COLUMN_MAX_CARDS * 5; index += 1) column.add(`id-${index}`, 0);
  assert.equal(column.size, COLUMN_MAX_CARDS * 3);
});

test("column height matches the cards it holds", () => {
  assert.equal(columnHeight(1), CARD_HEIGHT + COLUMN_PADDING);
  assert.equal(columnHeight(3), 3 * CARD_HEIGHT + 2 * CARD_GAP + COLUMN_PADDING);
});

test("column height is clamped at both ends", () => {
  assert.equal(columnHeight(0), columnHeight(1), "an empty column is never a slit");
  assert.equal(
    columnHeight(COLUMN_MAX_CARDS + 10),
    columnHeight(COLUMN_MAX_CARDS),
    "beyond the cap it scrolls rather than growing off the screen",
  );
});

test("the measured window sizes the shelf actually ships", () => {
  // Verified against the running app: 225x136 for one card, 225x378 for three.
  assert.equal(columnHeight(1), 136);
  assert.equal(columnHeight(3), 378);
});
