// Nothing may reach for the roaming profile.
//
// On Windows `app_data_dir()` is `%APPDATA%` — the roaming profile, which a
// domain roaming profile or Enterprise State Roaming copies to a network share
// at logoff. Shotshelf's central promise is that nothing a capture touches
// leaves the machine, and a capture's *path* carries client and project names
// as readily as a window title does. So pins, the log, saved edits and
// clipboard captures all belong under `app_local_data_dir()`.
//
// That rule was written out in four modules, each pointing at the others, and
// held only by four people remembering four docstrings. `src-tauri/src/dirs.rs`
// now states it once — and this is what keeps it stated once.
//
// Why a script *as well as* clippy, and not instead of it.
//
// An earlier version of this comment said `disallowed_methods` "needs a
// nightly-ish lint config". That is wrong — it works on stable with a
// `clippy.toml`, and `clippy.toml` now carries these four functions. Clippy
// matches resolved paths, so it is strictly stronger than substring matching
// on how a call is *spelled*: it sees UFCS and aliasing that this cannot.
//
// What clippy cannot see is `BaseDirectory::AppData`, which reaches the same
// root through an enum rather than a call — so that is what this adds, along
// with a message that says which root and why. Two gates, each covering the
// other's blind spot, and the reason written down rather than guessed at.

import { globSync, readFileSync } from "node:fs";

/** The module allowed to resolve a root, because it is the one that documents why. */
const OWNER = "src-tauri/src/dirs.rs";

/**
 * Every way to resolve a root, all of them owned.
 *
 * Not a blocklist of one name. `app_config_dir` and `app_data_dir` resolve to
 * **the same directory** on Windows — `dirs` maps both to
 * `known_folder_roaming_app_data` — so forbidding one spelling and ignoring the
 * other reported success on a tree that was already calling the other. The rule
 * is about *which root*, so every function that names one is here.
 */
const OWNED = ["app_data_dir", "app_config_dir", "app_local_data_dir", "app_cache_dir"];

/**
 * The other way in: `path().resolve(…, BaseDirectory::AppData)`.
 *
 * `BaseDirectory` dispatches to exactly these functions, so a module can reach
 * the roaming profile without naming it. Substring matching cannot see that,
 * which is the honest limit of this script and the reason `clippy.toml` also
 * refuses the calls by resolved path.
 */
const BASE_DIRECTORY = "BaseDirectory::";

const problems = [];

for (const file of globSync("src-tauri/src/**/*.rs")) {
  const normalised = file.replaceAll("\\", "/");
  const source = readFileSync(file, "utf8");

  if (normalised === OWNER) continue;

  // A method call, `.app_data_dir(`, not the bare name. Prose mentions these —
  // `dirs.rs`'s header explains why the roaming ones are what they are — and a
  // check that fires on its own documentation is a check that gets suppressed.
  // This one caught `dirs.rs` on its first run for exactly that.
  for (const owned of OWNED) {
    if (source.includes(`.${owned}(`)) {
      problems.push(
        `  ${normalised}: resolves \`${owned}()\` itself. ` +
          `Go through \`dirs::preferences\`, \`dirs::local\` or \`dirs::cache\` — ` +
          `that module is where the roaming-vs-local rule is stated.`,
      );
    }
  }

  if (source.includes(BASE_DIRECTORY)) {
    problems.push(
      `  ${normalised}: uses \`${BASE_DIRECTORY}…\`, which resolves a root ` +
        `without naming it. Go through \`dirs\`.`,
    );
  }
}

if (problems.length > 0) {
  console.error(
    "\nDirectory roots resolved outside the module that owns the rule:\n" +
      problems.join("\n") +
      "\n\nSee `src-tauri/src/dirs.rs`.",
  );
  process.exit(1);
}

console.info(`Checked that only ${OWNER} resolves a data root.`);
