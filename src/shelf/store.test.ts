import assert from "node:assert/strict";
import { test } from "node:test";

import { ShelfStore } from "./store.ts";
import { captureId, type Capture } from "./types.ts";

const HOUR = 3_600_000;

function capture(ts: number, path = `/shots/${ts}.png`): Capture {
  return { path, kind: "image", ts };
}

test("a capture caught twice only lands once", () => {
  const store = new ShelfStore();
  const shot = capture(1000);

  assert.ok(store.add(shot));
  assert.equal(store.add(shot), undefined, "the second catch is ignored");
  assert.equal(store.size, 1);
});

test("the same path caught at a different time is a different capture", () => {
  const store = new ShelfStore();
  store.add(capture(1000, "/shots/a.png"));
  store.add(capture(2000, "/shots/a.png"));
  assert.equal(store.size, 2, "re-saving a file is a new capture, not a duplicate");
});

test("captures are held newest first", () => {
  const store = new ShelfStore();
  store.add(capture(1000));
  store.add(capture(3000));
  store.add(capture(2000));

  assert.deepEqual(
    store.items().map((item) => item.ts),
    [2000, 3000, 1000],
    "insertion order, newest-added first — not sorted by timestamp",
  );
});

test("trim evicts the oldest unpinned captures and hands them back", () => {
  const store = new ShelfStore();
  for (const ts of [1000, 2000, 3000, 4000]) store.add(capture(ts));

  const evicted = store.trim(2);

  assert.deepEqual(evicted.map((item) => item.ts), [1000, 2000]);
  assert.equal(store.size, 2, "the caller needs the evictions to clean up after them");
});

test("the item cap counts unpinned captures only", () => {
  const store = new ShelfStore();
  for (const ts of [1000, 2000]) {
    const item = store.add(capture(ts));
    assert.ok(item);
    item.pinned = true;
  }
  store.add(capture(3000));

  assert.deepEqual(store.trim(2), [], "two pins and a cap of two must not evict the new capture");
  assert.equal(store.size, 3);
});

test("trim never evicts a pinned capture, however far over the cap", () => {
  const store = new ShelfStore();
  for (const ts of [1000, 2000, 3000]) {
    const item = store.add(capture(ts));
    assert.ok(item);
    item.pinned = true;
  }

  assert.deepEqual(store.trim(0), []);
  assert.equal(store.size, 3);
});

test("sweep drops unpinned captures past the retention window", () => {
  const store = new ShelfStore();
  const now = 100 * HOUR;
  store.add(capture(now - 3 * HOUR));
  store.add(capture(now - 1 * HOUR));

  const evicted = store.sweep(2, now);

  assert.equal(evicted.length, 1);
  assert.equal(evicted[0]?.ts, now - 3 * HOUR);
  assert.equal(store.size, 1);
});

test("sweep spares pinned captures however old", () => {
  const store = new ShelfStore();
  const now = 100 * HOUR;
  const item = store.add(capture(now - 50 * HOUR));
  assert.ok(item);
  item.pinned = true;

  assert.deepEqual(store.sweep(1, now), []);
  assert.equal(store.size, 1);
});

test("a null retention window keeps everything", () => {
  const store = new ShelfStore();
  store.add(capture(0));
  assert.deepEqual(store.sweep(null, 100 * HOUR), []);
  assert.equal(store.size, 1);
});

test("removing returns the item so its poster frame can be cleaned up", () => {
  const store = new ShelfStore();
  const shot: Capture = { path: "/clips/a.mp4", kind: "video", ts: 1000 };
  store.add(shot);

  const removed = store.remove(captureId(shot));

  assert.equal(removed?.kind, "video", "the caller needs the kind to know there is a poster");
  assert.equal(store.remove(captureId(shot)), undefined, "removing twice is not an error");
});

test("pins round-trip in the shape settings persists", () => {
  const store = new ShelfStore();
  const shot = capture(1000);
  store.add(shot);
  store.add(capture(2000));

  assert.equal(store.togglePin(captureId(shot)), true);
  assert.deepEqual(store.pinned(), [{ path: shot.path, kind: "image", ts: 1000 }]);

  assert.equal(store.togglePin(captureId(shot)), false);
  assert.deepEqual(store.pinned(), []);
});

test("toggling a pin on an unknown capture reports rather than throws", () => {
  assert.equal(new ShelfStore().togglePin("nope"), undefined);
});
