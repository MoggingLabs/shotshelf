import assert from "node:assert/strict";
import { test } from "node:test";

import { until, type Wait } from "./retry.ts";

/**
 * The loop two modules used to keep their own copy of.
 *
 * `retry.ts` exists because `main.ts` and `settings.ts` each grew a wait loop,
 * and the two drifted: one retried only a specific transient message and one
 * retried permanent failures too, one slept after its final attempt and one did
 * not. The module's docstring names all three of those as fixed — and nothing
 * executed any of them. The e2e suite reaches this code through the catch-engine
 * wait, but it asserts on what ends up on screen, and every defect above is
 * invisible there: an extra sleep after the last attempt changes no rendered
 * state, and re-asking a permanent failure only makes the same error arrive
 * later.
 *
 * So: the budget is honoured, permanent errors stop the loop, and the sleeps are
 * counted rather than timed. Counting is the part that matters — a wall-clock
 * assertion on a 500 ms budget is a flake on a loaded runner, and it would not
 * distinguish "slept once too often" from "the runner stalled".
 */

/** Replace the global timer so a sleep is recorded and resolves at once. */
function countingSleeps<T>(run: () => Promise<T>): { sleeps: () => number; done: Promise<T> } {
  const real = globalThis.setTimeout;
  let count = 0;
  // The signature `until` uses: a callback and a delay, nothing else.
  globalThis.setTimeout = ((resume: () => void) => {
    count += 1;
    return real(resume, 0);
  }) as typeof globalThis.setTimeout;

  const done = run().finally(() => {
    globalThis.setTimeout = real;
  });
  return { sleeps: () => count, done };
}

/** A budget that treats everything as worth asking again about. */
const patient = (attempts: number): Wait => ({
  attempts,
  everyMs: 500,
  transient: () => true,
});

void test("a call that works first time is not retried and is not slept on", async () => {
  let asked = 0;
  const { sleeps, done } = countingSleeps(() =>
    until(() => {
      asked += 1;
      return Promise.resolve("ready");
    }, patient(5)),
  );

  assert.equal(await done, "ready");
  assert.equal(asked, 1);
  assert.equal(sleeps(), 0);
});

void test("a transient failure is asked again until it succeeds", async () => {
  let asked = 0;
  const { sleeps, done } = countingSleeps(() =>
    until(() => {
      asked += 1;
      return asked < 3 ? Promise.reject(new Error("still starting")) : Promise.resolve("up");
    }, patient(5)),
  );

  assert.equal(await done, "up");
  assert.equal(asked, 3);
  // Two failures, two sleeps — never one after the answer arrived.
  assert.equal(sleeps(), 2);
});

void test("the budget is a number of attempts, and the last one is not slept after", async () => {
  // The specific defect the module docstring claims to have fixed: a loop that
  // sleeps after its final attempt makes every caller wait one full interval
  // longer than its budget says, for nothing. With three attempts there are two
  // gaps between them, so three sleeps means the code slept into a wall.
  let asked = 0;
  const { sleeps, done } = countingSleeps(() =>
    until(() => {
      asked += 1;
      return Promise.reject(new Error("never ready"));
    }, patient(3)),
  );

  await assert.rejects(done, /never ready/);
  assert.equal(asked, 3, "the budget is attempts, including the first");
  assert.equal(sleeps(), 2, "slept after the final attempt");
});

void test("a permanent failure stops the loop rather than waiting out the budget", async () => {
  // `transient` is required for exactly this: re-asking a permanent failure
  // turns a clear error into a long wait and then the same error.
  let asked = 0;
  const wait: Wait = {
    attempts: 100,
    everyMs: 500,
    transient: (error) => String(error).includes("still starting"),
  };

  const { sleeps, done } = countingSleeps(() =>
    until(() => {
      asked += 1;
      return Promise.reject(new Error("the engine is gone"));
    }, wait),
  );

  await assert.rejects(done, /the engine is gone/);
  assert.equal(asked, 1);
  assert.equal(sleeps(), 0);
});

void test("the error a caller sees is the last real one, not a wrapper", async () => {
  // `main.ts` and `settings.ts` both report the failure to the user, so a
  // wrapper here would replace a sentence someone can act on with one nobody
  // wrote.
  const errors = [new Error("first"), new Error("second"), new Error("third")];
  let asked = 0;

  const { done } = countingSleeps(() =>
    until(() => {
      // `?? throw` rather than a non-null assertion: if the loop ever asked a
      // fourth time this should say so, not hand back `undefined` and fail
      // somewhere further along.
      const next = errors[asked++] ?? new Error("asked more times than the budget allows");
      return Promise.reject(next);
    }, patient(3)),
  );

  await assert.rejects(done, (thrown: unknown) => {
    assert.equal(thrown, errors[2], "a caller was handed the wrong attempt's error");
    return true;
  });
});

/**
 * A promise-like that rejects with something that is not an `Error`.
 *
 * Written as a thenable rather than `Promise.reject("…")` because
 * `prefer-promise-reject-errors` forbids that spelling — rightly, and this
 * repository has no `eslint-disable` anywhere, which is a property worth more
 * than the two lines it would save here. A thenable is also closer to the truth:
 * the non-`Error` rejection this covers arrives from Tauri's `invoke` across the
 * IPC boundary, not from anything in this codebase calling `reject` by hand.
 */
function rejectsWith(reason: string): () => Promise<never> {
  return () =>
    ({
      then: (_resolve: unknown, fail: (value: unknown) => void) => {
        fail(reason);
      },
    }) as PromiseLike<never> as Promise<never>;
}

void test("a rejection that is not an Error still arrives as one", async () => {
  // `until` is typed to throw `Error`, and Rust's `invoke` rejects with a plain
  // string — so without the conversion the declared type is a lie at the one
  // boundary it exists for.
  const { done } = countingSleeps(() => until(rejectsWith("a bare string"), patient(1)));

  await assert.rejects(done, (thrown: unknown) => {
    assert.ok(thrown instanceof Error);
    assert.match(thrown.message, /a bare string/);
    return true;
  });
});
