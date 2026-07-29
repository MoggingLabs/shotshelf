import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

/**
 * The gate that enforces "no dead Rust" is itself a gate.
 *
 * It was fooled once: the caller check was a substring scan over every file in
 * `src/`, so a comment naming a command in quotes satisfied it, and the script
 * reported a clean repo with zero invocations. A gate that silently stops
 * biting reports success identically to a clean tree — so it needs its own
 * evidence that it still fails when it should.
 */

const SCRIPT = path.resolve("scripts/check-commands.mjs");

/** Run the checker against a throwaway tree and report whether it passed. */
function check(files: Record<string, string>): { ok: boolean; output: string } {
  const root = mkdtempSync(path.join(tmpdir(), "shotshelf-commands-"));
  try {
    for (const [relative, contents] of Object.entries(files)) {
      const target = path.join(root, relative);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, contents, "utf8");
    }
    try {
      const output = execFileSync(process.execPath, [SCRIPT], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { ok: true, output };
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string };
      return { ok: false, output: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const LIB = `
tauri::Builder::default()
  .invoke_handler(tauri::generate_handler![
    thing::wired_command,
    thing::orphan_command,
  ])
`;

test("a command with a real caller passes", () => {
  const result = check({
    "src-tauri/src/lib.rs": LIB.replace("thing::orphan_command,\n", ""),
    "src/app.ts": `invoke("wired_command", {});`,
  });
  assert.ok(result.ok, result.output);
});

test("a command with no caller fails", () => {
  const result = check({
    "src-tauri/src/lib.rs": LIB,
    "src/app.ts": `invoke("wired_command", {});`,
  });
  assert.equal(result.ok, false, "an unreachable command must fail the gate");
  assert.match(result.output, /orphan_command/);
});

test("a comment naming a command does not count as calling it", () => {
  // This is the hole the gate shipped with: a plain substring scan over the
  // file passed on a repo where nothing invoked anything.
  const result = check({
    "src-tauri/src/lib.rs": LIB,
    "src/app.ts": `// "wired_command" and "orphan_command" are handled elsewhere\n`,
  });
  assert.equal(result.ok, false, "a comment is not a call site");
});

test("a test naming a command does not count as calling it", () => {
  // A command reachable only from a unit test is still unreachable from the
  // app, which is the property being checked.
  const result = check({
    "src-tauri/src/lib.rs": LIB,
    "src/app.ts": `invoke("wired_command", {});`,
    // An `invoke(…)`, which is the only shape the scanner sees.
    //
    // This was a `respond(…)` call, which matches the invocation pattern
    // nowhere — so the contents of the test fixture were invisible whether or
    // not the spec-file exclusion existed, and the assertion held either way.
    // The exclusion this test is named for was cancelled by its own fixture,
    // the same shape as a roaming fixture with no pins in it.
    "src/app.test.ts": `invoke("orphan_command", {});`,
  });
  assert.equal(result.ok, false, "a test is not the app");
});

// ── The other direction: invoked, but not registered ──────────────────────
//
// Added late and with a regex that required a type parameter, so it only saw
// `invoke<T>(...)` and was blind to every call site whose result is discarded —
// `hide_shelf`, `set_pinned`, `show_shelf` among them. The gate printed a
// registered count far above its invocation count and nobody read that as the
// admission it was. These are the cases that hole would have passed.
//
// The figures that used to be quoted here are gone: this file and
// `scripts/check-commands.mjs` each carried one, they disagreed, and both were
// stale. The gate prints the live numbers.

test("a command invoked but never registered fails", () => {
  const result = check({
    "src-tauri/src/lib.rs": LIB.replace("thing::orphan_command,\n", ""),
    "src/app.ts": `invoke("wired_command", {});\ninvoke("never_existed", {});`,
  });
  assert.equal(result.ok, false, "a renamed command must fail the gate");
  assert.match(result.output, /never_existed/);
});

test("an untyped invoke is seen in both directions", () => {
  // The exact shape the regex used to skip: no type parameter, because the
  // caller ignores the result. Every command that can only fail looks like
  // this, which made the blind spot precisely the risky half.
  const result = check({
    "src-tauri/src/lib.rs": LIB.replace("thing::orphan_command,\n", ""),
    "src/app.ts": `void invoke("wired_command", {});\nawait invoke("gone_missing");`,
  });
  assert.equal(result.ok, false, "an untyped invoke of a missing command must fail");
  assert.match(result.output, /gone_missing/);
});

test("a plugin command is not ours to check", () => {
  // Namespaced commands belong to the plugin that registered them.
  const result = check({
    "src-tauri/src/lib.rs": LIB.replace("thing::orphan_command,\n", ""),
    "src/app.ts": `invoke("wired_command", {});\ninvoke("plugin:drag|start_drag", {});`,
  });
  assert.ok(result.ok, result.output);
});
