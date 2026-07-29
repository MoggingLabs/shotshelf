import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import type { VideoDetails } from "./types.ts";
import { CAPTURE_KINDS, SECRET_KINDS, canCompare, isEditable, canPreview } from "./types.ts";

/**
 * The other half of a cross-language check.
 *
 * `SecretKind` is declared in Rust, here, in `styles.css` as selectors, and as
 * strings in the e2e specs. Nothing joined them, so renaming a variant in Rust
 * compiled on both sides, silently stopped matching a CSS rule, and rendered a
 * credential warning in the wrong colour with every gate green.
 *
 * Both sides now assert against `tests/fixtures/secret-kinds.json`.
 */
test("the secret kinds match the ones Rust sends", () => {
  const shared: unknown = JSON.parse(readFileSync("tests/fixtures/secret-kinds.json", "utf8"));
  assert.deepEqual([...SECRET_KINDS], shared, "front-end kinds have drifted from the fixture");
});

/**
 * The other half of the `CaptureKind` join.
 *
 * The kind crosses in both directions — outbound on `capture://new` and
 * `catch_backfill`, inbound as an argument to `copy_capture` and `prepare_drag`,
 * and persisted in `pinned.json` — and until now a single
 * `#[serde(rename_all = …)]` in Rust was the only thing making the two spellings
 * agree. Changing that attribute compiled, passed clippy and passed all 135 Rust
 * tests, while in the real app every capture arrived with a `kind` this union
 * does not admit and every drag-out and copy was rejected on the way back.
 *
 * No browser spec can see it either: `tauri-mock.ts` replaces
 * `__TAURI_INTERNALS__` wholesale, so nothing here ever runs a real command.
 * The fixture is the join, exactly as it is for the secret kinds above.
 */
test("the capture kinds match the ones Rust puts on the wire", () => {
  const shared: unknown = JSON.parse(readFileSync("tests/fixtures/capture-kinds.json", "utf8"));
  assert.deepEqual([...CAPTURE_KINDS], shared, "front-end kinds have drifted from the fixture");
});

/**
 * The other half of the `VideoDetails` join.
 *
 * Written as a value that must type-check as a `VideoDetails`, so renaming the
 * field here fails to compile against this literal *and* fails the comparison —
 * and renaming it in Rust, where a single `rename_all` supplies the camel case,
 * fails the sibling test in `poster.rs`.
 */
test("the video detail fields match the ones Rust sends", () => {
  // Sorted, because Rust's half reads the keys back out of a `BTreeMap` and so
  // sees them alphabetically. What is being joined is the set of names.
  const shared = JSON.parse(
    readFileSync("tests/fixtures/video-detail-fields.json", "utf8"),
  ) as string[];
  const sample: VideoDetails = { poster: null, durationMs: null, bytes: 0 };
  assert.deepEqual(
    Object.keys(sample).sort(),
    [...shared].sort(),
    "front-end fields have drifted from the fixture",
  );
});

test("comparison is offered for two images and nothing else", () => {
  // Compare was never one of the sites this rule was extracted to unify: the
  // button keyed on the count alone, so two picked recordings offered it,
  // `compare_captures` handed an `.mp4` to the image decoder, and the user was
  // told the two captures could not be compared — for doing what the button
  // invited.
  const image = { kind: "image" } as const;
  const video = { kind: "video" } as const;

  assert.equal(canCompare([image, image]), true);
  assert.equal(canCompare([image, video]), false, "one recording is enough to refuse");
  assert.equal(canCompare([video, video]), false);
  assert.equal(canCompare([image]), false, "one capture is not a comparison");
  assert.equal(canCompare([image, image, image]), false);
  assert.equal(canCompare([]), false);
});

test("editing and previewing are offered for images and refused for recordings", () => {
  // Neither had a test: `canCompare` was covered and these two were not, so a
  // third capture kind could have been missed in whichever copy of the rule the
  // change forgot — which is the hazard `isEditable`'s docstring names.
  const image = { kind: "image" } as const;
  const video = { kind: "video" } as const;

  assert.equal(isEditable(image), true);
  assert.equal(isEditable(video), false);
  assert.equal(canPreview(image), true);
  assert.equal(canPreview(video), false);
});
