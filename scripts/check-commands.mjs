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

import { readFileSync } from "node:fs";
import { globSync } from "node:fs";

const LIB = "src-tauri/src/lib.rs";

/**
 * Commands that are knowingly registered without a caller.
 *
 * An escape hatch with a cost: every entry has to say why and what would
 * remove it, and it shows up in review as a diff rather than as silence. An
 * empty list is the goal.
 */
const UNWIRED = new Map([
  [
    "redact_capture",
    "Needs the annotation editor to choose a region; the backend and its " +
      "tests are complete. Remove this entry when the editor lands.",
  ],
]);

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

function frontendSource() {
  return globSync("src/**/*.ts")
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");
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
