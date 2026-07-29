/**
 * The release command line.
 *
 * `scripts/build-release.mjs` decides what a signed build actually is: which
 * certificate is applied, and whether update artifacts are produced at all.
 * None of it had a test, because the obvious way to test it is to build an
 * installer — minutes of work, a Rust toolchain, real signing material, and
 * output nothing here can inspect.
 *
 * So none of it was tested, and a `--config` that never reached Tauri survived
 * nine review rounds. `npm run tauri build --config <json>` has npm parse
 * `--config` as one of *its own* configs: the flag is stripped and the JSON is
 * forwarded as a bare positional, which Tauri passes to `cargo`. The script
 * printed "signing with WINDOWS_CERT_THUMBPRINT" and produced an unsigned
 * build; with a signing key set it produced no `.sig` files, which are exactly
 * what the release workflow globs for.
 *
 * The wrong part was the argument list, and an argument list is cheap to
 * assert. `--dry-run` prints it and exits.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

interface DryRun {
  command: string;
  args: string[];
  notes: string[];
}

function plan(env: Record<string, string>): DryRun {
  const printed = execFileSync(
    process.execPath,
    ["scripts/build-release.mjs", "--dry-run", ...(env["ARGV_UNSIGNED"] ? ["--unsigned"] : [])],
    {
      encoding: "utf8",
      // A clean environment: the developer running the suite may well have
      // signing material set, and the plan must not depend on their machine.
      env: { ...cleared(), ...env },
    },
  );
  return JSON.parse(printed) as DryRun;
}

/**
 * The host's environment with every signing variable stripped.
 *
 * A developer running the suite may well have real signing material set, and
 * the plan under test must be a property of the code rather than of their
 * machine.
 *
 * Built by filtering rather than by deleting: the script treats an empty
 * string and an absent variable as the same thing, so leaving them out
 * entirely is exactly what "unset" means here.
 */
const SIGNING_VARS = new Set([
  "WINDOWS_CERT_THUMBPRINT",
  "APPLE_SIGNING_IDENTITY",
  "APPLE_ID",
  "APPLE_PASSWORD",
  "APPLE_TEAM_ID",
  "APPLE_API_KEY",
  "APPLE_API_ISSUER",
  "TAURI_SIGNING_PRIVATE_KEY",
]);

function cleared(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && !SIGNING_VARS.has(entry[0]),
    ),
  );
}

/** The `--config` payload, parsed, or undefined if the flag is not there. */
function override(run: DryRun): Record<string, unknown> | undefined {
  const at = run.args.indexOf("--config");
  if (at === -1) return undefined;
  const json = run.args[at + 1];
  assert.ok(json, "--config was passed with no value");
  return JSON.parse(json) as Record<string, unknown>;
}

test("the Tauri CLI is invoked directly, with no npm or shell in between", () => {
  const run = plan({});

  // Not `npm`: npm eats `--config`. Not a shell: cmd.exe re-parses the JSON,
  // which is nothing but quotes and braces.
  assert.equal(run.command, process.execPath);
  assert.match(run.args[0] ?? "", /tauri\.js$/);
  assert.equal(run.args[1], "build");
  assert.ok(!run.args.includes("tauri"), "`tauri` as an npm script name is gone");
});

test("an update-signing key turns on update artifacts, as one --config argument", () => {
  const run = plan({ TAURI_SIGNING_PRIVATE_KEY: "not-a-real-key" });

  const config = override(run);
  assert.ok(config, "--config must be passed when there is something to override");
  const bundle = config["bundle"] as Record<string, unknown>;
  assert.equal(bundle["createUpdaterArtifacts"], true);

  // One argument, not several. A JSON payload split by a shell arrives as
  // fragments Tauri rejects.
  const at = run.args.indexOf("--config");
  assert.equal(run.args.length, at + 2, "nothing follows the config payload");
});

test("no signing material means no --config at all, and it says so", () => {
  const run = plan({});

  assert.equal(override(run), undefined, "an empty override must not be sent");
  assert.ok(
    run.notes.some((note) => note.includes("no update artifacts")),
    `the plan should say updates are off: ${run.notes.join(" | ")}`,
  );
});

test("--unsigned drops signing material that is present in the environment", () => {
  // GitHub Actions passes an unset secret as an empty string, and Tauri reads
  // "present but empty" as "sign with this". `--unsigned` has to beat a real
  // value too, not just an empty one.
  const run = plan({ TAURI_SIGNING_PRIVATE_KEY: "not-a-real-key", ARGV_UNSIGNED: "1" });

  assert.equal(override(run), undefined, "nothing is overridden for an unsigned build");
  assert.ok(run.notes.some((note) => note.includes("skipping all signing")));
});
