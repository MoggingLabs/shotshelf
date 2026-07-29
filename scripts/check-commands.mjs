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
// Empty, and every line that reads it is therefore unreachable today. That
// is the intended state and not an oversight: the alternative to a hatch
// that is currently unused is a hatch added under time pressure, which is
// how a gate stops biting. It stays because an exception here is a diff in
// review, and a suppression added in a hurry is not.
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
const registered = registeredCommands();

/**
 * The other direction: an `invoke("…")` naming a command Rust does not expose.
 *
 * The reachability half was written to close a security hole and inherited its
 * single direction — but `bridge.ts` justifies its own existence by saying a
 * renamed command "fails at runtime in whichever corner happens to call it",
 * and that is precisely this direction. The harness hard-codes stub names, so
 * an e2e suite stays green against commands that no longer exist.
 *
 * The type parameter is optional in the pattern, and that is the whole point.
 *
 * No count is quoted here on purpose. This file and `src/shelf/commands.test.ts`
 * each carried a tally of how many call sites the old regex missed; they
 * disagreed with each other and both had drifted from the tree.
 * `src-tauri/src/webview_path.rs` states the rule they broke — a criterion is
 * checkable, a tally is just a fact that goes stale. This gate prints the live
 * numbers on every run.
 * Requiring it — `invoke<T>(` — silently skipped every call whose result is
 * discarded, which is most of the ones that only ever fail: `hide_shelf`,
 * `set_pinned`, `show_shelf`. Six of sixteen call sites were invisible to the
 * check that exists to catch a renamed command.
 *
 * Plugin commands are namespaced (`plugin:drag|start_drag`) and are not ours
 * to check.
 */
const invoked = [...source.matchAll(/\binvoke\s*(?:<[^>]*>)?\s*\(\s*"([^"]+)"/g)]
  .map((match) => match[1])
  .filter((name) => name !== undefined && !name.includes(":"));

const unreachable = [];
const staleExceptions = [];

for (const command of registered) {
  // Asked of the *invocation set* below, not of the raw text.
  //
  // This used to be `source.includes(`"${command}"`)` — any double-quoted
  // occurrence anywhere in `src/`, so a command name surviving only as an
  // object key or an event string kept the gate green. The precise set is
  // built a few lines down for the other direction; the half that exists to
  // close an attack-surface hole was using the looser copy.
  const called = invoked.includes(command);
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

const unregistered = [...new Set(invoked)].filter((name) => !registered.includes(name));

if (unregistered.length > 0) {
  console.error(
    "\nCommands invoked from src/ that Rust does not register:\n" +
      unregistered.map((command) => `  ${command}`).join("\n") +
      "\n\nThese fail at runtime, in whichever corner happens to call them.",
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

if (unreachable.length > 0 || staleExceptions.length > 0 || unregistered.length > 0) {
  process.exit(1);
}
console.info(
  `Checked ${registered.length} registered commands, and ${new Set(invoked).size} invocations.`,
);
