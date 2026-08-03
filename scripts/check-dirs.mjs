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
 * The consequence is that *any* allowance needs a line here, not only the ones
 * touching `clippy.toml`. That is the point — an allowance is a decision, and
 * the cast ones below are decisions too. They are cheap to add and the diff is
 * the record. No count is quoted, here or anywhere: the table is the count.
 *
 * "Any allowance" was a claim before it was true. `silencedIn` harvested
 * `clippy::` names plus the literal `warnings`, so a bare rustc lint was
 * dropped and this table saw an empty set for a file that had switched one off
 * — with three `#[allow(dead_code)]` live in the tree, uncounted, and
 * `cargo clippy -- -D warnings` the only thing enforcing "no dead code" on the
 * Rust side at all.
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
  // const initialiser. Both are const arithmetic over sub-second constants —
  // `folders.rs`'s declared a few lines above it, `clipboard.rs`'s imported
  // from `folders.rs`, which is the point of that one.
  ["src-tauri/src/catch/clipboard.rs", ["clippy::cast_possible_truncation"]],
  ["src-tauri/src/catch/folders.rs", ["clippy::cast_possible_truncation"]],
  // The rustc allowances, which this table could not see until now.
  //
  // `#[allow(dead_code)]` is the strongest escape hatch in the crate:
  // `cargo clippy -- -D warnings` is the only thing enforcing "no dead code" on
  // the Rust side, and this switches it off. Three were live in the tree,
  // uncounted, under a comment reading "Every escape hatch is counted, wherever
  // it is" — because `silencedIn` harvested `clippy::` names and the literal
  // `warnings`, and a bare rustc lint matched neither.
  //
  // All three are the *same* decision, and it is a good one: a function that is
  // deliberately compiled on every OS so it can be reached from a test, and
  // called for real on only some of them. The alternative is `cfg`-gating it
  // out, which is how `macos_candidates` shipped a bug nobody could reproduce.
  // Each is `cfg_attr`-scoped to exactly the platforms with no caller, so a
  // genuinely dead function still fails the build everywhere else.
  ["src-tauri/src/catch/paths.rs", ["dead_code", "dead_code"]],
  ["src-tauri/src/share.rs", ["dead_code"]],
  // The OCR child's deadline, which only Linux reads but every platform tests:
  // it has to stay under `SCAN_TIMEOUT`, or a wedged capture leaves a
  // `tesseract` process and its blocking thread running past the point where
  // anything wants the answer. Compiled everywhere so the inequality is
  // asserted everywhere.
  ["src-tauri/src/limits.rs", ["dead_code"]],
]);

import {
  lintLevelsIn,
  disallowedIn,
  grantsIn,
  silencedIn,
  weakeningFlagsIn,
} from "./rust-source.mjs";
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

/** Clippy's lint levels, weakest first, so "or stronger" is an index comparison. */
const STRENGTH = ["allow", "warn", "deny", "forbid"];

{
  // Read as arrays, not as one long string.
  //
  // Comments go first — read as raw text, commenting every rule out left all of
  // their paths present in the file and this check green over a `clippy.toml`
  // that was semantically empty. But blanking them was only half of it: this
  // asked whether the *file* contained `"tauri::path::BaseDirectory"` anywhere
  // at all, and moving that path out of `disallowed-types` — the one array
  // where clippy matches a type — into the methods list, or down into a
  // neighbouring `reason = "…"`, left the substring present and the rule gone.
  // A whole-file `includes` is not an assertion that a rule is in force; it is
  // an assertion that some characters exist somewhere.
  const disallowed = disallowedIn(readFileSync("src-tauri/clippy.toml", "utf8"));
  for (const [array, paths] of Object.entries(CLIPPY_RULES.disallowed)) {
    for (const path of paths) {
      if (!(disallowed.get(array) ?? []).includes(path)) {
        problemsWithConfig.push(
          `  src-tauri/clippy.toml: \`${array}\` no longer holds \`${path}\`. ` +
            `Clippy resolves paths, so it is the only thing here that sees UFCS ` +
            `and module aliases.`,
        );
      }
    }
  }

  // What each lint is set to, under its resolved key rather than its spelling.
  //
  // The ways TOML lets you write one setting — an indented header, spaces inside
  // the brackets, the `[lints.clippy.x]` sub-table, a fully dotted key with no
  // table at all, `x.level = "allow"`, and `{ level = "allow" }` in place of
  // `"allow"` — were separate bypasses of this check, found and closed one at a
  // time over five rounds, each fix a new pattern beside the last.
  // `lintLevelsIn` resolves the key instead, so a spelling nobody has thought
  // of yet arrives at the same name, and `scripts/rust-source.test.mjs` holds
  // every form as a row.
  const levels = lintLevelsIn(readFileSync("src-tauri/Cargo.toml", "utf8"));

  // Nothing under `[lints]` may be switched off, whether or not the fixture
  // names it — and `[lints.rust]` counts.
  //
  // Requiring the four `warn` lines is not enough on its own: appending
  // `disallowed_methods = "allow"` leaves all four present and still switches
  // the `clippy.toml` rules off, which is the bypass this whole check exists
  // for. An `allow` here is the escape hatch spelled as configuration, and it
  // gets the same treatment as the attribute form — argue for it in a diff.
  //
  // "The same treatment as the attribute form" was true of clippy's lints and
  // false of rustc's for a round: the attribute half had just been widened to
  // count `#[allow(dead_code)]` — which the table above calls the strongest
  // escape hatch in the crate — while this half still read `lints.clippy` only.
  // Four lines of `[lints.rust] dead_code = "allow"` switched off the one thing
  // enforcing "no dead code" in the whole crate, crate-wide, with clippy and
  // this script both green.
  for (const [lint, level] of levels) {
    if (level === "allow") {
      problemsWithConfig.push(
        `  src-tauri/Cargo.toml: [lints] sets \`${lint}\` to "allow". ` +
          `That switches the rule off for the whole crate with no attribute ` +
          `anywhere for the allowance table to see.`,
      );
    }
  }

  // The third place a lint level comes from, which nothing here read.
  //
  // A level is the union of `[lints.clippy]`, the attributes in the source, and
  // the rustc flags cargo assembles from every .cargo/config.toml on its
  // discovery path. This gate modelled the first two. A four-line file at the
  // repo root —
  //
  //     [build]
  //     rustflags = ["-Aclippy::disallowed_methods"]
  //
  // — switched off the resolved-path half of the roaming-profile rule with
  // `cargo clippy -- -D warnings` printing "Finished" and this script printing
  // success, while a module alias wrote the diagnostic log into `%APPDATA%`.
  // The file is not git-ignored and CI runs clippy from the repo root.
  //
  // The rule is about the *file*, not about a list of flag names.
  //
  // The first version enumerated four rustc flag spellings, and a reviewer went
  // straight past it with a spelling that is not a flag at all:
  //
  //     [env]
  //     CLIPPY_CONF_DIR = { value = "_empty", relative = true, force = true }
  //
  // — which does not weaken a lint. It points clippy at a *different*
  // `clippy.toml`, so every `disallowed-methods` and `disallowed-types` entry
  // stops being read. The roaming-profile rule went with it, and the check
  // above still passed, because it verifies the rules are *written* while the
  // config makes clippy never open the file they are written in.
  //
  // Enumerating spellings is the same mistake as the five TOML bypasses this
  // gate already records, one layer out. A cargo config's power over lint
  // enforcement is not confined to `rustflags`, and the next lever will not be
  // on any list either. This repository commits no cargo config and needs none,
  // so the rule is: there is not one. Adding one is a decision — it goes on the
  // list below, in a diff.
  //
  // `CARGO_CONFIGS` is empty, so the weakening scan under it is unreachable
  // today. That is deliberate and stated rather than left to look like cover:
  // refusing by existence is strictly stronger than reading flags, and the scan
  // is what an allow-listed config would still have to pass. An empty hatch is
  // the intended state — the alternative is one added under time pressure,
  // which is how a gate stops biting.
  const CARGO_CONFIGS = new Set();
  for (const config of globSync([".cargo/config.toml", ".cargo/config", "*/.cargo/config*"])) {
    const named = config.replaceAll("\\", "/");
    if (!CARGO_CONFIGS.has(named)) {
      problemsWithConfig.push(
        `  ${named}: cargo reads this on every build, and what it can do to lint ` +
          `enforcement is open-ended — \`rustflags\`, \`[env] RUSTFLAGS\`, ` +
          `\`[env] CLIPPY_CONF_DIR\` pointing clippy at a different clippy.toml. ` +
          `Nothing here needs one. If something does, name it in CARGO_CONFIGS ` +
          `in ${import.meta.filename} and say why.`,
      );
      continue;
    }

    const weakening = weakeningFlagsIn(readFileSync(config, "utf8"));
    if (weakening.length > 0) {
      problemsWithConfig.push(
        `  ${named}: passes [${weakening.join(", ")}] to rustc. Cargo adds these ` +
          `to every build, so they override \`[lints.clippy]\` and leave ` +
          `\`cargo clippy -- -D warnings\` green over a rule that is no longer in ` +
          `force. A lint level is a decision — make it in Cargo.toml, where this ` +
          `gate can see it.`,
      );
    }
  }

  // And the same variables set in CI, which no committed TOML would show.
  //
  // Both ways a workflow can set one: the `env:` mapping, and appending to
  // `$GITHUB_ENV` from a `run:` step — which is GitHub's documented way to set
  // a variable for later steps, and which the first version of this check,
  // looking only for `NAME:`, walked straight past.
  for (const workflow of globSync([".github/workflows/*.yml", ".github/workflows/*.yaml"])) {
    const text = readFileSync(workflow, "utf8");
    for (const name of ["RUSTFLAGS", "RUSTDOCFLAGS", "CARGO_ENCODED_RUSTFLAGS", "CLIPPY_CONF_DIR"]) {
      if (new RegExp(String.raw`\b${name}\s*[:=]`).test(text)) {
        problemsWithConfig.push(
          `  ${workflow.replaceAll("\\", "/")}: sets \`${name}\`, which cargo ` +
            `folds into every lint level and this gate cannot resolve. ` +
            `Whatever it is for belongs in Cargo.toml or clippy.toml.`,
        );
      }
    }
  }

  // The lints the tree's `#[allow]` attributes depend on, at the fixture's level
  // or stronger. Raising one to `deny` is a hardening and passes; lowering or
  // deleting one returns every `#[allow(clippy::cast_*)]` in the tree to
  // silencing a lint nothing enables, which is the dead-attribute defect that
  // block was added to end.
  for (const [lint, wanted] of Object.entries(CLIPPY_RULES.denied)) {
    const set = levels.get(lint);
    if (STRENGTH.indexOf(set ?? "allow") < STRENGTH.indexOf(wanted)) {
      problemsWithConfig.push(
        `  src-tauri/Cargo.toml: [lints] no longer sets \`${lint}\` to "${wanted}" or ` +
          `stronger (it is ${set === undefined ? "unset" : `"${set}"`}). Every ` +
          `\`#[allow(${lint})]\` in the tree silences nothing without it.`,
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
  // The permitted grants must not deepen on their own.
  //
  // `allow_directory(p, recursive)` with `true` opens every *subdirectory* of
  // `p` as well — on Linux, where the stock watch list is `~/Pictures` and
  // `~/Videos` themselves, that is the user's entire picture library handed
  // to `describe_capture`, `copy_capture` and `prepare_drag`. Nothing could
  // see that: this rule only asked *whether* the call was there, the granting
  // modules are exempt from it by name, and each of them carries an `#[allow]`
  // that silences clippy's own entry by design. One character, no gate.
  //
  // One data-driven depth is permitted, in the one module that owns the watch
  // grant: `dir.recursive` is `WatchDir`'s flag, whose provenance is pinned in
  // `src-tauri/src/catch/paths.rs` — stock folders are built `recursive: false`
  // in exactly one function, and only a folder the *user* added carries `true`
  // (owner decision, 2026-08-03: "watch D:\Work" means its subfolders too, and
  // the grant must be exactly as deep as the watch or the shelf catches what
  // it cannot show). A literal `true` stays refused everywhere: depth must
  // arrive as the user's own choice, never as a constant.
  for (const grant of grantsIn(source)) {
    if (grant === "false") continue;
    if (grant === "dir.recursive" && normalised === "src-tauri/src/catch/mod.rs") continue;
    problems.push(
      `  ${normalised}: grants a directory recursively. ` +
        `\`allow_directory(p, true)\` opens every subdirectory of \`p\` to the ` +
        `webview; only the user's own watch choice may carry depth, as ` +
        `\`dir.recursive\` in the watch module.`,
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
        `An \`allow\` or \`expect\` switches a lint off for everything below it — ` +
        `a clippy one takes part of \`clippy.toml\` with it, and \`dead_code\` ` +
        `takes the only thing enforcing "no dead code" in the crate. Adding one ` +
        `is a decision, not a formality — say why in the table there.`,
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
