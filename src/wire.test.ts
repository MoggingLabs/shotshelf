/**
 * The front-end half of every wire-field join, in one place.
 *
 * A struct's field names are as much of the IPC contract as the command names
 * are, and they were joined a type at a time — by whichever review round
 * happened to trip over that type. `VideoDetails` and `Watching` each had a
 * fixture; `Capture`, which is the payload of `capture://new` *and* the return
 * of `catch_backfill`, did not. Renaming `Capture::ts` in Rust with its six
 * readers left every gate in the repo green, and in the running app
 * `captureId` becomes `"undefined:<path>"`, `ShelfStore.sweep`'s
 * `item.ts < cutoff` is `undefined < n` so retention never evicts anything,
 * `dayKey` yields Invalid Date headings, and `set_pinned` rejects every pin.
 *
 * Coverage that tracks bug history is not coverage. So the manifest covers
 * every serialising type, `scripts/check-wire.mjs` asks the crate which those
 * are rather than trusting the manifest to be complete, and
 * `src-tauri/src/wire.rs` asserts the Rust half against the same file.
 *
 * Each sample below is annotated with its real type, and the two halves of that
 * catch different edits. Renaming a field in the interface alone stops the
 * literal type-checking, so `npm run build` goes red and this file does not —
 * `Object.keys` reads the literal, so on its own it would be comparing the
 * fixture to itself. Renaming the field in *both* compiles, and then the
 * comparison below is what fails. Renaming it in Rust fails the sibling test
 * there. It takes all three to leave no edit unchecked, which is why this says
 * so rather than claiming the runtime assertion covers everything.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import type { PinnedItem, Settings } from "./settings.ts";
import type { WatchState } from "./status.ts";
import type {
  Capture,
  CaptureContext,
  DragSource,
  Findings,
  SecretFinding,
  VideoDetails,
} from "./shelf/types.ts";

/** What the local-state file holds. Rust's `LocalState`; nothing types it here. */
interface LocalState {
  pinned: PinnedItem[];
  lastCaptureMs: number;
}

/**
 * `catch_watch_dirs`'s answer is `WatchState`, imported rather than restated.
 *
 * It was re-declared here, which made three hand-typed copies of `Watching` on
 * the front end under a `status.ts` docstring saying the names "have one home".
 * A join that keeps its own second copy of the thing it joins is checking the
 * fixture against itself.
 */

const capture: Capture = { path: "", kind: "image", ts: 0, context: { label: "" } };
const context: CaptureContext = { label: "" };
const dragSource: DragSource = { path: "", icon: "" };
const finding: SecretFinding = { kind: "privateKey", label: "", preview: "", severity: 0 };
const findings: Findings = { secrets: [], scanned: false };
const localState: LocalState = { pinned: [], lastCaptureMs: 0 };
const pinnedItem: PinnedItem = { path: "", kind: "image", ts: 0 };
const settings: Settings = {
  retentionHours: null,
  maxItems: 0,
  hotkey: "",
  downscaleExports: false,
  checkForUpdates: false,
  dockCorner: "bottom-right",
  dockMonitor: "primary",
  startAtLogin: false,
  theme: "system",
  watchAdded: [],
  watchRemoved: [],
  clipboardKeepDays: null,
  browseWidth: null,
  browseHeight: null,
  pinned: [],
};
const videoDetails: VideoDetails = { poster: null, durationMs: null, bytes: 0 };
const watching: WatchState = { dirs: [], clipboard: false };

const SAMPLES: Record<string, object> = {
  Capture: capture,
  Context: context,
  DragSource: dragSource,
  Finding: finding,
  Findings: findings,
  LocalState: localState,
  PinnedItem: pinnedItem,
  Settings: settings,
  VideoDetails: videoDetails,
  Watching: watching,
};

test("every wire type's fields match the ones Rust sends", () => {
  const shared = JSON.parse(readFileSync("tests/fixtures/wire-fields.json", "utf8")) as Record<
    string,
    string[]
  >;

  // The manifest and the samples cover the same types, so a type cannot be
  // added to one and silently skipped by the comparison below — which is the
  // shape of the gap this file exists to close.
  assert.deepEqual(
    Object.keys(SAMPLES).sort(),
    Object.keys(shared).sort(),
    "tests/fixtures/wire-fields.json and the samples here name different types",
  );

  for (const [what, sample] of Object.entries(SAMPLES)) {
    // Sorted, because Rust's half reads the keys back out of a `BTreeMap` and
    // so sees them alphabetically. What is being joined is the set of names.
    assert.deepEqual(
      Object.keys(sample).sort(),
      [...(shared[what] ?? [])].sort(),
      `${what}'s front-end fields have drifted from the fixture`,
    );
  }
});
