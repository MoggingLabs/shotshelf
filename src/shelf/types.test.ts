import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { SECRET_KINDS } from "./types.ts";

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
