import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { DEFAULTS } from "./settings.ts";

/**
 * The other half of a cross-language check.
 *
 * The settings shape is declared twice — `Settings` here and `Settings` in
 * `src-tauri/src/settings.rs` — because the shelf needs limits from its first
 * frame, before `get_settings` resolves, and a capture can land in that window.
 * Two declarations of one thing drift, and these two already did:
 * `downscaleExports` shipped typed only in Rust and went unnoticed because the
 * settings payload is spread from the raw response rather than rebuilt from
 * this interface.
 *
 * Both sides assert against `tests/fixtures/default-settings.json`, so a field
 * added to one and forgotten in the other fails on whichever side forgot.
 */
test("the front-end defaults match the ones Rust starts on", () => {
  const shared: unknown = JSON.parse(
    readFileSync("tests/fixtures/default-settings.json", "utf8"),
  );

  assert.deepEqual(
    JSON.parse(JSON.stringify(DEFAULTS)),
    shared,
    "front-end defaults have drifted from the shared fixture",
  );
});
