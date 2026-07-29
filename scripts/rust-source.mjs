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
    if (!/(?:^|[(,])(?:allow|expect)\(/.test(body)) continue;

    const before = found.length;
    found.push(...[...body.matchAll(/clippy::[a-z_]+/g)].map((lint) => lint[0]));
    // `warnings` is every lint at once, clippy's included, and names no group.
    if (/(?:^|[(,])warnings(?=[,)])/.test(body)) found.push("warnings");

    // An allowance whose lint name cannot be read is reported, not ignored.
    //
    // This is bypass nine, and it is the one the "decidable" claim above was
    // wrong about. `silencedIn` recognises the attribute and then harvests
    // *names*; a macro composes the name from tokens it never sees —
    // `macro_rules! quiet { ($lint:ident, …) => { #[allow(clippy::$lint)] … } }`
    // — so the harvest came back empty and the allowance table read the file as
    // silencing nothing. A reviewer routed the diagnostic log into `%APPDATA%`
    // that way with `clippy.toml` and `Cargo.toml` untouched.
    //
    // Naming a lint this can never read is a decision like any other, so it
    // fails closed: an unreadable name is reported as `clippy::<unreadable>`,
    // which no table entry matches until someone writes one and says why.
    // Only when it *names* a clippy lint this could not read — a bare
    // `#[allow(dead_code)]` names a rustc lint and switches off nothing here.
    const namesClippy = body.includes("clippy::") || body.includes("$");
    if (before === found.length && namesClippy) found.push("clippy::<unreadable>");
  }

  return found;
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
 * A `#` starts a comment unless it is inside a string. Same length out as in,
 * so offsets still line up.
 *
 * @param {string} source
 * @returns {string}
 */
export function tomlWithoutComments(source) {
  let out = "";
  let inString = false;
  let quote = "";

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i] ?? "";

    if (inString) {
      out += char;
      if (char === "\\") {
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
