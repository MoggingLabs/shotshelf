// Every type that goes over the wire has its field names written down.
//
// A struct's field names are as much of the IPC contract as the command names
// `check-commands.mjs` guards, and they were joined one struct at a time — by
// whichever review round happened to trip over that struct. `VideoDetails` and
// `Watching` each had a fixture of their own; `Capture`, which is the payload
// of the app's central event *and* the return type of `catch_backfill`, did
// not. Renaming `Capture::ts` and its six Rust readers left the whole gate
// green, and in the running app `captureId` becomes `"undefined:<path>"`,
// retention never evicts anything because `undefined < n` is false, day
// headings read Invalid Date, and `set_pinned` rejects every pin.
//
// Coverage that tracks bug history is not coverage. So this asks the crate
// which types serialise and requires each to be in the manifest: a new one
// arrives with its join or fails here. `capture-kinds.json` can no longer make
// a struct *look* joined when only its enum values are.
//
// The manifest is one end of a three-way check. `src-tauri/src/wire.rs` builds
// a sample of each type and compares the serialised keys; `src/wire.test.ts`
// does the same with a typed literal on the front end. Between the three there
// is no way to add a serialising type, or rename a field on either side, and be
// checked nowhere.

import { globSync, readFileSync } from "node:fs";

import { serialisingStructsIn } from "./rust-source.mjs";

const MANIFEST = "tests/fixtures/wire-fields.json";

const declared = Object.keys(JSON.parse(readFileSync(MANIFEST, "utf8")));

/**
 * Every struct in the crate that serialises to the webview.
 *
 * The discovery itself lives in `rust-source.mjs`, where a test can reach it:
 * this file runs its gate at import time, so nothing can import it to test a
 * function. Its rule matched `pub struct` alone for a round, and the widening
 * that fixed that shipped with nothing asserting it either — the same shape
 * twice over, which is what `rust-source.mjs` exists to end.
 */
const serialised = globSync("src-tauri/src/**/*.rs").flatMap((file) =>
  serialisingStructsIn(readFileSync(file, "utf8")),
);

const problems = [];

const unjoined = [...new Set(serialised)].filter((name) => !declared.includes(name));
if (unjoined.length > 0) {
  problems.push(
    `Types that serialise to the webview with no entry in ${MANIFEST}:\n` +
      unjoined.map((name) => `  ${name}`).join("\n") +
      "\n\nField names are the other half of the IPC contract. Add the type " +
      "there, and a sample to the tests on both sides that read it.",
  );
}

const gone = declared.filter((name) => !serialised.includes(name));
if (gone.length > 0) {
  problems.push(
    `Types in ${MANIFEST} that no longer serialise:\n` +
      gone.map((name) => `  ${name}`).join("\n") +
      "\n\nA fixture nothing produces is a contract with one side missing.",
  );
}

if (problems.length > 0) {
  console.error(`\n${problems.join("\n\n")}`);
  process.exit(1);
}

console.info(`Checked the wire fields of ${declared.length} serialised types.`);
