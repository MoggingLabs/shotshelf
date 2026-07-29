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
  ["src-tauri/src/imaging/export.rs", ["clippy::cast_sign_loss"]],
  ["src-tauri/src/poster.rs", ["clippy::cast_sign_loss", "clippy::disallowed_methods"]],
  ["src-tauri/src/enrich/foreground.rs", ["clippy::cast_sign_loss"]],
  ["src-tauri/src/imaging/compare.rs", [
    "clippy::cast_precision_loss",
    "clippy::cast_sign_loss",
    "clippy::cast_sign_loss",
  ]],
]);

/**
 * The source with every comment, string and character literal blanked out.
 *
 * Same length as the input — each removed character becomes a space, and
 * newlines survive — so offsets and line numbers still line up.
 *
 * This exists because the alternative was matching a spelling. [`silencedIn`]
 * used to find attributes with `/^[^\S\r\n]*#!?\[/`, which requires one to be
 * the first thing on its line. Rust does not: an attribute may sit mid-line on
 * a statement. That anchor was really an unstated dependency on `cargo fmt`
 * having moved every attribute onto its own line — and `#[rustfmt::skip]` is
 * itself an attribute, which the scan read, found no `allow(` in, and threw
 * away. So the one attribute that switches off the normalisation the whole rule
 * leaned on was invisible to it, and a reviewer used exactly that to route the
 * diagnostic log into `%APPDATA%` with all four gates green.
 *
 * Blanking the comments is what the anchor was really for — keeping the files
 * that *warn* about these attributes in prose from counting as users of them —
 * and doing it directly costs the dependency on a formatter. Strings go too, so
 * an attribute quoted inside a Rust string cannot be mistaken for a real one.
 *
 * @param {string} source
 * @returns {string}
 */
function codeOnly(source) {
  let out = "";
  let i = 0;

  /** Blank `count` characters from `i`, keeping newlines so lines still align. */
  const blank = (count) => {
    for (let k = 0; k < count && i < source.length; k += 1, i += 1) {
      out += source[i] === "\n" ? "\n" : " ";
    }
  };

  while (i < source.length) {
    const pair = source.slice(i, i + 2);

    if (pair === "//") {
      while (i < source.length && source[i] !== "\n") blank(1);
      continue;
    }

    if (pair === "/*") {
      // Rust's block comments nest, so this counts rather than scanning to the
      // first `*/`.
      let depth = 0;
      while (i < source.length) {
        const inner = source.slice(i, i + 2);
        if (inner === "/*") {
          depth += 1;
          blank(2);
          continue;
        }
        if (inner === "*/") {
          depth -= 1;
          blank(2);
          if (depth === 0) break;
          continue;
        }
        blank(1);
      }
      continue;
    }

    // `r"…"`, `r#"…"#`, `r##"…"##` — the closing marker carries the same
    // number of hashes, which is the whole point of the form.
    const raw = /^r(#*)"/.exec(source.slice(i));
    if (raw) {
      const closer = `"${raw[1]}`;
      const from = i + raw[0].length;
      const at = source.indexOf(closer, from);
      blank((at === -1 ? source.length : at + closer.length) - i);
      continue;
    }

    // A character literal, before the string branch: `'"'` would otherwise open
    // a string that never closes. A lifetime (`'a`, `'static`) has no closing
    // quote in that position and so does not match.
    const character = /^'(?:\\.|[^'\\])'/.exec(source.slice(i));
    if (character) {
      blank(character[0].length);
      continue;
    }

    if (source[i] === '"') {
      blank(1);
      while (i < source.length && source[i] !== '"') blank(source[i] === "\\" ? 2 : 1);
      blank(1);
      continue;
    }

    out += source[i] ?? "";
    i += 1;
  }

  return out;
}

/**
 * The lints an attribute silences, in source order.
 *
 * Found anywhere in the code — not at the start of a line — because Rust puts
 * attributes wherever it likes and [`codeOnly`] has already removed the prose
 * and strings that the old line anchor was standing in for. Balanced across
 * brackets, so a `cfg_attr` wrapper, a `reason = "…"`, or several lints in one
 * attribute are all read rather than missed.
 *
 * @param {string} source
 * @returns {string[]}
 */
function silencedIn(source) {
  const code = codeOnly(source);
  const found = [];

  for (const start of code.matchAll(/#!?\[/g)) {
    const open = start.index + start[0].length - 1;
    let depth = 0;
    let end = -1;

    for (let i = open; i < code.length; i += 1) {
      const char = code[i];
      if (char === "[" || char === "(") depth += 1;
      else if (char === "]" || char === ")") {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) continue;

    // Whitespace gone, so `clippy :: disallowed_methods` reads the same as the
    // ordinary spelling. The prefix class keeps identifiers that merely end in
    // `allow` from counting.
    const body = code.slice(open + 1, end).replace(/\s+/g, "");
    if (!/(?:^|[(,])(?:allow|expect)\(/.test(body)) continue;

    found.push(...[...body.matchAll(/clippy::[a-z_]+/g)].map((lint) => lint[0]));
    // `warnings` is every lint at once, clippy's included, and names no group.
    if (/(?:^|[(,])warnings(?=[,)])/.test(body)) found.push("warnings");
  }

  return found;
}

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

const problems = [];

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
  if (source.includes("allow_directory(") && !DIRECTORY_GRANTERS.has(normalised)) {
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
