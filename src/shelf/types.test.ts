import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { SECRET_KINDS, canCompare } from "./types.ts";

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
