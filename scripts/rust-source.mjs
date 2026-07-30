// The Rust-source parsing the directory gate is built on, in one place so it
// can be tested.
//
// These three functions have been walked past in seven consecutive review
// rounds, and every fix so far was asserted in a commit message and executed
// nowhere: `scripts/rust-source.test.mjs` is the table of forms that must fire
// and must not. They live here rather than in `check-dirs.mjs` because that
// file runs the gate at import time — it globs, reports and calls
// `process.exit` — so nothing could import it to test a function.

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
export function codeOnly(source) {
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

  // `#` and `[` pulled together, and `#!` with them.
  //
  // Rust tokenises `#`, `!` and `[` separately, so `# [allow(..)]` and
  // `#! [allow(..)]` are legal and effective — and invisible to a scan for
  // `#[`. That was the seventh bypass of this rule, and it was the fifth one
  // again: the only thing hiding it was `cargo fmt --check` normalising the
  // space away, switched off by the `#[rustfmt::skip]` that the fifth bypass
  // used and that this scan still contributes nothing for.
  //
  // Normalised here rather than widened into the regex, because `#\s*\[` would
  // be bypass eight: `# /*c*/ [` is legal too. By this point comments are
  // already blanked to spaces, so closing every gap between `#`, `!` and `[`
  // covers both, and anything else that lands between them is not an attribute.
  return out.replace(
    /#(\s*)(!?)(\s*)\[/g,
    /** @type {(whole: string, before: string, bang: string) => string} */
    (whole, _before, bang) => {
      // Padded with the newlines the match contained, not with spaces.
      //
      // `padEnd(…, " ")` was shorter and broke this function's own promise that
      // line numbers survive: an attribute written with a line break between
      // `#` and `[` came back one line shorter than it went in. Nothing reads
      // offsets today, so it was prose outrunning code rather than a live bug —
      // in the file added to end exactly that.
      const newlines = (whole.match(/\n/g) ?? []).join("");
      const head = `#${bang}[`;
      return head + newlines + " ".repeat(whole.length - head.length - newlines.length);
    },
  );
}

/**
 * The last argument of every `allow_directory` call, whitespace stripped.
 *
 * That argument is the `recursive` flag, in both spellings — `scope
 * .allow_directory(dir, false)` and `Scope::allow_directory(&scope, dir, false)`
 * — so the caller only has to compare it to `"false"`.
 *
 * Parsed, not matched. The first version of this rule was
 * `/allow_directory\s*\(([^;]*?)\)/` with a trailing `,\s*false\s*\)?$`, and it
 * failed in both directions within one commit of being written: `[^;]*?` needs
 * a `)` before any `;`, so a call whose argument list contains a statement —
 * `allow_directory(dir, { use std::convert::identity; identity(true) })` —
 * produced no match at all and the check never ran, handing the webview every
 * subdirectory of every watch folder with all four gates green. And requiring
 * `false` to be *last in the text* flagged the multi-line trailing-comma form
 * `rustfmt` produces when a call does not fit on one line.
 *
 * Both failures are the same one: a rule about a resolved value, written as a
 * rule about where characters sit. This balances brackets over [`codeOnly`]
 * output — comments and strings already blanked — splits the arguments at
 * depth zero, and drops the empty tail a trailing comma leaves.
 *
 * @param {string} source
 * @returns {string[]}
 */
export function grantsIn(source) {
  const code = codeOnly(source);
  const found = [];

  for (const call of code.matchAll(/\ballow_directory\s*(::\s*<)?/g)) {
    // A turbofish between the name and its arguments.
    //
    // `Scope::allow_directory` is generic, so `allow_directory::<&PathBuf>(dir,
    // true)` is legal Rust — and demanding `(` straight after the name matched
    // nothing at all, so the recursion check simply did not run. Skipped by
    // balancing angle brackets rather than by widening the pattern, because
    // `::<…>` nests: `::<Vec<PathBuf>>`.
    let cursor = call.index + call[0].length;
    if (call[1] !== undefined) {
      let angles = 1;
      while (cursor < code.length && angles > 0) {
        if (code[cursor] === "<") angles += 1;
        else if (code[cursor] === ">") angles -= 1;
        cursor += 1;
      }
    }
    while (/\s/.test(code[cursor] ?? "")) cursor += 1;
    // A mention that is not a call — `disallowed-methods` names the path in
    // `clippy.toml`, and several modules name it while explaining why they must
    // never call it.
    if (code[cursor] !== "(") continue;

    const open = cursor;
    let depth = 0;
    let end = -1;

    for (let i = open; i < code.length; i += 1) {
      if (code[i] === "(" || code[i] === "[" || code[i] === "{") depth += 1;
      else if (code[i] === ")" || code[i] === "]" || code[i] === "}") {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) continue;

    // Split at depth zero only, so a nested call or block stays one argument.
    const args = [];
    let start = open + 1;
    let inner = 0;
    for (let i = open + 1; i < end; i += 1) {
      if (code[i] === "(" || code[i] === "[" || code[i] === "{") inner += 1;
      else if (code[i] === ")" || code[i] === "]" || code[i] === "}") inner -= 1;
      else if (code[i] === "," && inner === 0) {
        args.push(code.slice(start, i));
        start = i + 1;
      }
    }
    args.push(code.slice(start, end));

    const given = args.map((argument) => argument.replace(/\s+/g, "")).filter(Boolean);
    found.push(given.at(-1) ?? "");
  }

  return found;
}

/** A lint name: `dead_code`, `clippy::disallowed_methods`, `rustdoc::broken_intra_doc_links`. */
const LINT = /^(?:[a-z_]+::)?[a-z_][a-z0-9_]*$/;

/**
 * The lints an attribute silences, in source order.
 *
 * Found anywhere in the code — not at the start of a line — because Rust puts
 * attributes wherever it likes and [`codeOnly`] has already removed the prose
 * and strings that the old line anchor was standing in for. Balanced across
 * brackets, so a `cfg_attr` wrapper, a `reason = "…"`, or several lints in one
 * attribute are all read rather than missed.
 *
 * **Every** lint, not only clippy's. This harvested `/clippy::[a-z_]+/` plus the
 * literal `warnings`, so a bare rustc lint — `dead_code`, `unused` — was dropped
 * and the allowance table saw an empty set for a file that had switched one off.
 * `#[allow(dead_code)]` is the strongest escape hatch in the crate: `cargo
 * clippy -- -D warnings` is the *only* thing enforcing "no dead code" on the
 * Rust side, and three of them were live in the tree, uncounted, under a comment
 * in `check-dirs.mjs` reading "Every escape hatch is counted, wherever it is."
 *
 * Read as arguments rather than scanned for a pattern: each `allow(…)` /
 * `expect(…)` in the attribute has its argument list split at depth zero, a
 * `reason = "…"` dropped because it carries an `=`, and whatever is left taken
 * whole. That is what makes "every lint" true rather than "every lint I thought
 * to write a pattern for", which is the shape that was walked past nine times.
 *
 * @param {string} source
 * @returns {string[]}
 */
export function silencedIn(source) {
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

    // Each `allow(…)` and `expect(…)` in the attribute — including one nested
    // inside a `cfg_attr` wrapper, which is how the three `dead_code`
    // allowances in this tree are written. The prefix class keeps identifiers
    // that merely end in `allow` from counting.
    for (const gate of body.matchAll(/(?:^|[(,])(?:allow|expect)\(/g)) {
      const from = gate.index + gate[0].length;
      let depth = 1;
      let to = from;
      while (to < body.length && depth > 0) {
        if (body[to] === "(") depth += 1;
        else if (body[to] === ")") depth -= 1;
        if (depth > 0) to += 1;
      }

      for (const argument of splitAtDepth(body.slice(from, to))) {
        // A `reason = "…"` is a note, not a lint. The string is already blanked,
        // so all that survives of it is the `=`.
        if (argument.includes("=")) continue;

        // An allowance whose lint name cannot be read is reported, not ignored.
        //
        // A macro composes the name from tokens this never sees —
        // `macro_rules! quiet { ($lint:ident, …) => { #[allow(clippy::$lint)] … } }`
        // — so the harvest came back empty and the allowance table read the file
        // as silencing nothing. A reviewer routed the diagnostic log into
        // `%APPDATA%` that way with `clippy.toml` and `Cargo.toml` untouched.
        //
        // Naming a lint this cannot read is a decision like any other, so it
        // fails closed: it is reported as `<unreadable>`, which no table entry
        // matches until someone writes one and says why.
        found.push(LINT.test(argument) ? argument : "<unreadable>");
      }
    }
  }

  return found;
}

/** One key segment: bare, single-quoted or double-quoted. */
const SEGMENT = String.raw`(?:'[^']*'|"[^"]*"|[\w-]+)`;

/** `a.b."c" = value`, with the dotted key and the raw value apart. */
const PAIR = new RegExp(
  String.raw`^[ \t]*(${SEGMENT}(?:[ \t]*\.[ \t]*${SEGMENT})*)[ \t]*=[ \t]*(.*)$`,
);

/**
 * Every `key = value` in a TOML file, under its fully resolved dotted name.
 *
 * TOML says the same thing several ways, and the checks built on this were
 * written against one spelling each. `[lints.clippy]` + `disallowed_methods =
 * "allow"` was matched; `[lints.clippy.disallowed_methods]` + `level = "allow"`
 * was not, nor an indented header, nor spaces inside the brackets, nor a fully
 * dotted `lints.clippy.disallowed_methods = "allow"` with no table at all. Cargo
 * honours every one of them, so each was a live way to switch a clippy rule off
 * with the gate green — and each was found and closed one at a time, in five
 * separate rounds, because the rule was stated as a shape rather than as a key.
 *
 * Resolving the key first is what ends that: a header sets a prefix, a dotted
 * key extends it, and a spelling nobody has thought of yet still arrives at the
 * same name. It also ends the mirror-image failure, where the same characters
 * under `[package]` are a *different* key and were being reported as a bypass.
 *
 * Inline tables stay whole as their value — TOML requires them on one line — so
 * `{ level = "allow", priority = 1 }` is the caller's to read.
 *
 * Not a TOML parser: no arrays-of-tables, no multi-line values, no type
 * conversion. It is the smallest thing that answers "what is this key set to",
 * which is the only question asked of it.
 *
 * Not exported: every spelling above is a row in `rust-source.test.mjs` against
 * [`lintLevelsIn`], which is the only caller and the only thing the gate asks.
 * Exporting it for the tests' sake would be a second public surface with no
 * second consumer.
 *
 * @param {string} source
 * @returns {Map<string, string>}
 */
function tomlEntries(source) {
  const entries = new Map();
  let prefix = "";


  for (const line of tomlWithoutComments(source).split("\n")) {
    const header = /^[ \t]*\[[ \t]*([^[\]]*?)[ \t]*\][ \t]*$/.exec(line);
    if (header) {
      prefix = dotted(header[1] ?? "");
      continue;
    }

    const pair = PAIR.exec(line);
    if (!pair) continue;

    const name = dotted(pair[1] ?? "");
    entries.set(prefix ? `${prefix}.${name}` : name, (pair[2] ?? "").trim());
  }

  return entries;
}

/**
 * What every `[lints]` entry sets its lint to, whatever way it is spelled.
 *
 * `warn`, `deny`, `allow` — the word Cargo will act on, keyed by the lint under
 * the name an attribute would use: `clippy::disallowed_methods` for a clippy
 * one, bare `dead_code` for a rustc one. Both `x = "allow"` and
 * `x = { level = "allow", priority = 1 }` reduce to the same answer here, so the
 * caller compares levels rather than re-deriving them from two shapes.
 *
 * **Every table under `[lints]`, not just clippy's.** This read `lints.clippy`
 * only, so four lines in the manifest —
 *
 * ```toml
 * [lints.rust]
 * dead_code = "allow"
 * ```
 *
 * — switched off the one thing enforcing "no dead code" in the whole crate,
 * with `cargo clippy -- -D warnings` printing "Finished" and the directory gate
 * printing success. A round had just made rustc lints first-class in the
 * *attribute* half, and left the *configuration* half clippy-only — under a
 * comment in `check-dirs.mjs` saying an `allow` in configuration "gets the same
 * treatment as the attribute form". `[lints.rust] warnings = "allow"` is the
 * same lever one size larger.
 *
 * @param {string} manifest
 * @returns {Map<string, string>}
 */
export function lintLevelsIn(manifest) {
  const levels = new Map();

  for (const [key, value] of tomlEntries(manifest)) {
    // `.level` optional: the sub-table and dotted-key spellings both put the
    // word one segment deeper than the plain one.
    const under = /^lints\.([\w-]+)\.([\w-]+)(?:\.level)?$/.exec(key);
    if (!under) continue;

    // `rust` is the toolchain's own lints, which an attribute names bare;
    // everything else is a tool whose lints an attribute names with its prefix.
    const tool = under[1] ?? "";
    const lint = tool === "rust" ? (under[2] ?? "") : `${tool}::${under[2] ?? ""}`;

    // `x = "allow"` and `x = { level = "allow" }` say the same thing. The second
    // form was the bypass that switched `disallowed_methods` off with this gate
    // green, so it is read rather than pattern-matched away.
    const level =
      /^(['"])(.*?)\1/.exec(value)?.[2] ?? /level[ \t]*=[ \t]*(['"])(.*?)\1/.exec(value)?.[2];
    if (level !== undefined) levels.set(lint, level);
  }

  return levels;
}

/**
 * The paths each `disallowed-*` array in `clippy.toml` actually holds.
 *
 * The gate used to ask whether the *file* contained
 * `"tauri::path::BaseDirectory"` anywhere. Moving that path out of
 * `disallowed-types` and into `disallowed-methods` — where clippy will never
 * match a type against it — or down into a neighbouring `reason`, left the
 * substring present and the rule gone. A whole-file `includes` is not an
 * assertion that a rule is in force; it is an assertion that some characters
 * exist somewhere.
 *
 * Both entry forms clippy takes are read: a bare path, and the
 * `{ path = "…", reason = "…" }` table this repo uses so each rule carries its
 * argument. A `reason` is deliberately *not* returned — quoting a path in the
 * prose beside a rule must never stand in for the rule.
 *
 * @param {string} source
 * @returns {Map<string, string[]>}
 */
export function disallowedIn(source) {
  const arrays = new Map();
  const toml = tomlWithoutComments(source);

  for (const start of toml.matchAll(/^[ \t]*(disallowed-[\w-]+)[ \t]*=[ \t]*\[/gm)) {
    const open = start.index + start[0].length - 1;
    let depth = 0;
    let end = -1;

    for (let i = open; i < toml.length; i += 1) {
      if (toml[i] === "[" || toml[i] === "{") depth += 1;
      else if (toml[i] === "]" || toml[i] === "}") {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) continue;

    const paths = [];
    for (const raw of splitAtDepth(toml.slice(open + 1, end))) {
      // Trimmed first: entries are laid out one per line, so an untrimmed one
      // starts with the newline before it and no anchored pattern can match.
      const entry = raw.trim();
      // By name, not by position — the keys of an inline table are unordered,
      // and `{ reason = "…", path = "…" }` is the same rule written the other
      // way round.
      const table = /^\{[\s\S]*\}$/.test(entry)
        ? /(?:^|[{,])[ \t]*path[ \t]*=[ \t]*(['"])(.*?)\1/.exec(entry)
        : undefined;
      const bare = /^(['"])(.*)\1$/.exec(entry);
      const path = table?.[2] ?? bare?.[2];
      if (path !== undefined) paths.push(path);
    }

    arrays.set(start[1] ?? "", paths);
  }

  return arrays;
}

/**
 * Whether a document quotes this number, as a number rather than as digits
 * inside a longer one.
 *
 * `docs/USAGE.md` promises six values the code decides — how many hand-off
 * copies are kept, how far back a launch looks and how many it brings, how many
 * corrupt settings files are set aside, what an export is sized to, and how
 * large the log grows. `check-references.mjs` holds the guide to
 * `tests/fixtures/documented-limits.json`, and `documented.rs` holds the
 * constants to the same file.
 *
 * Here rather than inline in that script, for the reason this module exists:
 * `check-references.mjs` runs its gate at import time, so nothing can import it
 * to test a rule. The bare `RegExp(value)` this started as would find `20`
 * inside `2048` — no live effect on today's guide, and a latent hole the moment
 * a longer number appears near a retired one.
 *
 * Presence, not position: nothing here can tell which sentence a number belongs
 * to, and pretending otherwise would need the prose written for the gate. What
 * it catches is the real failure — a constant moved and the guide left behind —
 * because the old number stops appearing.
 *
 * @param {string} prose
 * @param {number} value
 * @returns {boolean}
 */
export function quotesNumber(prose, value) {
  return new RegExp(String.raw`(?<![\d.])${value}(?![\d.])`).test(prose);
}

/**
 * Every struct in a Rust file that derives `Serialize`, at any visibility.
 *
 * The webview receives these, so their field names are half the IPC contract —
 * `check-wire.mjs` requires each to be in the manifest and the two languages
 * assert their fields against it.
 *
 * Here rather than in `check-wire.mjs`, and for the reason this file exists:
 * that script runs its gate at import time, so nothing can import it to test a
 * function. It matched `pub struct` alone for a round, under a header claiming
 * it "asks the crate which types serialise" — and the fix shipped with nothing
 * asserting it either, which is the failure this file's own header is about.
 *
 * `pub`, `pub(crate)` and bare all count: every module in the crate is private,
 * so `pub(crate)` is the natural visibility and nothing pushes an author toward
 * `pub`. Attributes between the derive and the keyword are skipped explicitly
 * rather than by allowing a fixed run of characters, which is a budget a long
 * enough docstring silently exceeds.
 *
 * @param {string} source
 * @returns {string[]}
 */
export function serialisingStructsIn(source) {
  return [
    ...codeOnly(source).matchAll(
      /#\[derive\([^)]*\bSerialize\b[^)]*\)\](?:\s|#\[[^\]]*\])*(?:pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_]\w*)/g,
    ),
  ].map((found) => found[1] ?? "");
}

/**
 * Every flag in a cargo config that switches a lint off or caps one.
 *
 * A clippy lint's level is not just `[lints.clippy]` and the attributes in the
 * source. It is the union of those with the rustc flags cargo assembles — from
 * `[build] rustflags`, from any `[target.…] rustflags`, from `[env] RUSTFLAGS`
 * — in **every** a .cargo/config.toml on cargo's discovery path. The gate
 * modelled the first two and read neither of the rest, so a four-line file at
 * the repo root:
 *
 * ```toml
 * [build]
 * rustflags = ["-Aclippy::disallowed_methods"]
 * ```
 *
 * switched off the resolved-path half of the roaming-profile rule with
 * `cargo clippy -- -D warnings` printing "Finished" and `check-dirs.mjs`
 * printing "only src-tauri/src/settings.rs reaches the roaming one" — while a
 * module alias wrote the diagnostic log into `%APPDATA%`. The file is not
 * git-ignored and CI runs clippy from the repo root, so it applies there too.
 *
 * Whole-file rather than "inside a `rustflags` array": a cargo config has no
 * legitimate reason to contain any of these, so the value question is "is a
 * weakening flag present", not "is it present in the place I thought to look".
 * That distinction is the same one that let five TOML spellings past the
 * `[lints.clippy]` scan.
 *
 * `-D`/`--deny`/`--forbid` are hardenings and are not returned, and neither is
 * `-W`/`--warn`: raising a lint from allow to warn is a hardening too, and
 * `cargo clippy -- -D warnings` is applied last, so a `warn` cannot hide a
 * finding. `--force-warn` *is* returned, because it overrides a `deny`.
 *
 * @param {string} source
 * @returns {string[]}
 */
export function weakeningFlagsIn(source) {
  const toml = tomlWithoutComments(source);
  const found = [];

  // The flag, then whatever it names — `-Aclippy::x`, `-A clippy::x`,
  // `--allow=clippy::x` and `--cap-lints allow` are all one spelling of this.
  //
  // The name is optional, because an array may put the flag and its lint in
  // separate strings: `["-A", "clippy::disallowed_methods"]`. Requiring one
  // matched nothing at all there, which is the form a reviewer would reach for
  // second.
  for (const flag of toml.matchAll(
    /(?<![\w-])(--cap-lints|--force-warn|--allow|-A)(?:\s*=\s*|\s+|(?=[A-Za-z]))?([\w:]*)/g,
  )) {
    found.push(`${flag[1] ?? ""} ${flag[2] ?? ""}`.trim());
  }

  return found;
}

/**
 * Split a comma-separated list, keeping anything nested whole.
 *
 * Shared by the TOML arrays in [`disallowedIn`] and the attribute argument lists
 * in [`silencedIn`]: both need "the items at this level", and both were getting
 * it wrong in the same way — a comma inside a nested table or a nested
 * `allow(…)` is not a separator.
 *
 * @param {string} body
 * @returns {string[]}
 */
function splitAtDepth(body) {
  const parts = [];
  let depth = 0;
  let from = 0;

  for (let i = 0; i < body.length; i += 1) {
    if (body[i] === "[" || body[i] === "{" || body[i] === "(") depth += 1;
    else if (body[i] === "]" || body[i] === "}" || body[i] === ")") depth -= 1;
    else if (body[i] === "," && depth === 0) {
      parts.push(body.slice(from, i));
      from = i + 1;
    }
  }
  parts.push(body.slice(from));

  return parts.filter((part) => part.trim() !== "");
}

/**
 * A dotted key with its whitespace and per-segment quotes taken off.
 *
 * @param {string} key
 * @returns {string}
 */
function dotted(key) {
  return key
    .split(".")
    .map((part) => part.trim().replace(/^(['"])(.*)\1$/, "$2"))
    .join(".");
}

/**
 * A TOML file with its comments blanked, the way [`codeOnly`] does for Rust.
 *
 * `check-dirs.mjs` read `clippy.toml` and `Cargo.toml` as raw text and asked
 * whether a rule's path appeared in them. Commenting every rule out leaves all
 * of those strings present, so the gate passed over a `clippy.toml` that was
 * semantically empty — the same "prose counted as code" bypass `codeOnly` was
 * written to end, applied to the Rust side and not to the TOML side added in
 * the same commit.
 *
 * A `#` starts a comment unless it is inside a string.
 *
 * The newlines survive, which is the part with a consumer: [`tomlEntries`]
 * splits on them, so a comment that swallowed the line break would take the
 * *next* key with it. The rest of the length is preserved too — `codeOnly`
 * needs that for Rust — but nothing reads a TOML offset, so this does not claim
 * it as a property anyone depends on.
 *
 * Not exported, for the reason [`tomlEntries`] gives: the three callers are all
 * in this file, and the only thing outside it that wanted this was a test.
 * Exporting for a test's sake is a public surface with no second consumer, and
 * it means the behaviour is asserted somewhere no caller stands — the two rows
 * that did are written through `disallowedIn` and `lintLevelsIn` now, which is
 * where the blanking actually matters.
 *
 * @param {string} source
 * @returns {string}
 */
function tomlWithoutComments(source) {
  let out = "";
  let inString = false;
  let quote = "";

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i] ?? "";

    if (inString) {
      out += char;
      // A backslash escapes only inside a *basic* (double-quoted) string.
      //
      // TOML literal strings are single-quoted and process no escapes at all,
      // so `'C:'` ends at the second quote. Treating `'` as an escape left
      // this function inside a string for the rest of the file and copied every
      // comment through unblanked — which reopened the comment bypass this was
      // added to close, in the same round, on a value as ordinary as a Windows
      // path in `disallowed-names`.
      if (char === "\\" && quote === '"') {
        out += source[i + 1] ?? "";
        i += 1;
      } else if (char === quote) {
        inString = false;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      inString = true;
      quote = char;
      out += char;
      continue;
    }

    if (char === "#") {
      while (i < source.length && source[i] !== "\n") {
        out += " ";
        i += 1;
      }
      i -= 1;
      continue;
    }

    out += char;
  }

  return out;
}
