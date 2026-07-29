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

/**
 * Failures found in the lint *configuration*, before any source file is read.
 *
 * Separate from `problems` only because it is collected first; both end up in
 * the same report.
 */
const problemsWithConfig = [];

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
 * Every lint each file is allowed to silence, by name.
 *
 * Every rule in `clippy.toml` — the roaming root, the four `PathResolver`
 * functions, `Scope::allow_directory` — is silenced by one of these at the call,
 * and the attribute is three words and copy-pasteable. A reviewer added one to
 * `handoff.rs` beside `Scope::allow_directory(&scope, …)` and one to `diag.rs`
 * beside `roots::preferences(app)`, and both gates reported success: clippy was
 * silenced, and the checks below match spellings that UFCS and module aliases
 * walk past. The two gates were each other's blind spot only for *where a call
 * is written*; neither covered the escape hatch itself, which is the same hole
 * in both. This table is what covers it.
 *
 * Three rounds of this rule were written as a list of attribute *spellings*, and
 * each was walked past by a spelling nobody had listed: UFCS, then the inner
 * `#![allow(…)]` form, then `#[expect]`. The fourth bypass was five at once —
 * `#[allow(clippy::disallowed_methods, clippy::disallowed_types)]`,
 * `#[expect(…, reason = "…")]` (the form clippy itself recommends),
 * `#[allow(unused, clippy::disallowed_methods)]`, `#[cfg_attr(all(), allow(…))]`
 * and `#[allow(clippy :: disallowed_methods)]` — because the pattern admitted
 * exactly one lint name and then demanded a closing paren. A reviewer used the
 * comma form to route the diagnostic log, which `dirs.rs` and `SECURITY.md` both
 * name as the thing that must never roam, into `%APPDATA%` with this script at
 * exit 0 *and* clippy green.
 *
 * The fifth was subtler and is worth stating, because the fix for the fourth
 * claimed to have ended this and had not: `#[rustfmt::skip]` above a statement
 * carrying a mid-line `#[allow]`. The parser balanced brackets correctly but
 * still only *found* attributes that began a line, which is a spelling — and one
 * that held only because `cargo fmt --check` moves attributes onto their own
 * line. `rustfmt::skip` is itself an attribute the scan read and discarded, so
 * the single attribute that switches off that normalisation was the one thing
 * hiding from it.
 *
 * So this stops matching spellings, for real this time. [`codeOnly`] blanks the
 * comments and strings — which is what the line anchor was standing in for —
 * and then [`silencedIn`] finds attributes *anywhere*, balances brackets, strips
 * whitespace, and reads the lint names out of the ones that are an `allow` or an
 * `expect`. That is decidable, where "did I list every way to write this
 * attribute" is not, and it depends on no formatter.
 *
 * Names, not a count. A count is substitutable: `src-tauri/src/imaging/compare.rs` is entitled
 * to three cast allowances, and with a bare `3` one of them could become
 * `disallowed_methods` without moving the number.
 *
 * The consequence is that *any* clippy allowance needs a line here, not only the
 * ones touching `clippy.toml`. That is the point — an allowance is a decision,
 * and the cast ones below are decisions too. They are cheap to add and the diff
 * is the record. No count is quoted, here or anywhere: the table is the count.
 */
const ALLOWANCES = new Map([
  // Resolves every root; one per resolving statement, never file-scope.
  ["src-tauri/src/dirs.rs", [
    "clippy::disallowed_methods",
    "clippy::disallowed_methods",
    "clippy::disallowed_methods",
  ]],
  // The watch list and the clipboard folder.
  ["src-tauri/src/catch/mod.rs", ["clippy::disallowed_methods"]],
  // Caches Shotshelf writes itself.
  ["src-tauri/src/edit.rs", ["clippy::disallowed_methods"]],
  // The one permitted reach into the roaming profile.
  ["src-tauri/src/settings.rs", ["clippy::disallowed_methods"]],
  // Casts whose range is guarded at the call site, not root resolution.
  //
  // These were dead until `Cargo.toml` turned the two lints on. They named
  // `clippy::cast_*`, which are `pedantic` and so allow-by-default, and nothing
  // in the crate enabled pedantic — so all four could be deleted with
  // `cargo clippy -- -D warnings` at exit 0, and this table documented a
  // decision no tool would ever have raised. The lints are switched on now, the
  // attributes are load-bearing, and the guard each one names is real:
  // a `clamp`, a `max(0.0)`, or a comparison immediately above.
  // A clamp before the narrowing, in both cases.
  ["src-tauri/src/imaging/export.rs", [
    "clippy::cast_possible_truncation",
    "clippy::cast_sign_loss",
  ]],
  // `max(0.0)` on a duration ffmpeg reported in seconds.
  ["src-tauri/src/poster.rs", [
    "clippy::cast_possible_truncation",
    "clippy::cast_sign_loss",
    "clippy::disallowed_methods",
  ]],
  // A window title length the OS has already reported positive.
  ["src-tauri/src/enrich/foreground.rs", ["clippy::cast_sign_loss"]],
  // Grid coordinates the bounds check above each one has already rejected, and
  // one block-fraction division whose operands are far below f32's exact range.
  ["src-tauri/src/imaging/compare.rs", [
    "clippy::cast_possible_truncation",
    "clippy::cast_possible_truncation",
    "clippy::cast_precision_loss",
    "clippy::cast_sign_loss",
    "clippy::cast_sign_loss",
  ]],
  // A `f64` clamped into `i32` range, and a compile-time `size_of_val` of a u32.
  ["src-tauri/src/window.rs", [
    "clippy::cast_possible_truncation",
    "clippy::cast_possible_truncation",
  ]],
  // `Duration::as_millis` is a `u128`, and `u64::try_from` is not usable in a
  // const initialiser. Both of these are const arithmetic over sub-second
  // constants declared a few lines above them.
  ["src-tauri/src/catch/clipboard.rs", ["clippy::cast_possible_truncation"]],
  ["src-tauri/src/catch/folders.rs", ["clippy::cast_possible_truncation"]],
]);

import { grantsIn, silencedIn, tomlWithoutComments } from "./rust-source.mjs";
/**
 * The modules whose asset-protocol grants are whole folders on purpose.
 *
 * `src-tauri/src/catch/mod.rs` grants the watch list and the clipboard folder,
 * whose contents are captures by definition; `src-tauri/src/poster.rs` and
 * `src-tauri/src/edit.rs` grant caches Shotshelf itself writes. Anything else
 * wanting the webview to read a file has to argue for it here first.
 */
const DIRECTORY_GRANTERS = new Set([
  "src-tauri/src/catch/mod.rs",
  "src-tauri/src/poster.rs",
  "src-tauri/src/edit.rs",
]);

/**
 * The clippy rules the source-text checks below are only half of.
 *
 * `clippy.toml`'s `disallowed-methods`/`disallowed-types` and `Cargo.toml`'s
 * `[lints.clippy]` levels are what catch the spellings *this file cannot see* —
 * UFCS, a module alias, a function item taken by reference. Nothing read either
 * file. One line, `disallowed_methods = "allow"` appended to `[lints.clippy]`,
 * switched the whole resolved-path half off with every gate green: a reviewer
 * used it to route the diagnostic log into `%APPDATA%` through a module alias,
 * and to open `C:/` recursively to the webview from a module that is not a
 * granter. Deleting the `[lints.clippy]` block outright is the same shape one
 * level up — it returns every `#[allow(clippy::cast_*)]` in the tree to
 * silencing a lint nothing enables, which is precisely the dead-attribute
 * defect that block was added to end.
 *
 * That is the escape hatch spelled as *configuration*, and it is strictly
 * stronger than the attribute form, because it needs no attribute anywhere for
 * `silencedIn` to find. So the required rules live in a fixture and are checked
 * like any other cross-language contract: remove one, or lower a level, and this
 * goes red.
 */
const CLIPPY_RULES = JSON.parse(readFileSync("tests/fixtures/clippy-rules.json", "utf8"));

{
  // Comments blanked first. Read as raw text, commenting every rule out left
  // all of their paths present in the file and this check green over a
  // `clippy.toml` that was semantically empty — the same defect `codeOnly`
  // exists to prevent, one file type over.
  const clippyToml = tomlWithoutComments(readFileSync("src-tauri/clippy.toml", "utf8"));
  for (const path of CLIPPY_RULES.disallowed) {
    if (!clippyToml.includes(`"${path}"`)) {
      problemsWithConfig.push(
        `  src-tauri/clippy.toml: no longer disallows \`${path}\`. ` +
          `Clippy resolves paths, so it is the only thing here that sees UFCS ` +
          `and module aliases.`,
      );
    }
  }

  // The `[lints.clippy]` table only, so a level set elsewhere in the manifest
  // cannot be mistaken for this one.
  const manifest = tomlWithoutComments(readFileSync("src-tauri/Cargo.toml", "utf8"));
  const table = /\[lints\.clippy\]([\s\S]*?)(?=\n\[|$)/.exec(manifest)?.[1] ?? "";
  // Nothing in this table may be set to `allow`.
  //
  // Requiring the four `warn` lines is not enough on its own: appending
  // `disallowed_methods = "allow"` leaves them all present and still switches
  // the `clippy.toml` rules off, which is the bypass this whole check exists
  // for. An `allow` here is the escape hatch spelled as configuration, and it
  // gets the same treatment as the attribute form — argue for it in a diff.
  // Both spellings Cargo accepts, and either quote.
  //
  // The first version matched `name = "allow"` only. Cargo also takes
  // `name = { level = "allow", priority = 1 }`, and TOML takes single quotes and
  // a quoted key — so `disallowed_methods = { level = 'allow' }` switched the
  // rule off with this check green, which is verbatim the bypass it was added
  // to close.
  for (const allowed of table.matchAll(
    /^\s*"?([a-z_:]+)"?\s*=\s*(?:['"]allow['"]|\{[^}]*level\s*=\s*['"]allow['"][^}]*\})/gm,
  )) {
    const lint = allowed[1] ?? "a lint";
    problemsWithConfig.push(
      `  src-tauri/Cargo.toml: [lints.clippy] sets \`${lint}\` to "allow". ` +
        `That switches a clippy rule off for the whole crate with no attribute ` +
        `anywhere for the allowance table to see.`,
    );
  }

  for (const [lint, level] of Object.entries(CLIPPY_RULES.denied)) {
    if (!new RegExp(String.raw`^\s*${lint}\s*=\s*"${level}"`, "m").test(table)) {
      problemsWithConfig.push(
        `  src-tauri/Cargo.toml: [lints.clippy] no longer sets \`${lint} = "${level}"\`. ` +
          `Every \`#[allow(clippy::${lint})]\` in the tree silences nothing without it.`,
      );
    }
  }
}

const problems = [...problemsWithConfig];


for (const file of globSync("src-tauri/src/**/*.rs")) {
  const normalised = file.replaceAll("\\", "/");
  const source = readFileSync(file, "utf8");

  // The owner is exempt from the *root-resolution* rules only.
  //
  // This used to `continue` past every check, so the directory-grant rule
  // below could not see `dirs.rs` at all — and a reviewer added an
  // `allow_directory` to `dirs::cache` that this script, clippy, knip and the
  // whole gate accepted, while the success line claimed no module outside the
  // three named ones opens a directory. `dirs.rs` resolves roots by design;
  // it has no business granting one to the webview.
  const resolvesRootsByDesign = normalised === OWNER;


  // A method call, `.app_data_dir(`, not the bare name. Prose mentions these —
  // `dirs.rs`'s header explains why the roaming ones are what they are — and a
  // check that fires on its own documentation is a check that gets suppressed.
  // This one caught `dirs.rs` on its first run for exactly that.
  for (const owned of OWNED) {
    if (!resolvesRootsByDesign && source.includes(`.${owned}(`)) {
      problems.push(
        `  ${normalised}: resolves \`${owned}()\` itself. ` +
          `Go through \`dirs::preferences\`, \`dirs::local\` or \`dirs::cache\` — ` +
          `that module is where the roaming-vs-local rule is stated.`,
      );
    }
  }

  if (!resolvesRootsByDesign && source.includes(BASE_DIRECTORY)) {
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
  // `Scope` only ever adds.
  //
  // The fix was not `allow_file`, which an earlier version of this comment
  // claimed. Granting each stored pin by file has the same defect one size
  // smaller: `allowed_pins` keeps any path that parses as absolute, so one
  // hand-edited pin plus a restart still admits an arbitrary file to
  // `describe_capture`, `copy_capture` and `prepare_drag`. The stored pin list
  // grants nothing at all now — `src-tauri/src/lib.rs` says so at the site and
  // says why — and the tiles that used to need it are redrawn by the front end
  // once the catch engine reports ready. So this rule holds `allow_directory`
  // to the modules whose grants are folders by design, and there is no
  // by-file escape hatch behind it.
  //
  // Two limits, both real, and `clippy.toml` now carries this rule as a
  // `disallowed-methods` entry because of the second one.
  //
  // First: this matches the *spelling* `.allow_directory(`, so
  // `tauri::scope::fs::Scope::allow_directory(&scope, …)` walks past it — a
  // reviewer did exactly that, and it is the third spelling-matched rule in
  // this file to be bypassed that way. Clippy resolves the path instead — but
  // a per-call `#[allow]` silences clippy, so "each covers the other's blind
  // spot" was false for the one thing both share. The allowance count above is
  // what covers it, and this rule now matches the bare name so UFCS is caught
  // here as well.
  //
  // Second: the exemption here is per *file*. That once let a directory grant
  // hide inside an exempt module, which is why a grant belongs in a file that
  // never legitimately needs one: while that
  // function sat in `src-tauri/src/catch/mod.rs`, which is exempt for
  // `allow_reading_captures`, this check could not see it and the escalation
  // re-landed with every gate green. A reviewer proved exactly that. A module
  // wanting a directory grant now has to join the set, in a diff.
  // `allow_directory(` — the name and its open paren, not `.allow_directory(`.
  //
  // UFCS never writes the dot: `tauri::scope::fs::Scope::allow_directory(&scope,
  // …)` walked straight past the older spelling, and a reviewer used exactly
  // that. The paren keeps prose out — several files name the function while
  // explaining why they must not call it.
  // The three permitted grants must stay non-recursive.
  //
  // `allow_directory(p, recursive)` with `true` opens every *subdirectory* of
  // `p` as well — on Linux, where the watch list is `~/Pictures` and `~/Videos`
  // themselves, that is the user's entire picture library handed to
  // `describe_capture`, `copy_capture` and `prepare_drag`. Nothing could see
  // that: this rule only asked *whether* the call was there, the granting
  // modules are exempt from it by name, and each of them carries an `#[allow]`
  // that silences clippy's own entry by design. One character, no gate.
  for (const grant of grantsIn(source)) {
    if (grant === "false") continue;
    problems.push(
      `  ${normalised}: grants a directory recursively. ` +
        `\`allow_directory(p, true)\` opens every subdirectory of \`p\` to the ` +
        `webview; the watch list is not a tree.`,
    );
  }

  // Through `codeOnly`, like the recursion check three lines up.
  //
  // Half of one rule was comment- and string-aware and half was not, and the
  // raw half was held together by a spelling convention — "the paren keeps
  // prose out" — that several files had to keep obeying by hand.
  if (grantsIn(source).length > 0 && !DIRECTORY_GRANTERS.has(normalised)) {
    problems.push(
      `  ${normalised}: calls \`allow_directory\`, which opens every file beside ` +
        `the one named. Only ${[...DIRECTORY_GRANTERS].join(", ")} may, because ` +
        `their grants are folders by design. A module that needs one has to join ` +
        `that set here, in a diff.`,
    );
  }

  // Every escape hatch is counted, wherever it is.
  //
  // Deliberately outside the `resolvesRootsByDesign` exemption: `dirs.rs` is
  // allowed to resolve roots, not to grant itself extra allowances.
  const silenced = silencedIn(source).sort();
  const permitted = [...(ALLOWANCES.get(normalised) ?? [])].sort();
  if (silenced.join(", ") !== permitted.join(", ")) {
    problems.push(
      `  ${normalised}: silences [${silenced.join(", ") || "nothing"}], ` +
        `and check-dirs.mjs accounts for [${permitted.join(", ") || "nothing"}]. ` +
        `An \`allow\` or \`expect\` naming a clippy lint switches off part of ` +
        `\`clippy.toml\` for everything below it, so adding one is a decision, ` +
        `not a formality — say why in the table there.`,
    );
  }

  if (!resolvesRootsByDesign && normalised !== ROAMING_CALLER && source.includes(ROAMING)) {
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
