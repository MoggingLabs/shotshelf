import assert from "node:assert/strict";
import { test } from "node:test";

import { Selection } from "./selection.ts";

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

test("captures are handed over in the order they were picked", () => {
  const selection = new Selection();
  selection.toggle("c");
  selection.toggle("a");

  // A before and an after are only useful the right way round.
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
