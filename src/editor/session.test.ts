import assert from "node:assert/strict";
import { test } from "node:test";

import { clipRect, EditSession } from "./session.ts";

function session(): EditSession {
  return new EditSession(100, 80);
}

/** The export region when nothing is cropped — the whole capture. */
const WHOLE = { x: 0, y: 0, width: 100, height: 80 };

test("a mark is kept in image pixels, clipped to the capture", () => {
  const edit = session();
  assert.ok(edit.add({ kind: "box", x: 90, y: 70, width: 50, height: 50 }));

  assert.deepEqual(edit.marks()[0], { kind: "box", x: 90, y: 70, width: 10, height: 10 });
});

test("a rectangle dragged up and left is normalised", () => {
  // Dragging is how every rectangle is made, and dragging that way produces a
  // negative width. Every consumer would otherwise have to remember it, and
  // one of them would forget.
  const edit = session();
  edit.add({ kind: "box", x: 40, y: 40, width: -20, height: -20 });

  assert.deepEqual(edit.marks()[0], { kind: "box", x: 20, y: 20, width: 20, height: 20 });
});

test("a rectangle entirely outside the capture is not a mark", () => {
  const edit = session();
  assert.equal(edit.add({ kind: "box", x: 500, y: 500, width: 10, height: 10 }), false);
  assert.equal(edit.marks().length, 0);
});

test("a click that moved slightly is not a rectangle", () => {
  const edit = session();
  assert.equal(edit.add({ kind: "box", x: 10, y: 10, width: 1, height: 30 }), false);
});

test("an arrow past the edge is clamped rather than dropped", () => {
  // Dragging past the edge means "point off that way", not "cancel".
  const edit = session();
  edit.add({ kind: "arrow", x1: 50, y1: 40, x2: 300, y2: -60 });

  assert.deepEqual(edit.marks()[0], { kind: "arrow", x1: 50, y1: 40, x2: 100, y2: 0 });
});

test("a zero-length arrow is a stray click", () => {
  const edit = session();
  assert.equal(edit.add({ kind: "arrow", x1: 10, y1: 10, x2: 11, y2: 10 }), false);
});

test("callouts number themselves in order", () => {
  const edit = session();
  assert.equal(edit.nextNumber(), 1);

  edit.add({ kind: "callout", x: 10, y: 10, number: edit.nextNumber() });
  edit.add({ kind: "callout", x: 20, y: 20, number: edit.nextNumber() });

  assert.equal(edit.nextNumber(), 3);
});

test("undoing a callout frees its number rather than leaving a gap", () => {
  // A sequence that jumps from 1 to 3 reads as a missing step, and the whole
  // point of numbering is being able to say "why is 2 wrong?".
  const edit = session();
  edit.add({ kind: "callout", x: 10, y: 10, number: edit.nextNumber() });
  edit.add({ kind: "callout", x: 20, y: 20, number: edit.nextNumber() });

  edit.undo();

  assert.equal(edit.nextNumber(), 2);
});

test("a mark keeps the kind it was added with", () => {
  // Narrow on purpose. A box outlines something and a redaction destroys what
  // is under it, but that distinction lives in `src/editor/draw.ts` — a
  // destructive fill against a hollow stroke — and `#clip` here handles both
  // in one arm, returning `kind` verbatim.
  //
  // So this checks that the field survives clipping, which is all it can
  // check; it used to be titled and commented as though it guarded against an
  // annotation shipping as a redaction, which no edit to this file could
  // cause. The behavioural guarantee is
  // `tests/e2e/editor.spec.ts` — "a redaction destroys the pixels rather than
  // drawing over them".
  const edit = session();
  edit.add({ kind: "redact", x: 10, y: 10, width: 20, height: 20 });

  assert.equal(edit.marks()[0]?.kind, "redact");
});

test("undo takes back marks newest first, then the crop", () => {
  const edit = session();
  edit.setCrop({ x: 10, y: 10, width: 50, height: 50 });
  edit.add({ kind: "box", x: 20, y: 20, width: 10, height: 10 });

  assert.equal(edit.undo(), true);
  assert.equal(edit.marks().length, 0);
  // Through `exportRect`, which is how everything that draws or exports reads
  // the crop. `crop()` existed only so these four assertions could be written,
  // and a getter with no caller outside its own tests is a second way to ask
  // the same question that nothing keeps in step with the first.
  assert.notDeepEqual(edit.exportRect(), WHOLE, "the crop is still there");

  assert.equal(edit.undo(), true);
  assert.deepEqual(edit.exportRect(), WHOLE, "undoing a crop gives the whole capture back");

  assert.equal(edit.undo(), false, "nothing left to undo");
});

test("a second crop replaces the first", () => {
  // Cropping a crop is a sequence of coordinate spaces nobody can reason
  // about, and the second drag almost always means "no, this bit".
  const edit = session();
  edit.setCrop({ x: 0, y: 0, width: 60, height: 60 });
  edit.setCrop({ x: 10, y: 10, width: 20, height: 20 });

  assert.deepEqual(edit.exportRect(), { x: 10, y: 10, width: 20, height: 20 });
});

test("the exported region is the crop, or the whole capture", () => {
  const edit = session();
  assert.deepEqual(edit.exportRect(), { x: 0, y: 0, width: 100, height: 80 });

  edit.setCrop({ x: 5, y: 5, width: 30, height: 30 });
  assert.deepEqual(edit.exportRect(), { x: 5, y: 5, width: 30, height: 30 });
});

test("a crop is clipped to the capture", () => {
  const edit = session();
  edit.setCrop({ x: 80, y: 60, width: 999, height: 999 });

  assert.deepEqual(edit.exportRect(), { x: 80, y: 60, width: 20, height: 20 });
});

test("clipRect refuses a rectangle with no area", () => {
  assert.equal(clipRect({ x: 10, y: 10, width: 0, height: 10 }, 100, 100), undefined);
});

test("undo follows the order things were done, not the kind they were", () => {
  // The natural order, and the one the old code got wrong: the default tool is
  // `box`, so a mark comes first and Crop has to be clicked. Undo popped a mark
  // whenever there was one, so it took the annotation and left the crop — with
  // no redo anywhere in the app.
  const edit = session();
  edit.add({ kind: "box", x: 5, y: 5, width: 20, height: 20 });
  edit.setCrop({ x: 0, y: 0, width: 40, height: 40 });

  assert.equal(edit.undo(), true);
  assert.equal(edit.marks().length, 1, "the crop was the last thing done");
  assert.deepEqual(edit.exportRect(), { x: 0, y: 0, width: 100, height: 80 });

  assert.equal(edit.undo(), true);
  assert.equal(edit.marks().length, 0);
  assert.equal(edit.undo(), false, "nothing left to undo");
});

test("a second crop replaces the first in the history as well as the state", () => {
  // Crop is not additive — a second one replaces the first — so it must not
  // leave two entries behind, or undoing twice would try to remove a crop that
  // is already gone and swallow the mark underneath it.
  const edit = session();
  edit.setCrop({ x: 0, y: 0, width: 40, height: 40 });
  edit.add({ kind: "box", x: 1, y: 1, width: 5, height: 5 });
  edit.setCrop({ x: 0, y: 0, width: 30, height: 30 });

  assert.equal(edit.undo(), true);
  assert.deepEqual(edit.exportRect(), { x: 0, y: 0, width: 100, height: 80 });
  assert.equal(edit.undo(), true);
  assert.equal(edit.marks().length, 0);
  assert.equal(edit.undo(), false);
});
