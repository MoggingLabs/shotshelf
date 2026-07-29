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
  column.hold("pointer", true, 0);

  assert.equal(column.expire(COLUMN_MS * 10), false, "you are plainly still using it");
  assert.equal(column.size, 1);
});

test("releasing a hold gives every card a full window again", () => {
  const column = new ColumnQueue();
  column.add("a", 0);
  column.hold("pointer", true, 0);
  column.hold("pointer", false, COLUMN_MS * 10);

  assert.equal(
    column.expire(COLUMN_MS * 10 + 1),
    false,
    "a card must not vanish the instant the pointer leaves",
  );
  assert.equal(column.expire(COLUMN_MS * 11 + 1), true);
});

test("one holder releasing does not release another's hold", () => {
  // The live defect this models: the window has focus and the pointer is over
  // the popover. The pointer leaves. Focus still wants the column held, but a
  // single boolean let the pointer's release speak for both — every deadline
  // reset and the cards resumed ageing behind focus's back.
  const column = new ColumnQueue();
  column.add("a", 0);
  column.hold("focus", true, 0);
  column.hold("pointer", true, 0);

  column.hold("pointer", false, 0);

  assert.equal(column.held, true, "focus is still holding it");
  assert.equal(column.expire(COLUMN_MS * 10), false, "so nothing ages");

  column.hold("focus", false, COLUMN_MS * 10);
  assert.equal(column.held, false);
  assert.equal(
    column.expire(COLUMN_MS * 10 + 1),
    false,
    "the last release still grants a full window",
  );
  assert.equal(column.expire(COLUMN_MS * 11 + 1), true);
});

test("re-holding a reason already held does not extend anything", () => {
  const column = new ColumnQueue();
  column.add("a", 0);
  column.hold("pointer", true, 0);
  column.hold("pointer", true, COLUMN_MS * 5);
  column.hold("pointer", false, COLUMN_MS * 5);
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

test("every hold can be dropped at once when the events that release them cannot arrive", () => {
  // A hidden window stops delivering pointer events, and a native drag takes
  // the pointer away from the webview entirely — so the `pointerleave` that
  // would have released the hover hold never comes. Left armed, the column
  // never ages again and the popover stops dismissing itself for the session.
  const column = new ColumnQueue();
  column.add("a", 0);
  column.hold("pointer", true, 0);
  column.hold("focus", true, 0);

  column.releaseAll(COLUMN_MS * 3);

  assert.equal(column.held, false);
  assert.equal(column.expire(COLUMN_MS * 3 + 1), false, "counts as the last release");
  assert.equal(column.expire(COLUMN_MS * 4 + 1), true);
});

test("releasing nothing does not reset the deadlines", () => {
  const column = new ColumnQueue();
  column.add("a", 0);
  column.releaseAll(COLUMN_MS * 3);
  assert.equal(column.expire(COLUMN_MS + 1), true, "an unheld column ages normally");
});

test("the column makes room for whatever else is in it", () => {
  // The second argument had no test at all: every call in this file passed one
  // argument, so deleting `+ alsoShowing` from `columnHeight` left the suite
  // green — and that term is the whole fix for the alert strip clipping the
  // capture it was about, which `geometry.ts` documents at length.
  //
  // The only two-argument call in the repo is production code.
  const oneCard = columnHeight(1);
  assert.equal(columnHeight(1, 47), oneCard + 47, "the strip is added, not absorbed");
  assert.equal(columnHeight(3, 0), columnHeight(3), "and zero changes nothing");
});

test("releasing a hold nobody was holding does not restart the clock", () => {
  // The `holdersBefore > 0` half of the transition guard had no test: dropping
  // it left every unit and browser test green, and the whole point of the guard
  // is written three lines above it — a repeatedly-toggled reason must not keep
  // a card alive indefinitely.
  //
  // `hold(reason, false)` on an unheld column is the ordinary case, not a
  // contrived one: `pointerleave` fires without a matching `pointerenter` when
  // the column is rebuilt under a stationary cursor, which is exactly what
  // happens each time a capture lands while the pointer rests on the shelf. So
  // a steady stream of captures would push the deadline forward for ever and
  // the column would never age out.
  const column = new ColumnQueue();
  column.add("a", 0);

  // Not held, so this is a release from zero holders.
  column.hold("pointer", false, COLUMN_MS - 1);

  assert.equal(
    column.expire(COLUMN_MS + 1),
    true,
    "the card still expires on the deadline it was given",
  );
  assert.ok(column.isEmpty);
});

test("releasing the last real hold does restart the clock", () => {
  // The other half, so the pair pins the transition rather than just one side
  // of it: deleting `#refreshAll(now)` outright has to fail too.
  const column = new ColumnQueue();
  column.add("a", 0);

  column.hold("pointer", true, 1);
  column.hold("pointer", false, COLUMN_MS - 1);

  assert.equal(
    column.expire(COLUMN_MS + 1),
    false,
    "the released card was given a fresh full window",
  );
  assert.equal(column.expire(COLUMN_MS * 2), true, "and it expires a window later");
});

test("a column holding only a message is sized for the message", () => {
  // The zero-card branch had no test at all: deleting it left 111 unit and 160
  // browser tests green, and it is the whole reason `Popover.showProblem` does
  // not put its message at the bottom of 136px of nothing.
  const strip = 46;
  assert.equal(
    columnHeight(0, strip),
    COLUMN_PADDING + strip,
    "no cards and a strip is padding plus the strip",
  );

  // The floor still applies when there is nothing else to show — a window of
  // pure padding is not a window anyone wants either.
  assert.equal(columnHeight(0), columnHeight(1), "no cards and no strip keeps the one-card floor");

  // And one card plus a strip is still both.
  assert.equal(columnHeight(1, strip), columnHeight(1) + strip);
});
