/**
 * The view maths, in Node.
 *
 * These run here rather than in a browser spec because the one thing they most
 * need to be right about — the relationship between image pixels, CSS pixels
 * and `devicePixelRatio` — is the one thing a Playwright spec cannot vary:
 * both projects pin `deviceScaleFactor: 1`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { Rect } from "./session.ts";
import {
  clampOrigin,
  clampScale,
  centred,
  fitScale,
  fitView,
  MAX_SCALE,
  MIN_SCALE,
  pan,
  toImage,
  zoomAbout,
  zoomLabel,
  type View,
} from "./view.ts";

const region = (x: number, y: number, width: number, height: number): Rect => ({
  x,
  y,
  width,
  height,
});

test("fit shows all of a small capture at actual size, never blown up", () => {
  // Observed live on the first open this feature ever had: a 320x180 capture
  // in a 1575px window opened at **464%**, in blocks, because smoothing is off
  // above 100%. Fit means "show me all of it", and all of a small capture is
  // already on screen.
  const small = region(0, 0, 320, 180);
  const view = fitView(small, { width: 1500, height: 800 });
  assert.equal(view.scale, 1);
  assert.equal(zoomLabel(view), "100%");

  // …and it is centred in the space rather than parked in a corner.
  assert.equal(view.originX, -590);
  assert.equal(view.originY, -310);

  // A capture *larger* than the window still fits down, which is the case the
  // cap must not break.
  assert.equal(fitView(region(0, 0, 3000, 1500), { width: 1500, height: 800 }).scale, 0.5);
});

test("fit shows all of the capture, and does not distort it", () => {
  // A wide capture in a squarer box: the width binds.
  assert.equal(fitScale(region(0, 0, 800, 400), { width: 400, height: 400 }), 0.5);
  // A tall one in the same box: the height binds.
  assert.equal(fitScale(region(0, 0, 400, 800), { width: 400, height: 400 }), 0.5);

  // Before the first layout there is no box, and every later multiplication
  // has to stay finite.
  assert.equal(fitScale(region(0, 0, 800, 400), { width: 0, height: 0 }), 1);
  assert.equal(fitScale(region(0, 0, 0, 0), { width: 400, height: 400 }), 1);
});

test("a capture smaller than the stage is centred, not cornered", () => {
  // 100x100 image at 1:1 inside a 400x300 stage. The visible span is larger
  // than the image on both axes, so the origin goes negative by half the
  // difference — which is what puts the picture in the middle.
  const view = clampOrigin(
    { scale: 1, originX: 0, originY: 0, fitted: false },
    region(0, 0, 100, 100),
    { width: 400, height: 300 },
  );
  assert.equal(view.originX, -150);
  assert.equal(view.originY, -100);
});

test("a capture larger than the stage cannot be panned off the edge", () => {
  const image = region(0, 0, 1000, 1000);
  const box = { width: 200, height: 200 };
  const at = (originX: number, originY: number): View => ({
    scale: 1,
    originX,
    originY,
    fitted: false,
  });

  // Past the top-left corner comes back to it.
  assert.deepEqual(
    clampOrigin(at(-500, -500), image, box),
    { scale: 1, originX: 0, originY: 0, fitted: false },
  );
  // Past the bottom-right stops with the last 200px of image on screen —
  // never at 1000, which would show blank canvas and no way back.
  assert.deepEqual(
    clampOrigin(at(5000, 5000), image, box),
    { scale: 1, originX: 800, originY: 800, fitted: false },
  );
  // A NaN origin (a division by a zero-width box earlier in the chain) falls
  // back to the region's own corner rather than propagating.
  assert.equal(clampOrigin(at(Number.NaN, 0), image, box).originX, 0);
});

test("a crop's origin is honoured, not assumed to be zero", () => {
  // The region after a crop does not start at 0,0 — every clamp is relative to
  // the crop's own corner. Getting this wrong is invisible on a first crop and
  // wrong on every one after it.
  const cropped = region(300, 200, 400, 400);
  const view = clampOrigin(
    { scale: 1, originX: -9999, originY: -9999, fitted: false },
    cropped,
    { width: 100, height: 100 },
  );
  assert.equal(view.originX, 300);
  assert.equal(view.originY, 200);
});

test("zooming keeps the point under the pointer under the pointer", () => {
  const image = region(0, 0, 1000, 1000);
  const box = { width: 200, height: 200 };
  const start: View = { scale: 1, originX: 400, originY: 400, fitted: false };

  // The image point under the stage's centre before the zoom…
  const at = { x: 100, y: 100 };
  const before = toImage(start, at);
  const after = zoomAbout(start, image, box, 2, at);

  // …is the image point under it afterwards. The whole feel of wheel zoom.
  const settled = toImage(after, at);
  assert.ok(Math.abs(settled.x - before.x) < 0.001, `${settled.x} vs ${before.x}`);
  assert.ok(Math.abs(settled.y - before.y) < 0.001);
  assert.equal(after.scale, 2);
  assert.equal(after.fitted, false, "a zoom leaves Fit mode");
});

test("the zoom range is bounded at both ends", () => {
  assert.equal(clampScale(1000), MAX_SCALE);
  assert.equal(clampScale(0.0001), MIN_SCALE);
  // A zero, a negative or a NaN is not a scale at all, and must not become a
  // division by zero in `toImage`.
  assert.equal(clampScale(0), 1);
  assert.equal(clampScale(-2), 1);
  assert.equal(clampScale(Number.NaN), 1);
  // An infinity is treated as "not a scale" rather than as "the largest one".
  // Both readings are defensible; this one is the same reading `clampOrigin`
  // and the Rust sanitiser give every other non-finite number in the app, and
  // one rule stated three times the same way is worth more than a clever
  // exception here.
  assert.equal(clampScale(Number.POSITIVE_INFINITY), 1);
});

test("panning moves the picture with the hand, in image pixels", () => {
  const image = region(0, 0, 1000, 1000);
  const box = { width: 200, height: 200 };
  const start: View = { scale: 2, originX: 400, originY: 400, fitted: true };

  // Dragging right by 100 stage pixels at 2x moves 50 image pixels, and the
  // picture follows the hand — so the origin goes *down*.
  const moved = pan(start, image, box, 100, 0);
  assert.equal(moved.originX, 350);
  assert.equal(moved.originY, 400);
  assert.equal(moved.fitted, false, "a pan leaves Fit mode too");
});

test("fit and 100% are the two the toolbar names", () => {
  const image = region(0, 0, 800, 400);
  const box = { width: 400, height: 400 };

  const fit = fitView(image, box);
  assert.equal(fit.scale, 0.5);
  assert.equal(zoomLabel(fit), "50%");

  const full = centred(image, box, 1);
  assert.equal(zoomLabel(full), "100%");
  // 100% on a capture wider than the stage shows the middle of it.
  assert.equal(full.originX, 200);
});
