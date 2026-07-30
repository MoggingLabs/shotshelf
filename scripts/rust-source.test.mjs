/**
 * The forms the gates must see, and the forms they must not.
 *
 * These parsers had no test of any kind for seven review rounds, and in
 * every one of those rounds the rule they implement was walked past: UFCS, the
 * inner `#![allow]` form, `#[expect]`, several lints in one attribute, a
 * `reason = "…"`, a `cfg_attr` wrapper, spaces around `::`, a mid-line
 * attribute under `#[rustfmt::skip]`, a statement inside an argument list, and
 * a space between `#` and `[`. Each fix was asserted in a commit message and
 * executed nowhere.
 *
 * That is the actual root cause, and this file is the fix for it: every bypass
 * anyone finds becomes one line in a table, and the next fix cannot quietly
 * reopen an earlier one. The negative cases matter as much — a gate that fires
 * on the files explaining why these attributes are dangerous is a gate someone
 * suppresses.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  lintLevelsIn,
  quotesNumber,
  codeOnly,
  disallowedIn,
  grantsIn,
  serialisingStructsIn,
  silencedIn,
  weakeningFlagsIn,
} from "./rust-source.mjs";

/** Wrap a fragment in enough Rust that it reads like a real file. */
const file = (fragment) => `use crate::dirs;\n\n${fragment}\n\nfn other() {}\n`;

void test("every way of writing a silencing attribute is counted", () => {
  const seen = [
    "#[allow(clippy::disallowed_methods)]",
    // The inner, module-scope form: no `[` straight after `#`.
    "#![allow(clippy::disallowed_methods)]",
    // The form clippy itself recommends.
    "#[expect(clippy::disallowed_methods)]",
    '#[expect(clippy::disallowed_methods, reason = "stated")]',
    // A reason containing the closing paren that used to end the scan early.
    '#[expect(clippy::disallowed_methods, reason = "a ) inside a string")]',
    // Several lints in one attribute, in both orders.
    "#[allow(clippy::disallowed_methods, clippy::disallowed_types)]",
    "#[allow(unused, clippy::disallowed_methods)]",
    "#[cfg_attr(all(), allow(clippy::disallowed_methods))]",
    // Whitespace where a path separator is expected.
    "#[allow(clippy :: disallowed_methods)]",
    // Lint groups, which take the specific rules with them.
    "#[allow(clippy::all)]",
    "#[allow(warnings)]",
    // Mid-line on a statement, which only `cargo fmt` was keeping off its own
    // line — and `#[rustfmt::skip]` switches that off.
    "fn f() -> u32 { #[allow(clippy::disallowed_methods)] let x = 1; x }",
    "#[rustfmt::skip]\nfn g() { let _ = (); #[allow(clippy::disallowed_types)] let y = 1; let _ = y; }",
    // `#`, `!` and `[` are separate tokens; whitespace between them is legal.
    "# [allow(clippy::disallowed_methods)]",
    "#! [allow(clippy::disallowed_methods)]",
    "#\n[allow(clippy::disallowed_methods)]",
    "# /* still an attribute */ [allow(clippy::disallowed_methods)]",
    // A rustc lint is an escape hatch too, and the strongest one here:
    // `cargo clippy -- -D warnings` is all that enforces "no dead code" on the
    // Rust side, and `#[allow(dead_code)]` switches it off. Three were live in
    // the tree, uncounted, while the gate's own comment read "Every escape
    // hatch is counted, wherever it is."
    "#[allow(dead_code)]",
    "#[allow(unused)]",
    "#[allow(unused_variables, unused_mut)]",
    // The spelling all three of this tree's `dead_code` allowances use.
    '#[cfg_attr(target_os = "macos", allow(dead_code))]',
    '#[cfg_attr(any(target_os = "windows", target_os = "macos"), allow(dead_code))]',
  ];

  for (const form of seen) {
    assert.ok(
      silencedIn(file(form)).length > 0,
      `this silences a clippy lint and was not counted: ${form}`,
    );
  }
});

void test("prose and unrelated attributes are not counted", () => {
  const unseen = [
    // Not an allowance at all: it changes formatting, and silences nothing.
    // (It is still dangerous for a different reason — see `codeOnly`.)
    "#[rustfmt::skip]",
    // Attributes that carry a parenthesised list but are not allowances.
    "#[derive(Debug, Clone)]",
    '#[serde(rename_all = "camelCase")]',
    '#[cfg(target_os = "macos")]',
    // An identifier that merely ends in `allow`.
    "#[shallow(dead_code)]",
    // The files that explain why these attributes are dangerous must not read
    // as users of them. This is why the gate blanks comments rather than
    // anchoring to the start of a line.
    "// #[allow(clippy::disallowed_methods)] — never do this",
    "/// `#[allow(warnings)]` silences everything below it",
    "/* #[allow(clippy::all)] */",
    "/* outer /* nested #[allow(warnings)] */ still a comment */",
    '// # [allow(clippy::all)] with a space, still prose',
    // A string is data, not an attribute.
    'fn s() -> &\'static str { "#[allow(clippy::disallowed_methods)]" }',
    'fn r() -> &\'static str { r#"#[allow(warnings)]"# }',
  ];

  for (const form of unseen) {
    assert.deepEqual(
      silencedIn(file(form)),
      [],
      `this silences nothing and was counted: ${form}`,
    );
  }
});

void test("the lints an attribute silences are read out by name", () => {
  // Names rather than a count, because a count is substitutable: a file
  // entitled to three cast allowances could turn one into `disallowed_methods`
  // without moving the number.
  assert.deepEqual(
    silencedIn(file("#[allow(clippy::disallowed_methods, clippy::disallowed_types)]")),
    ["clippy::disallowed_methods", "clippy::disallowed_types"],
  );
  assert.deepEqual(silencedIn(file("#[allow(unused, warnings)]")), ["unused", "warnings"]);
  // A `reason` is a note, not a lint — and it is the only argument of an
  // allowance that is not one.
  assert.deepEqual(silencedIn(file('#[expect(clippy::disallowed_types, reason = "stated")]')), [
    "clippy::disallowed_types",
  ]);
  // A `cfg_attr` wrapper's own arguments are not lints either.
  assert.deepEqual(silencedIn(file('#[cfg_attr(target_os = "macos", allow(dead_code))]')), [
    "dead_code",
  ]);
});

void test("a directory grant is judged on its resolved recursion flag", () => {
  // The recursive ones. `allow_directory(p, true)` opens every subdirectory of
  // `p` to the webview — on Linux that is the whole picture library.
  const recursive = [
    "scope.allow_directory(dir, true)",
    // A statement in the argument list, which used to make the scan match
    // nothing at all and skip the check entirely.
    "scope.allow_directory(dir, { use std::convert::identity; identity(true) })",
    "scope.allow_directory(dir, std::convert::identity(true))",
    "scope.allow_directory(\n    dir,\n    true,\n)",
    // UFCS never writes the dot.
    "Scope::allow_directory(&scope, dir, true)",
    // `Scope::allow_directory` is generic, so a turbofish is legal between the
    // name and its arguments — and used to make the scan match nothing at all.
    "scope.allow_directory::<&std::path::PathBuf>(dir, true)",
    "scope.allow_directory::<Vec<PathBuf>>(dir, true)",
    "scope.allow_directory :: < &PathBuf > (dir, true)",
  ];
  for (const call of recursive) {
    const [flag, ...rest] = grantsIn(file(`fn f() { let _ = ${call}; }`));
    assert.equal(rest.length, 0, `one call, one grant: ${call}`);
    // The rule the gate applies is "the resolved last argument is the literal
    // `false`", so anything else — `true`, a block, a call that returns one —
    // is refused. Asserted as the gate asks it, not as `=== "true"`: two of
    // these do not reduce to that word and must still be refused.
    assert.notEqual(
      flag,
      "false",
      `this grants recursively and was read as safe: ${call}`,
    );
    assert.ok(flag !== undefined, `no grant was found at all in: ${call}`);
  }

  // And the spellings that are non-recursive, including the multi-line form
  // rustfmt produces, which an earlier version of the rule flagged.
  const safe = [
    "scope.allow_directory(dir, false)",
    "scope.allow_directory(\n    dir,\n    false,\n)",
    "scope.allow_directory(\n    dir,\n    false\n)",
    "scope.allow_directory( dir , false )",
    "Scope::allow_directory(&scope, dir, false)",
    "Scope::allow_directory::<&PathBuf>(&scope, dir, false)",
  ];
  for (const call of safe) {
    assert.deepEqual(
      grantsIn(file(`fn f() { let _ = ${call}; }`)),
      ["false"],
      `this is non-recursive and was read as recursive: ${call}`,
    );
  }

  // Prose naming the function is not a call. Several modules explain why they
  // must never call it.
  assert.deepEqual(grantsIn(file("// never call allow_directory(dir, true)")), []);
});

void test("blanking preserves offsets, so line numbers still line up", () => {
  // Every removed character becomes a space and newlines survive, which is what
  // lets the scans above report a position in the real file.
  const source = 'fn f() {\n    // a comment\n    let s = "text";\n}\n';
  const blanked = codeOnly(source);

  assert.equal(blanked.length, source.length, "the blanked source changed length");
  assert.equal(
    blanked.split("\n").length,
    source.split("\n").length,
    "the blanked source changed line count",
  );
  assert.ok(!blanked.includes("comment"), "a comment survived");
  assert.ok(!blanked.includes("text"), "a string literal survived");
  assert.ok(blanked.includes("let s ="), "code did not survive");
});

void test("blanking preserves line count across an attribute it normalises", () => {
  // The fixture above has no attribute in it, so it passed while the `#`/`[`
  // normalisation was padding with spaces and swallowing the newline between
  // them — a test for an invariant, written so it could not see the one code
  // path that breaks it.
  const source = ["fn a() {}", "#", "[allow(clippy::disallowed_methods)]", "fn b() {}", ""].join(
    "\n",
  );
  const blanked = codeOnly(source);

  assert.equal(blanked.length, source.length, "length changed");
  assert.equal(
    blanked.split("\n").length,
    source.split("\n").length,
    "a newline inside the attribute was padded away",
  );
  assert.deepEqual(silencedIn(source), ["clippy::disallowed_methods"]);
});

void test("a char literal holding a quote does not open a string", () => {
  // `'"'` is a char literal. Read as a quote it would open a string that never
  // closes, and everything after it in the file would go unscanned — including
  // any attribute.
  const source = file("fn c() -> char { '\"' }\n#[allow(clippy::disallowed_methods)]\nfn d() {}");
  assert.deepEqual(silencedIn(source), ["clippy::disallowed_methods"]);
});

void test("an allowance whose lint name cannot be read fails closed", () => {
  // Bypass nine: a macro composes the lint name from tokens the parser never
  // sees, so the harvest came back empty and the allowance table read the file
  // as silencing nothing. Reported as an unreadable name instead, which no
  // table entry matches until someone writes one and says why.
  const composed = [
    "macro_rules! quiet { ($l:ident, $($i:tt)*) => { #[allow(clippy::$l)] $($i)* }; }",
    "fn x() {}",
    "",
  ].join("\n");
  assert.deepEqual(silencedIn(composed), ["<unreadable>"]);

  // A readable name beside an unreadable one is still reported by name, so the
  // table entry for it does not have to be given up.
  assert.deepEqual(silencedIn("macro_rules! q { ($l:ident) => { #[allow(dead_code, $l)] }; }"), [
    "dead_code",
    "<unreadable>",
  ]);
});

void test("a commented-out rule is not a rule", () => {
  // The clippy-configuration gate reads `clippy.toml` and `Cargo.toml` as text.
  // Commenting a rule out left its path present, so the gate passed over a
  // `clippy.toml` that was semantically empty.
  //
  // Asserted through the functions that read the blanked text, on inputs where
  // their answer genuinely depends on the blanking. The first attempt at this
  // was routed through the same callers on inputs where it did not: the
  // commented-out array was `# disallowed-methods = [...]`, which
  // `disallowedIn` anchors past whether or not blanking ran, so `undefined` came
  // back either way. Both replacements passed with the blanking deleted, which
  // is the defect this file exists to catch, in this file.
  //
  // The comment has to carry a comma, and that is the whole subtlety.
  //
  // A comment that *begins* an entry — `# { path = "…" },` on its own line —
  // is skipped whether or not blanking ran: the leading `#` fails the
  // quoted-string and inline-table shapes either way, so both answers are the
  // same and the row asserts nothing. Exactly that input stood here, under a
  // comment claiming the opposite, and deleting the whole `#` branch from
  // `tomlWithoutComments` left this test passing — the second time this file's
  // own rows have been the thing it was written to catch.
  //
  // With a comma, unblanked, the fragment after it *is* a well-formed entry, so
  // the retired rule comes back as a live one and the two answers differ.
  const trailing = [
    "disallowed-methods = [",
    '  "tauri::path::PathResolver::app_data_dir",  # retired, "tauri::path::BaseDirectory",',
    "]",
    "",
  ].join("\n");
  assert.deepEqual(disallowedIn(trailing).get("disallowed-methods"), [
    "tauri::path::PathResolver::app_data_dir",
  ]);

  // A `#` inside a string is data, not a comment — so the rest of the array
  // survives it.
  assert.deepEqual(
    disallowedIn(
      [
        "disallowed-names = [",
        '  "a # inside a basic string",',
        "  'a # in a literal one',",
        '  "kept",',
        "]",
        "",
      ].join("\n"),
    ).get("disallowed-names"),
    ["a # inside a basic string", "a # in a literal one", "kept"],
  );

  // And the newline that ends a comment survives it, which is the invariant
  // `tomlEntries` depends on: it splits on newlines, so a comment that swallowed
  // the break would take the *next* key with it — here, the `allow` the whole
  // lint-configuration gate exists to find.
  assert.equal(
    lintLevelsIn(
      [
        "[lints.clippy]",
        'cast_sign_loss = "warn"  # a note',
        'disallowed_methods = "allow"',
        "",
      ].join("\n"),
    ).get("clippy::disallowed_methods"),
    "allow",
    "a comment swallowed the line after it, hiding an allowance from the gate",
  );
});

void test("a TOML literal string ends at its quote, backslash and all", () => {
  // Literal (single-quoted) strings process no escapes, so a value ending in a
  // backslash ends at the second quote. Treating that backslash as an escape
  // left the scan inside a string for the rest of the file and copied every
  // comment through unblanked — reopening the comment bypass in the same round
  // it was closed, on a value as ordinary as a Windows path.
  //
  // The comment below is what makes that observable, and getting it wrong twice
  // is why it is spelled out. A comment that *begins* an entry is skipped by
  // `disallowedIn` whether or not it was blanked — the leading `#` fails the
  // quoted-string shape either way — so an input like that asserts nothing. The
  // comment here sits after a live entry and carries a comma, so unblanked it
  // splits into a fragment that is a clean quoted string, and the retired rule
  // comes back as a live one.
  const toml = [
    `disallowed-names = ['C:${String.fromCharCode(92)}']`,
    "disallowed-methods = [",
    '  "tauri::path::PathResolver::app_data_dir",  # retired, "tauri::path::BaseDirectory",',
    "]",
    "",
  ].join("\n");

  assert.deepEqual(
    disallowedIn(toml).get("disallowed-methods"),
    ["tauri::path::PathResolver::app_data_dir"],
    "a comment after a literal string ending in a backslash survived",
  );
});

void test("every way of switching a clippy lint off is read as the same setting", () => {
  // Six spellings of one setting, each a live bypass of the `Cargo.toml` half of
  // the directory gate, found and closed one at a time over five rounds because
  // the rule was written as a shape rather than as a key. Cargo honours all of
  // them, so they belong in one table.
  //
  // Whole manifests rather than lines appended to a prelude, because where a
  // dotted key sits is part of what it means: under `[package]`,
  // `lints.clippy.x` is `package.lints.clippy.x` and switches nothing off.
  const head = ["[package]", 'name = "shotshelf"', ""];
  const off = [
    [...head, "[lints.clippy]", 'disallowed_methods = "allow"'],
    // Cargo takes a level table, and TOML takes either quote.
    [...head, "[lints.clippy]", "disallowed_methods = { level = 'allow', priority = 1 }"],
    // A dotted key inside the table says the same as the table form.
    [...head, "[lints.clippy]", 'disallowed_methods.level = "allow"'],
    // A header need not sit at column 0, and may have spaces in its brackets.
    [...head, " [lints.clippy]", ' disallowed_methods = "allow"'],
    [...head, "[ lints.clippy ]", 'disallowed_methods = "allow"'],
    // Whitespace and quoting *inside* the header, which had rows for the dotted
    // key and none for the header itself. `dotted()` normalises both, and
    // replacing it with a bare `trim()` left every gate green while
    // `disallowed_methods = "allow"` under either of these switched the
    // roaming-profile rule off with the gate reporting success. Both are valid
    // TOML and Cargo honours both.
    [...head, "[lints . clippy]", 'disallowed_methods = "allow"'],
    [...head, '[lints."clippy"]', 'disallowed_methods = "allow"'],
    [...head, "[lints.'clippy']", 'disallowed_methods = "allow"'],
    [...head, '[ lints . "clippy" ]', 'disallowed_methods = "allow"'],
    // The sub-table spelling: the header itself names the lint.
    [...head, "[lints.clippy.disallowed_methods]", 'level = "allow"'],
    [...head, " [lints.clippy.disallowed_methods]", ' level = "allow"'],
    // And no table at all — which has to come before every header to mean this.
    ['lints.clippy.disallowed_methods = "allow"', ...head],
    ['lints.clippy.disallowed_methods = { level = "allow" }', ...head],
    ['lints.clippy."disallowed_methods" = "allow"', ...head],
    ["lints . clippy . disallowed_methods = 'allow'", ...head],
  ];

  for (const lines of off) {
    assert.equal(
      lintLevelsIn([...lines, ""].join("\n")).get("clippy::disallowed_methods"),
      "allow",
      `this switches the lint off and was not read as "allow": ${lines.join(" / ")}`,
    );
  }

  // The same characters under another table are another key and switch nothing
  // off. Reading the manifest as one flat text called this a bypass and failed a
  // manifest that was correct.
  assert.equal(
    lintLevelsIn([...head, 'lints.clippy.disallowed_methods = "allow"', ""].join("\n")).get(
      "disallowed_methods",
    ),
    undefined,
    "`package.lints.clippy.x` was read as `lints.clippy.x`",
  );
});

void test("a level is read under the table it was set in, whichever tool owns it", () => {
  // Every `[lints.*]` table, keyed the way an attribute would name the lint:
  // `clippy::x` for clippy's, bare `x` for the toolchain's own.
  //
  // This read `lints.clippy` only, and its title said so approvingly. Four
  // lines of `[lints.rust] dead_code = "allow"` then switched off the one thing
  // enforcing "no dead code" in the crate — crate-wide, with clippy and the
  // directory gate both green — while the attribute half had just been widened
  // to count `#[allow(dead_code)]` as the strongest escape hatch there is.
  //
  // The widening shipped with no row here at all: narrowing the pattern back to
  // `^lints\.(clippy)\.` left all 127 unit tests and the whole deadcode chain
  // green. The probes existed in a scratch file and a commit message, which is
  // the exact failure the header of this file was written about.
  const manifest = [
    "[lints.rust]",
    'unsafe_code = "forbid"',
    'dead_code = "allow"',
    'cast_sign_loss = "allow"',
    "",
    "[lints.clippy]",
    'cast_sign_loss = "warn"',
    "",
    "[lints.rustdoc]",
    'broken_intra_doc_links = "allow"',
    "",
    "[workspace.lints.clippy]",
    'cast_precision_loss = "allow"',
    "",
  ].join("\n");
  const levels = lintLevelsIn(manifest);

  // The toolchain's own lints, under the names an attribute uses for them.
  assert.equal(levels.get("dead_code"), "allow", "a rustc lint was not read at all");
  assert.equal(levels.get("unsafe_code"), "forbid");
  // A tool's lints keep their prefix, so the two `cast_sign_loss` entries are
  // two different lints and neither takes the other's level.
  assert.equal(levels.get("clippy::cast_sign_loss"), "warn");
  assert.equal(levels.get("cast_sign_loss"), "allow");
  // Any tool, not a list of two.
  assert.equal(levels.get("rustdoc::broken_intra_doc_links"), "allow");

  // A different table is a different key: `[workspace.lints.clippy]` is the
  // workspace's, not this crate's.
  assert.equal(levels.get("clippy::cast_precision_loss"), undefined);

  // A commented-out level is not a level.
  assert.equal(
    lintLevelsIn(["[lints.rust]", '# dead_code = "allow"', ""].join("\n")).get("dead_code"),
    undefined,
  );

  // And every spelling that worked for clippy works for the toolchain too —
  // this was widened by generalising the key, not by adding a second pattern.
  for (const lines of [
    ["[lints.rust]", 'dead_code = { level = "allow", priority = 1 }'],
    ["[lints.rust.dead_code]", 'level = "allow"'],
    [" [ lints.rust ]", ' dead_code = "allow"'],
    ['lints.rust.dead_code = "allow"'],
  ]) {
    assert.equal(
      lintLevelsIn([...lines, ""].join("\n")).get("dead_code"),
      "allow",
      `this switches the lint off and was not read as "allow": ${lines.join(" / ")}`,
    );
  }
});

void test("a disallowed path is read from the array it has to be in", () => {
  // The gate asked whether the file contained the path *anywhere*. Moving
  // `BaseDirectory` from `disallowed-types` — the only array where clippy
  // matches a type — into the methods list, or into a neighbouring `reason`,
  // left every character of the old check's evidence in place with the rule
  // gone.
  const toml = [
    "disallowed-methods = [",
    '  { path = "tauri::path::PathResolver::app_data_dir", reason = "roaming" },',
    // The keys of an inline table are unordered, so the path is read by name
    // rather than by position.
    '  { reason = "go through `dirs::local`", path = "tauri::path::PathResolver::app_local_data_dir" },',
    '  "shotshelf_lib::dirs::preferences",',
    "]",
    "",
    "disallowed-types = [",
    '  { path = "tauri::path::BaseDirectory", reason = "names tauri::path::PathResolver::app_cache_dir" },',
    "]",
    "",
  ].join("\n");
  const arrays = disallowedIn(toml);

  assert.deepEqual(arrays.get("disallowed-methods"), [
    "tauri::path::PathResolver::app_data_dir",
    "tauri::path::PathResolver::app_local_data_dir",
    "shotshelf_lib::dirs::preferences",
  ]);
  assert.deepEqual(arrays.get("disallowed-types"), ["tauri::path::BaseDirectory"]);

  // A path quoted in the prose beside a rule is not a rule. This is the
  // relocation bypass in its quietest form: the reason above names a method that
  // is no longer disallowed anywhere.
  assert.ok(
    !(arrays.get("disallowed-methods") ?? []).includes("tauri::path::PathResolver::app_cache_dir"),
    "a path named in a `reason` was counted as a rule",
  );

  // And a commented-out array holds nothing, however complete it looks.
  const silenced = disallowedIn(
    ["disallowed-types = [", '  # { path = "tauri::path::BaseDirectory" },', "]", ""].join("\n"),
  );
  assert.deepEqual(silenced.get("disallowed-types"), []);
});

void test("a cargo config that weakens a lint is read as weakening it", () => {
  // The third place a clippy level comes from, and the gate read neither of the
  // first two spellings of it. A four-line .cargo/config.toml at the repo
  // root switched off the resolved-path half of the roaming-profile rule with
  // `cargo clippy -- -D warnings` printing "Finished" and the directory gate
  // printing success, while a module alias wrote the diagnostic log into
  // `%APPDATA%`.
  const weakening = [
    ['[build]', 'rustflags = ["-Aclippy::disallowed_methods"]'],
    ["[build]", 'rustflags = ["-A", "clippy::disallowed_methods"]'],
    ["[build]", 'rustflags = ["--allow=clippy::disallowed_types"]'],
    ["[build]", 'rustflags = ["--allow", "warnings"]'],
    ["[build]", 'rustdocflags = ["-Awarnings"]'],
    // Not under `[build]` at all: cargo takes these per target and from `[env]`.
    ["[target.'cfg(all())']", 'rustflags = ["-Aclippy::disallowed_methods"]'],
    ["[env]", 'RUSTFLAGS = "-Aclippy::disallowed_methods"'],
    // Caps every lint in the crate at once, naming none of them.
    ["[build]", 'rustflags = ["--cap-lints", "allow"]'],
    // Downgrades a `deny` without spelling `allow`.
    ["[build]", 'rustflags = ["--force-warn=clippy::disallowed_methods"]'],
  ];

  for (const lines of weakening) {
    const config = [...lines, ""].join("\n");
    assert.ok(
      weakeningFlagsIn(config).length > 0,
      `this weakens a lint and was not read as weakening: ${lines.join(" / ")}`,
    );
  }

  // The flag is reported with what it names, so the message can say which rule
  // went away rather than just that something did.
  assert.deepEqual(weakeningFlagsIn('rustflags = ["-Aclippy::disallowed_methods"]'), [
    "-A clippy::disallowed_methods",
  ]);
});

void test("a cargo config that hardens or says nothing is left alone", () => {
  const fine = [
    // Hardenings. `-D` is what the gate itself runs with.
    'rustflags = ["-Dwarnings"]',
    'rustflags = ["--deny", "clippy::disallowed_methods"]',
    'rustflags = ["--forbid=unsafe_code"]',
    // Ordinary configuration.
    '[build]\ntarget-dir = "target"',
    '[target.x86_64-pc-windows-msvc]\nlinker = "rust-lld.exe"',
    // A flag whose name merely ends in one of ours.
    'rustflags = ["-Zself-profile"]',
    'rustflags = ["--remap-path-prefix=/a=/b"]',
    // And a commented-out weakening is not in force.
    '[build]\n# rustflags = ["-Aclippy::disallowed_methods"]',
    // A hash inside a string is not a comment, so this one *is* still live —
    // covered by the weakening test above; here we only check the article of
    // faith that ordinary strings survive.
    'linker = "a # inside a string"',
  ];

  for (const config of fine) {
    assert.deepEqual(
      weakeningFlagsIn(config),
      [],
      `this weakens nothing and was reported: ${config}`,
    );
  }
});

void test("a type that serialises to the webview is found at any visibility", () => {
  // These names are half the IPC contract, so the manifest has to be complete —
  // and the gate that keeps it complete matched `pub struct` alone for a round,
  // under a header claiming it "asks the crate which types serialise". Every
  // module in the crate is private, so `pub(crate)` is the natural visibility
  // and nothing pushes an author toward `pub`; the widening that fixed it then
  // shipped with nothing asserting it, which is what this file is for.
  const found = [
    "#[derive(Serialize)]\npub struct Plain { a: u8 }",
    "#[derive(serde::Serialize)]\npub(crate) struct Crate { a: u8 }",
    "#[derive(Serialize)]\nstruct Private { a: u8 }",
    "#[derive(Serialize)]\npub(super) struct Super { a: u8 }",
    // Several derives, in any order.
    "#[derive(Debug, Clone, Serialize, Deserialize)]\npub struct Plain { a: u8 }",
    "#[derive(Deserialize, Serialize)]\npub struct Plain { a: u8 }",
    // Attributes between the derive and the keyword.
    '#[derive(Serialize)]\n#[serde(rename_all = "camelCase")]\npub struct Plain { a: u8 }',
    '#[derive(Serialize)]\n#[serde(default)]\n#[serde(deny_unknown_fields)]\npub struct Plain { a: u8 }',
    // A docstring long enough to blow any fixed character budget between the
    // two — the shape the first version used.
    `#[derive(Serialize)]\n${"/// prose that runs on and on and on and on and on\n".repeat(8)}pub struct Plain { a: u8 }`,
  ];

  for (const source of found) {
    assert.equal(
      serialisingStructsIn(source).length,
      1,
      `this reaches the webview and was not found: ${source.slice(0, 60)}`,
    );
  }

  // Both names, when a file holds two.
  assert.deepEqual(
    serialisingStructsIn(
      "#[derive(Serialize)]\npub struct One { a: u8 }\n\n#[derive(Serialize)]\npub(crate) struct Two { b: u8 }\n",
    ),
    ["One", "Two"],
  );
});

void test("a type that does not serialise is left out of the manifest", () => {
  const ignored = [
    // Reading is not writing: `Deserialize` alone crosses nothing outward.
    "#[derive(Deserialize)]\npub struct Read { a: u8 }",
    "#[derive(Debug, Clone)]\npub struct Plain { a: u8 }",
    "pub struct Bare { a: u8 }",
    // An enum's *values* are joined by their own fixtures, not by field names.
    "#[derive(Serialize)]\npub enum Kind { A, B }",
    // A name that merely contains the word.
    "#[derive(SerializeDisplay)]\npub struct Plain { a: u8 }",
    "#[derive(DeserializeOwned)]\npub struct Plain { a: u8 }",
    // Prose about the derive is not the derive. This is why the scan runs over
    // `codeOnly` output rather than raw text.
    "// #[derive(Serialize)]\n// pub struct Documented { a: u8 }",
    '/// A `#[derive(Serialize)] pub struct Quoted` in a docstring.\npub struct Real { a: u8 }',
  ];

  for (const source of ignored) {
    assert.deepEqual(
      serialisingStructsIn(source),
      [],
      `this serialises nothing and was found: ${source.slice(0, 60)}`,
    );
  }
});

void test("a number is quoted as a number, not as digits inside a longer one", () => {
  // `docs/USAGE.md` promises six values the code decides, and this is what
  // holds the guide to them. The rule started as a bare `RegExp(value)`, which
  // finds 20 inside 2048 — no effect on today's guide, and a hole the moment a
  // longer number appears near a retired one, which is exactly when nobody is
  // looking.
  //
  // Here rather than in `check-references.mjs`, which runs its gate at import
  // time and so cannot be imported to test a rule.
  assert.ok(quotesNumber("a launch brings back **up to 20** captures", 20));
  assert.ok(quotesNumber("no larger than 1568px on its long edge", 1568));
  assert.ok(quotesNumber("it passes 512 KB.", 512));
  assert.ok(quotesNumber("up to 5) rather than overwriting it", 5));

  // Not inside a longer number, in either direction.
  assert.ok(!quotesNumber("a 2048-byte header", 20));
  assert.ok(!quotesNumber("a 2048-byte header", 48));
  assert.ok(!quotesNumber("sized to 1568px", 156));
  // Nor across a decimal point, which is how a version string would read.
  assert.ok(!quotesNumber("ffmpeg 6.1.1", 1));
  assert.ok(!quotesNumber("scaled by 0.60", 60));

  // And absent is absent.
  assert.ok(!quotesNumber("the guide says nothing about it", 60));
});
