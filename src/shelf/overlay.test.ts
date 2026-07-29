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
  // The half that actually needs `discard()` to invalidate the ticket.
  //
  // Without this line the test was more true the more broken the code got:
  // `#restore()` is only reachable from the *stale* branch of `show`, so
  // deleting the invalidation makes that branch unreachable and leaves
  // `restores.length === 0` trivially satisfied — while the discarded surface
  // mounts anyway. The sibling test twenty lines up asserts exactly this and
  // the discard twin omitted it.
  //
  // What that costs is documented at `Overlay.discard`: the surface outlives
  // the hide, and the next capture pops a column with a stale canvas painted
  // across it — untouchable, because a peeked window never takes focus, so
  // Escape cannot reach it either.
  assert.equal(overlay.live, undefined, "the discarded open must not mount");
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

test("a refused show reports that it mounted nothing", async () => {
  // The caller must not key its post-mount work off `live`: after a refusal
  // that is someone else's surface. The editor did exactly that and bound a
  // second set of pointer handlers to the canvas already on screen, after
  // which one drag committed two marks.
  const { overlay } = tracked();

  assert.equal(await overlay.show(() => Promise.resolve("first")), true);
  assert.equal(await overlay.show(() => Promise.resolve("second")), false);
  assert.equal(overlay.live, "first");
});

test("a build that declines to mount reports false", async () => {
  const { overlay } = tracked();
  assert.equal(await overlay.show(() => Promise.resolve(undefined)), false);
  assert.equal(overlay.isOpen, false);
});

test("a discarded open does not collapse the window under a later one", async () => {
  // `#abandoned` was a mode rather than a fact about one open, and any later
  // `show` reset it — so an open parked on a slow picture could be discarded,
  // superseded, and then resolve to find the flag cleared and hand the window
  // back underneath the surface now on screen.
  restores.length = 0;
  const { overlay } = tracked();

  let releaseFirst: (() => void) | undefined;
  const held = new Promise<void>((resume) => {
    releaseFirst = resume;
  });
  const abandoned = overlay.show(async () => {
    await held;
    return "first";
  });

  overlay.discard();
  await overlay.show(() => Promise.resolve("second"));

  releaseFirst?.();
  await abandoned;

  assert.equal(overlay.live, "second", "the later surface is untouched");
  assert.equal(restores.length, 0, "the abandoned open owed nothing");
});

/**
 * A fake picture and a fake clock, so the deadline can be reached in a test.
 *
 * `readable` touches exactly two things — `window.setTimeout`/`clearTimeout`
 * and the picture's listeners — which is what makes it testable here at all,
 * without a browser or a real fifteen-second wait.
 */
interface FakeTimer {
  id: number;
  delay: number;
  /** Run the callback, as the real clock would when the delay elapses. */
  fire: () => void;
}

function fakeClock(): {
  pending: FakeTimer[];
  /** Ids passed to `clearTimeout`, which is the only way to see a cancel. */
  cancelled: Set<number>;
  restore: () => void;
} {
  const pending: FakeTimer[] = [];
  const cancelled = new Set<number>();
  const previous = (globalThis as { window?: unknown }).window;

  (globalThis as { window?: unknown }).window = {
    setTimeout: (fn: () => void, delay: number): number => {
      // Captured now, not read at fire time: `pending.length` moves as more
      // timers are armed, so the guard was checking a different timer's id
      // the moment there was more than one.
      const id = pending.length + 1;
      pending.push({
        id,
        delay,
        fire: () => {
          if (!cancelled.has(id)) fn();
        },
      });
      return id;
    },
    clearTimeout: (id: number): void => void cancelled.add(id),
  };

  return {
    pending,
    cancelled,
    restore: () => {
      (globalThis as { window?: unknown }).window = previous;
    },
  };
}

function fakePicture(): {
  node: HTMLImageElement;
  fire: (event: "load" | "error") => void;
} {
  const handlers = new Map<string, () => void>();
  const node = {
    complete: false,
    naturalWidth: 0,
    addEventListener: (event: string, handler: () => void): void => void handlers.set(event, handler),
  };
  return {
    node: node as unknown as HTMLImageElement,
    fire: (event) => handlers.get(event)?.(),
  };
}

test("a picture that never loads gives up instead of wedging the overlay", async () => {
  // Neither `load` nor `error` is guaranteed to fire — a capture on a
  // disconnected share, one still being written. Without a deadline the open
  // never ends, the overlay reports itself open forever, and the shelf stops
  // answering the keyboard for the rest of the session.
  //
  // That is the bug this module was extracted to end, and the deadline was
  // the one part of it with no test anywhere: `readable` had no coverage, so
  // raising the timeout to an hour or deleting it outright changed nothing
  // that any gate could see.
  const clock = fakeClock();
  try {
    const { readable } = await import("./overlay.ts");
    const picture = fakePicture();
    const waiting = readable(picture.node);

    const deadline = clock.pending[0];
    assert.ok(deadline, "a deadline was armed");
    assert.equal(clock.pending.length, 1);
    assert.equal(
      deadline.delay,
      15_000,
      "long enough for a slow share, short enough to be a wait rather than a hang",
    );

    deadline.fire();
    assert.equal(await waiting, undefined, "gave up rather than never resolving");
  } finally {
    clock.restore();
  }
});

test("a picture that loads settles with the picture and drops its deadline", async () => {
  const clock = fakeClock();
  try {
    const { readable } = await import("./overlay.ts");
    const picture = fakePicture();
    const waiting = readable(picture.node);

    const deadline = clock.pending[0];
    assert.ok(deadline, "a deadline was armed");

    picture.fire("load");
    assert.equal(await waiting, picture.node);

    // Asserted against the *clock*, not against the promise.
    //
    // Re-reading the promise after firing the timer proves nothing: it has
    // already settled, so a later `resolve(undefined)` is ignored whether or
    // not the timer was ever cancelled. That version of this test passed with
    // `clearTimeout` deleted outright — a test named for dropping the deadline
    // that could not tell whether the deadline was dropped. An armed timer
    // that outlives its promise is a leak per quick look, and the only place
    // that is visible is the cancel itself.
    assert.ok(clock.cancelled.has(deadline.id), "the deadline was cancelled");
  } finally {
    clock.restore();
  }
});

test("a picture that fails settles as unreadable rather than hanging", async () => {
  const clock = fakeClock();
  try {
    const { readable } = await import("./overlay.ts");
    const picture = fakePicture();
    const waiting = readable(picture.node);

    picture.fire("error");
    assert.equal(await waiting, undefined);
  } finally {
    clock.restore();
  }
});

test("a picture already decoded needs no deadline at all", async () => {
  // The common case: a thumbnail the browse view has already fetched. Arming
  // a timer and waiting a microtask for it would delay every quick look.
  const clock = fakeClock();
  try {
    const { readable } = await import("./overlay.ts");
    const decoded = { complete: true, naturalWidth: 800 } as unknown as HTMLImageElement;

    assert.equal(await readable(decoded), decoded);
    assert.equal(clock.pending.length, 0, "no timer was armed");
  } finally {
    clock.restore();
  }
});
