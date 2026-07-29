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
 * The bare name, not `BaseDirectory::`. One import alias defeated the longer
 * form — `use tauri::path::BaseDirectory as Roaming;` and then `Roaming::AppData`
 * — which a reviewer demonstrated reaching the roaming profile with this script
 * reporting success. Matching the name catches the import; `clippy.toml` now
 * also lists the type, which resolves through the alias and is the stronger of
 * the two.
 */
const BASE_DIRECTORY = "BaseDirectory";

/**
 * Who may write into the roaming profile.
 *
 * `dirs.rs` states the rule in bold — "Nothing that names a capture may be
 * written here" — and until now nothing enforced it. `dirs::preferences` is
 * `pub`, so any module could call the correct helper for the wrong data and
 * both this script and `clippy.toml` would report success: they check that a
 * root is resolved *through* `dirs`, not that the right root was chosen.
 *
 * One caller is what makes the rule checkable. `settings.rs` writes exactly one
 * file there and blanks `pinned` before serialising it, which a test pins. A
 * second caller is not necessarily wrong, but it is a decision that has to be
 * argued for rather than made by autocomplete — which is what a failing gate
 * turns it into.
 */
const ROAMING = "dirs::preferences";
const ROAMING_CALLER = "src-tauri/src/settings.rs";

/**
 * The modules whose asset-protocol grants are whole folders on purpose.
 *
 * `src-tauri/src/catch/mod.rs` grants the watch list and the clipboard folder, whose
 * contents are captures by definition; `src-tauri/src/poster.rs` and `src-tauri/src/edit.rs` grant caches
 * Shotshelf itself writes. Anything else wanting the webview to read a file
 * should name that file.
 */
const DIRECTORY_GRANTERS = new Set([
  "src-tauri/src/catch/mod.rs",
  "src-tauri/src/poster.rs",
  "src-tauri/src/edit.rs",
]);

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

  // A directory grant is a decision; a file grant is not.
  //
  // `allow_directory(p, false)` opens `p` *and* `p/*` to the webview — OCR and
  // credential scanning, clipboard, drag payloads, `convertFileSrc`. That is
  // correct for the folders the engine watches, whose contents are captures by
  // definition, and it was briefly used for the parent of every **pinned**
  // capture. `pinned.json` is hand-editable and two commands let the webview
  // write it, so one edited path opened a whole directory for the session —
  // `Scope` only ever adds. The fix was `allow_file`, and this keeps it that
  // way by holding `allow_directory` to the modules whose grants are folders
  // by design — the set below, no count here.
  //
  // Two limits, both real, and `clippy.toml` now carries this rule as a
  // `disallowed-methods` entry because of the second one.
  //
  // First: this matches the *spelling* `.allow_directory(`, so
  // `tauri::scope::fs::Scope::allow_directory(&scope, …)` walks past it — a
  // reviewer did exactly that, and it is the third spelling-matched rule in
  // this file to be bypassed that way. Clippy resolves the path instead, and
  // the three legitimate granters carry a named `#[allow]` at the call.
  //
  // Second: the exemption here is per *file*, which is the reason
  // `webview_path::allow_reading_pinned` lives where it does: while that
  // function sat in `src-tauri/src/catch/mod.rs`, which is exempt for
  // `allow_reading_captures`, this check could not see it and the escalation
  // re-landed with every gate green. A reviewer proved exactly that. A module
  // wanting a directory grant now has to join the set, in a diff.
  if (source.includes(".allow_directory(") && !DIRECTORY_GRANTERS.has(normalised)) {
    problems.push(
      `  ${normalised}: calls \`allow_directory\`, which opens every file beside ` +
        `the one named. Only ${[...DIRECTORY_GRANTERS].join(", ")} may — everything ` +
        `else grants \`allow_file\`, by name.`,
    );
  }

  if (normalised !== ROAMING_CALLER && source.includes(ROAMING)) {
    problems.push(
      `  ${normalised}: calls \`${ROAMING}\`, which is the **roaming** profile. ` +
        `Only \`${ROAMING_CALLER}\` may, and only for settings — nothing naming ` +
        `a capture goes there. Use \`dirs::local\`.`,
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

console.info(
  `Checked that only ${OWNER} resolves a data root, ` +
    `only ${ROAMING_CALLER} reaches the roaming one, ` +
    `and that no module outside ${[...DIRECTORY_GRANTERS].length} named ones ` +
    `opens a directory to the webview.`,
);
