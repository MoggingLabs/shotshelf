import assert from "node:assert/strict";
import { test } from "node:test";

import { inHandoverOrder, Selection } from "./selection.ts";

const ORDER = ["a", "b", "c", "d", "e"];

test("picking one drops the rest", () => {
  const selection = new Selection();
  selection.toggle("a");
  selection.toggle("b");
  selection.only("c");

  assert.deepEqual(selection.ids(), ["c"]);
});

test("toggling adds and removes without disturbing the rest", () => {
  const selection = new Selection();
  selection.toggle("a");
  selection.toggle("b");
  selection.toggle("a");

  assert.deepEqual(selection.ids(), ["b"]);
});

test("ids() is pick order, which is not handover order", () => {
  const selection = new Selection();
  selection.toggle("c");
  selection.toggle("a");

  // Pick order, and *only* pick order. This test used to be called "captures
  // are handed over in the order they were picked", which is the exact belief
  // `inHandoverOrder` was written to correct: reading this list as a before/an
  // after handed the pair over backwards whenever the user picked the newer
  // capture first, or dragged a range upwards. Naming it that way here put the
  // trap back into the file that removed it, one test above the one that
  // documents why it is a trap.
  //
  // What `ids()` guarantees is insertion order of a set — useful for "which
  // are lit", useless for "which is the before".
  assert.deepEqual(selection.ids(), ["c", "a"]);
});

test("a range covers everything between the anchor and the target", () => {
  const selection = new Selection();
  selection.only("b");
  selection.extendTo("d", ORDER);

  assert.deepEqual(selection.ids(), ["b", "c", "d"]);
});

test("a range works backwards too", () => {
  const selection = new Selection();
  selection.only("d");
  selection.extendTo("b", ORDER);

  assert.deepEqual(selection.ids(), ["b", "c", "d"]);
});

test("re-extending counts from the same anchor rather than walking down", () => {
  const selection = new Selection();
  selection.only("b");
  selection.extendTo("d", ORDER);
  selection.extendTo("c", ORDER);

  assert.deepEqual(selection.ids(), ["b", "c"], "shrinking a range must not drag the anchor along");
});

test("a range with no anchor picks just the one clicked", () => {
  const selection = new Selection();
  selection.extendTo("c", ORDER);
  assert.deepEqual(selection.ids(), ["c"]);
});

test("a range whose anchor has left the shelf starts again from the click", () => {
  const selection = new Selection();
  selection.only("a");
  // `a` is swept away while the selection is live.
  selection.extendTo("d", ["b", "c", "d", "e"]);

  assert.deepEqual(selection.ids(), ["d"]);
});

test("untoggling the anchor moves it to something still picked", () => {
  const selection = new Selection();
  selection.toggle("a");
  selection.toggle("b");
  selection.toggle("b");

  selection.extendTo("c", ORDER);

  assert.deepEqual(selection.ids(), ["a", "b", "c"], "the anchor fell back to `a`");
});

test("captures that leave the shelf leave the selection", () => {
  const selection = new Selection();
  selection.toggle("a");
  selection.toggle("b");
  selection.toggle("c");

  // The retention sweep takes `b`.
  selection.retain(["a", "c"]);

  assert.deepEqual(selection.ids(), ["a", "c"], "a drag must never be handed a missing file");
});

test("clearing forgets the anchor too", () => {
  const selection = new Selection();
  selection.only("b");
  selection.clear();
  selection.extendTo("d", ORDER);

  assert.deepEqual(selection.ids(), ["d"]);
  assert.deepEqual(new Selection().ids(), []);
});

test("a selection is handed over oldest first, whichever gesture picked it", () => {
  // The rule a comparison depends on: `Selection.ids()` yields click order for
  // a ctrl-click and newest-first for a shift-range, so anything reading it
  // directly handed a before/after pair over backwards for one gesture and
  // correctly for the other — a bug that looks like working software.
  //
  // It lived on the DOM-bound facade until now and could only be reached
  // through a browser.
  const older = { ts: 100, path: "/a/first.png" };
  const newer = { ts: 200, path: "/a/second.png" };

  assert.deepEqual(inHandoverOrder([newer, older]), [older, newer]);
  assert.deepEqual(inHandoverOrder([older, newer]), [older, newer]);
});

test("two captures sharing a millisecond still have one defined order", () => {
  // Legal: identity is `ts:path`, so two captures can share a timestamp. Left
  // to `ts` alone the sort is not total, and the order falls back to whatever
  // the input happened to be — which is the ordering this exists to avoid.
  const a = { ts: 100, path: "/a/alpha.png" };
  const b = { ts: 100, path: "/a/beta.png" };

  assert.deepEqual(inHandoverOrder([b, a]), [a, b]);
  assert.deepEqual(inHandoverOrder([a, b]), [a, b]);
});

test("handing over does not disturb the caller's list", () => {
  const items = [{ ts: 2, path: "/b.png" }, { ts: 1, path: "/a.png" }];
  inHandoverOrder(items);
  assert.equal(items[0]?.path, "/b.png", "the input was sorted in place");
});

test("the keyboard moves from the card last acted on, not the bottom of a range", () => {
  // `extendTo` rebuilds the picked set in on-screen order, so after a range
  // selected *upwards* `ids().at(-1)` is the bottom of the range — the opposite
  // end from the card the user shift-clicked. `moveSelection` read that, so the
  // next ArrowUp stepped down from the wrong card.
  const selection = new Selection();
  selection.only("d");
  selection.extendTo("b", ORDER);

  assert.deepEqual(selection.ids(), ["b", "c", "d"]);
  assert.equal(selection.focus(), "d", "the anchor is where the range started");
});

test("focus falls back to the last picked when there is no anchor", () => {
  const selection = new Selection();
  selection.toggle("a");
  selection.toggle("c");

  assert.equal(selection.focus(), "c");
});
