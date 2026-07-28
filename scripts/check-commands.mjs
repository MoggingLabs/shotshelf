// Every Tauri command must have a caller, or be declared as not having one.
//
// `knip` enforces "no dead code" across TypeScript and cannot see Rust, so a
// `#[tauri::command]` registered in `invoke_handler` with nothing invoking it
// passes every gate in this repo. That is not merely untidy: a registered
// command is *reachable from the webview* — the least-trusted process in the
// app — so an unreachable one is untested attack surface that ships enabled.
//
// This closes that hole from the other end: it reads the command list out of
// `lib.rs` and checks each name is invoked somewhere in `src/`.
//
// Deliberately not a grep for `#[tauri::command]`: what matters is what is
// *registered*, since an annotated function nobody registers is unreachable
// and clippy already refuses it as dead.

import { globSync, readFileSync } from "node:fs";

const LIB = "src-tauri/src/lib.rs";

/**
 * Commands that are knowingly registered without a caller.
 *
 * An escape hatch with a cost: every entry has to say why and what would
 * remove it, and it shows up in review as a diff rather than as silence. An
 * empty list is the goal.
 */
const UNWIRED = new Map();

function registeredCommands() {
  const source = readFileSync(LIB, "utf8");
  const block = /generate_handler!\[([\s\S]*?)\]/.exec(source);
  if (!block?.[1]) throw new Error(`no generate_handler! found in ${LIB}`);

  return block[1]
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => entry.split("::").pop())
    .filter((name) => name !== undefined);
}

/**
 * The front-end's real code, with comments and tests removed.
 *
 * Both exclusions are load-bearing, and both were missing. A comment naming a
 * command in quotes satisfied a plain substring scan, so the gate reported a
 * clean repo on a tree with no invocations at all. And a command mentioned
 * only by a unit test is still unreachable from the app, which is the property
 * being checked.
 */
function frontendSource() {
  return globSync("src/**/*.ts")
    .filter((file) => !file.endsWith(".test.ts"))
    .map((file) => stripComments(readFileSync(file, "utf8")))
    .join("\n");
}

/**
 * Remove block and line comments.
 *
 * Deliberately crude. It only has to be conservative in one direction: over-
 * stripping turns a real call site into a reported failure, which someone
 * investigates. Under-stripping is what let the gate pass on a comment.
 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const source = frontendSource();
const unreachable = [];
const staleExceptions = [];

for (const command of registeredCommands()) {
  // The command name appears as a string literal at the invoke site.
  const called = source.includes(`"${command}"`);
  if (called && UNWIRED.has(command)) staleExceptions.push(command);
  if (!called && !UNWIRED.has(command)) unreachable.push(command);
}

for (const [command, why] of UNWIRED) {
  if (!staleExceptions.includes(command)) {
    console.info(`  known unwired: ${command} — ${why}`);
  }
}

if (staleExceptions.length > 0) {
  console.error(
    `\nThese are wired now and should be removed from UNWIRED in ${import.meta.filename}:\n` +
      staleExceptions.map((command) => `  ${command}`).join("\n"),
  );
}

if (unreachable.length > 0) {
  console.error(
    "\nRegistered Tauri commands with no caller in src/:\n" +
      unreachable.map((command) => `  ${command}`).join("\n") +
      "\n\nA registered command is reachable from the webview. Either wire it " +
      "up, unregister it, or add it to UNWIRED with a reason.",
  );
}

if (unreachable.length > 0 || staleExceptions.length > 0) process.exit(1);
console.info(`Checked ${registeredCommands().length} registered commands.`);
