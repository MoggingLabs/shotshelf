/**
 * The front-end half of the `Watching` join.
 *
 * `catch_watch_dirs` is the one command whose answer decides what the live dot
 * and the alert strip say, and the two halves of its payload were two hand-typed
 * lists of names with nothing between them: Rust's `Watching` with its
 * `rename_all`, and an inline `invoke<{ dirs; clipboard }>` in `main.ts`.
 * Renaming either side compiles, keeps all of `cargo test` green, and lands
 * `undefined` in the front end — which is falsy, so the shelf reports
 * "Clipboard captures are not being picked up" on a healthy launch, on the
 * indicator `docs/USAGE.md` sends the user to first when nothing appears.
 *
 * Same shape as `src/shelf/types.test.ts`'s joins: the fixture is the shared
 * statement, and `src-tauri/src/catch/mod.rs` asserts the other half against the
 * same file.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import type { WatchState } from "./status.ts";

test("the watch-state fields match the ones Rust sends", () => {
  // Sorted, because Rust's half reads the keys back out of a `BTreeMap` and so
  // sees them alphabetically. What is being joined is the set of names.
  const shared = JSON.parse(
    readFileSync("tests/fixtures/watch-state-fields.json", "utf8"),
  ) as string[];

  // A value that must type-check as a `WatchState`, so renaming the field in
  // `status.ts` fails to compile against this literal as well as failing the
  // comparison below.
  const sample: WatchState = { dirs: [], clipboard: false };

  assert.deepEqual(
    Object.keys(sample).sort(),
    [...shared].sort(),
    "front-end fields have drifted from the fixture",
  );
});
