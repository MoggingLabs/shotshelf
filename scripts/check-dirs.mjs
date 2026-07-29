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
// Why a script and not clippy: `disallowed-methods` needs a `clippy.toml` and
// a nightly-ish lint config, and it would still not see the *reason*. This
// checks the one thing that matters — that the call appears in no module but
// the one that owns the decision — the same way `check-commands.mjs` enforces
// a rule about `lib.rs` that clippy cannot see.

import { globSync, readFileSync } from "node:fs";

/** The module allowed to resolve a root, because it is the one that documents why. */
const OWNER = "src-tauri/src/dirs.rs";

/** Roaming. Never correct in this app. */
const FORBIDDEN = "app_data_dir";
/** Local, and correct — but only from the owner, so the rule stays in one place. */
const OWNED = ["app_local_data_dir", "app_cache_dir"];

const problems = [];

for (const file of globSync("src-tauri/src/**/*.rs")) {
  const normalised = file.replaceAll("\\", "/");
  const source = readFileSync(file, "utf8");

  // A method call, `.app_data_dir(`, not the bare name. Prose mentions these
  // by name — `dirs.rs`'s own header explains why the roaming one is wrong —
  // and a check that fires on its own documentation is a check that gets
  // suppressed. This one caught `dirs.rs` on the first run for exactly that.
  if (source.includes(`.${FORBIDDEN}(`)) {
    problems.push(
      `  ${normalised}: calls \`${FORBIDDEN}()\` — that is the **roaming** profile. ` +
        `Captures and anything naming one must not go there; use \`dirs::local\`.`,
    );
  }

  if (normalised === OWNER) continue;
  for (const owned of OWNED) {
    if (source.includes(`.${owned}(`)) {
      problems.push(
        `  ${normalised}: resolves \`${owned}()\` itself. ` +
          `Go through \`dirs::local\` or \`dirs::cache\`, which is where the ` +
          `roaming-vs-local rule is stated.`,
      );
    }
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
