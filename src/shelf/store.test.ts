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

test("the cap evicts an unpinned capture even when older pinned ones sit below it", () => {
  // The shape the existing fixtures could not reach.
  //
  // "trim never evicts a pinned capture" pins *every* item, so `unpinned` is 0,
  // `0 > cap` is false and the loop body never runs; "the cap counts unpinned
  // captures only" has one unpinned against a cap of two, so it never runs
  // either. Both are true with the `item.pinned` skip deleted.
  //
  // And this arrangement is the ordinary one, not a contrivance:
  // `restorePinned` adds pins oldest-first at launch and captures land on top,
  // so the oldest entries are exactly the pinned ones. Without the skip, the
  // loop walks from the oldest and evicts a pin — the one piece of shelf state
  // promised to survive a restart — while leaving the unpinned capture that
  // pushed it over the cap.
  const store = new ShelfStore();
  store.add(capture(1000, "/a/one.png"), { pinned: true });
  store.add(capture(2000, "/a/two.png"), { pinned: true });
  store.add(capture(3000, "/a/three.png"));
  store.add(capture(4000, "/a/four.png"));

  const evicted = store.trim(1);

  assert.deepEqual(
    evicted.map((item) => item.path),
    ["/a/three.png"],
    "the oldest *unpinned* capture goes, and only that one",
  );
  assert.deepEqual(
    store.items().map((item) => item.path),
    ["/a/four.png", "/a/two.png", "/a/one.png"],
    "both pins stay, however far over the cap they put the shelf",
  );
});
