// Every Tauri command must have a caller, or be declared as not having one.
//
// `knip` enforces "no dead code" across TypeScript and cannot see Rust, so a
// `#[tauri::command]` registered in `invoke_handler` with nothing invoking it
// passes every gate in this repo. That is not merely untidy: a registered
// command is *reachable from the webview* — the least-trusted process in the
// app — so an unreachable one is untested attack surface that ships enabled.
//
// This closes that hole from the other end: it reads the command list out of
// `commands.rs` and checks each name is invoked somewhere in `src/`.
//
// That list used to be inline in `lib.rs`'s builder, and this read it there.
// It moved so `src-tauri/tests/ipc.rs` could drive the *same* list rather than
// a second copy — and this gate failed on the next run, which is the correct
// behaviour for a file whose source of truth has been moved out from under it.
//
// Deliberately not a grep for `#[tauri::command]`: what matters is what is
// *registered*, since an annotated function nobody registers is unreachable
// and clippy already refuses it as dead.

import { globSync, readFileSync } from "node:fs";

import { codeOnly } from "./rust-source.mjs";

const LIB = "src-tauri/src/commands.rs";

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
  // Comments blanked first, through the same parser `check-dirs.mjs` uses.
  //
  // This split the block on `,` over the raw text, so a single `//` line inside
  // `generate_handler![…]` produced garbage entries *and swallowed the command
  // on the line below it* — that command then silently stopped being checked in
  // either direction. `commands.rs` already writes `//` comments immediately under
  // the block, so it was one edit away.
  const source = codeOnly(readFileSync(LIB, "utf8"));
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
 * `set_pinned`, `show_shelf`. A large share of call sites were invisible to the
 * check that exists to catch a renamed command — no figure here, for the reason
 * given above.
 *
 * Plugin commands are namespaced (`plugin:drag|start_drag`) and are not ours
 * to check.
 */
// All three quote styles.
//
// The pattern required a double quote, then a double or single one; a
// backtick-quoted call to a command Rust does not register stayed invisible,
// and that is the direction that fails at runtime. The pattern required a
// double quote, so a single-quoted call naming a command
// Rust does not have was not seen at all — the gate printed the same counts as a
// clean tree. Nothing in this repo enforces quote style, and the hole was
// one-directional: single-quoting a *real* call failed closed, which is exactly
// why it survived unnoticed.
const invoked = [...source.matchAll(/\binvoke\s*(?:<[^>]*>)?\s*\(\s*(["'`])([^"'`]+)\1/g)]
  .map((match) => match[2])
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

// Where an `invoke` may appear, so the boundary is a rule rather than a claim.
//
// `bridge.ts`'s header states one: "This is the shelf's calls, not the app's:
// `main.ts`, `popover.ts` and `settings.ts` invoke directly, because they are
// outside the shelf." The editor's header used to state a different one — "The
// window itself goes through `bridge.ts` like every other view module" — and
// `main.ts` imports from the bridge while also invoking directly, satisfying
// neither. Nothing decided which applied, so both could be true of a file and
// both could be false.
//
// The list is what decides now. It is short, every entry is a module that owns
// something outside the shelf, and adding one is a diff someone reads. The
// value of the rule is `bridge.ts`'s own argument for existing: a renamed
// command "fails at runtime in whichever corner happens to call it", and
// keeping the call sites countable is what makes that reviewable.
const INVOKERS = new Set([
  // The shelf's own calls, which is what this file is.
  "src/shelf/bridge.ts",
  // The window, the settings panel and the app's start-up — each owns a piece
  // of Rust the shelf does not.
  "src/popover.ts",
  "src/settings.ts",
  "src/main.ts",
  // The editor's own window. A second page in a second window cannot reach
  // the shelf's bridge — it has no shelf — so it owns one, exactly as the
  // settings window owns `src/settings.ts`. Three commands and a save, and
  // the point of naming it here rather than widening the rule is that the
  // list stays a list: a sixth entry has to be argued for in a diff too.
  "src/editor-window/bridge.ts",
]);

const strays = globSync("src/**/*.ts")
  .filter((file) => !file.endsWith(".test.ts"))
  .map((file) => file.replaceAll("\\", "/"))
  .filter((file) => !INVOKERS.has(file))
  .filter((file) => /\binvoke\s*[<(]/.test(stripComments(readFileSync(file, "utf8"))));

if (strays.length > 0) {
  console.error(
    "\nFiles calling `invoke` that are not on the list in " +
      `${import.meta.filename}:` +
      "\n" +
      strays.map((file) => `  ${file}`).join("\n") +
      "\n\nEvery call site is one more corner a renamed command can fail in. " +
      "Go through `src/shelf/bridge.ts`, or add the file above and say why.",
  );
}

if (
  unreachable.length > 0 ||
  staleExceptions.length > 0 ||
  unregistered.length > 0 ||
  strays.length > 0
) {
  process.exit(1);
}
console.info(
  `Checked ${registered.length} registered commands, ${new Set(invoked).size} invocations, ` +
    `and that only ${INVOKERS.size} files call \`invoke\`.`,
);
