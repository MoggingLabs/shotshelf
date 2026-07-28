import assert from "node:assert/strict";
import { test } from "node:test";

import { Overlay } from "./overlay.ts";

/**
 * The rules two overlays used to keep separate copies of, and drifted on.
 *
 * Each case is a bug that shipped in one module while the other was already
 * fixed — plus one that shipped in the first attempt at sharing them.
 *
 * The restore is injected, so these assert on whether the window was asked
 * for without needing a Tauri runtime at all.
 */
const restores: number[] = [];

function tracked(): { overlay: Overlay<string>; torn: string[] } {
  const torn: string[] = [];
  const overlay = new Overlay<string>({
    teardown: (live) => void torn.push(live),
    restore: () => void restores.push(1),
  });
  return { overlay, torn };
}

test("a surface is open while it is being built, before it exists", async () => {
  const { overlay } = tracked();
  let sawOpening = false;

  await overlay.show(async () => {
    sawOpening = overlay.isOpen;
    return Promise.resolve("shown");
  });

  assert.equal(sawOpening, true, "open while building");
  assert.equal(overlay.isOpen, true);
  assert.equal(overlay.live, "shown");
});

test("a second show is refused while one is up", async () => {
  const { overlay } = tracked();
  await overlay.show(() => Promise.resolve("first"));

  let built = false;
  await overlay.show(() => {
    built = true;
    return Promise.resolve("second");
  });

  assert.equal(built, false, "the build never ran");
  assert.equal(overlay.live, "first");
});

test("backing out tears down, hands the window back, and reports it", async () => {
  restores.length = 0;
  const { overlay, torn } = tracked();
  await overlay.show(() => Promise.resolve("shown"));

  assert.equal(overlay.close(), true);
  assert.deepEqual(torn, ["shown"]);
  assert.equal(overlay.isOpen, false);
  assert.equal(restores.length, 1);
});

test("discarding tears down and does not put the window back", async () => {
  restores.length = 0;
  const { overlay, torn } = tracked();
  await overlay.show(() => Promise.resolve("shown"));

  overlay.discard();
  assert.deepEqual(torn, ["shown"]);
  assert.equal(restores.length, 0, "the user just hid the window");
});

test("closing an open still in flight consumes the gesture and unwinds it", async () => {
  restores.length = 0;
  const { overlay } = tracked();
  let release: (() => void) | undefined;
  const held = new Promise<void>((resume) => {
    release = resume;
  });

  const opening = overlay.show(async (stale) => {
    await held;
    return stale() ? undefined : "shown";
  });

  assert.equal(overlay.close(), true, "it consumed the gesture");
  release?.();
  await opening;

  assert.equal(overlay.isOpen, false);
  assert.equal(overlay.live, undefined, "nothing mounted");
  // Backing out owes the browse window back even though nothing was up yet:
  // the build may already have grown the window.
  assert.equal(restores.length, 1);
});

test("discarding an open in flight owes nothing", async () => {
  restores.length = 0;
  const { overlay } = tracked();
  let release: (() => void) | undefined;
  const held = new Promise<void>((resume) => {
    release = resume;
  });

  const opening = overlay.show(async () => {
    await held;
    return "shown";
  });

  overlay.discard();
  release?.();
  await opening;

  assert.equal(restores.length, 0, "restoring would re-show a hidden window");
});

test("a superseded open does not report the live one as closed", async () => {
  // The defect the first attempt at this class shipped: `finish()` cleared the
  // flag unconditionally, so a stale open's unwind said "nothing is opening"
  // while a newer one still was — and everything that vetoes on an open
  // overlay stopped vetoing.
  const { overlay } = tracked();
  let releaseFirst: (() => void) | undefined;
  const first = new Promise<void>((resume) => {
    releaseFirst = resume;
  });

  const stalled = overlay.show(async () => {
    await first;
    return "first";
  });

  overlay.close();

  let releaseSecond: (() => void) | undefined;
  const second = new Promise<void>((resume) => {
    releaseSecond = resume;
  });
  const live = overlay.show(async () => {
    await second;
    return "second";
  });

  // The first open unwinds now, while the second is still building.
  releaseFirst?.();
  await stalled;
  assert.equal(overlay.isOpen, true, "the second open is still in flight");

  releaseSecond?.();
  await live;
  assert.equal(overlay.live, "second");
});

test("work started after an open can tell which surface it belongs to", async () => {
  const { overlay } = tracked();
  await overlay.show(() => Promise.resolve("first"));
  const savingThis = overlay.current;

  overlay.close();
  await overlay.show(() => Promise.resolve("second"));

  assert.equal(overlay.stale(savingThis), true, "the save is for the old one");
});
