/**
 * The forms the directory gate must see, and the forms it must not.
 *
 * These three parsers had no test of any kind for seven review rounds, and in
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
  clippyLevelsIn,
  codeOnly,
  disallowedIn,
  grantsIn,
  silencedIn,
  tomlWithoutComments,
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

void test("TOML comments are blanked, and only real comments", () => {
  // The clippy-configuration gate reads `clippy.toml` and `Cargo.toml` as text.
  // Commenting every rule out left all of their paths present, so the gate
  // passed over a `clippy.toml` that was semantically empty.
  const source = [
    "disallowed-methods = [",
    '  "tauri::path::PathResolver::app_data_dir",  # a note',
    "]",
    '# disallowed-types = ["tauri::path::BaseDirectory"]',
    'name = "a # inside a basic string"',
    "literal = 'a # inside a literal string'",
    "",
  ].join("\n");
  const blanked = tomlWithoutComments(source);

  assert.equal(blanked.length, source.length, "length changed");
  assert.equal(
    blanked.split("\n").length,
    source.split("\n").length,
    "line count changed",
  );
  assert.ok(blanked.includes("app_data_dir"), "a live rule was blanked");
  assert.ok(!blanked.includes("BaseDirectory"), "a commented-out rule survived");
  assert.ok(blanked.includes("inside a basic string"), "a hash in a string ended the line");
  assert.ok(blanked.includes("inside a literal string"), "a hash in a literal string did too");
});

void test("a TOML literal string ends at its quote, backslash and all", () => {
  // Literal (single-quoted) strings process no escapes, so a value ending in a
  // backslash ends at the second quote. Treating that backslash as an escape
  // left the scan inside a string for the rest of the file and copied every
  // comment through unblanked — reopening the comment bypass in the same round
  // it was closed, on a value as ordinary as a Windows path.
  const source = [
    "disallowed-names = ['C:" + String.fromCharCode(92) + "']",
    '# disallowed-methods = ["tauri::path::PathResolver::app_data_dir"]',
    "",
  ].join("\n");

  assert.ok(
    !tomlWithoutComments(source).includes("app_data_dir"),
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
      clippyLevelsIn([...lines, ""].join("\n")).get("disallowed_methods"),
      "allow",
      `this switches the lint off and was not read as "allow": ${lines.join(" / ")}`,
    );
  }

  // The same characters under another table are another key and switch nothing
  // off. Reading the manifest as one flat text called this a bypass and failed a
  // manifest that was correct.
  assert.equal(
    clippyLevelsIn([...head, 'lints.clippy.disallowed_methods = "allow"', ""].join("\n")).get(
      "disallowed_methods",
    ),
    undefined,
    "`package.lints.clippy.x` was read as `lints.clippy.x`",
  );
});

void test("a clippy level is read from the clippy table and nowhere else", () => {
  // `[lints.rust]` holds levels for lints of its own, and a level set under any
  // other table is not this one. Reading the manifest as one flat text would
  // take the first `= "warn"` it found wherever it sat.
  const manifest = [
    "[lints.rust]",
    'unsafe_code = "forbid"',
    'cast_sign_loss = "allow"',
    "",
    "[lints.clippy]",
    'cast_sign_loss = "warn"',
    "",
    "[workspace.lints.clippy]",
    'cast_precision_loss = "allow"',
    "",
  ].join("\n");
  const levels = clippyLevelsIn(manifest);

  assert.equal(levels.get("cast_sign_loss"), "warn", "a rustc lint's level was taken for clippy's");
  assert.equal(levels.get("unsafe_code"), undefined, "a rustc lint was reported as a clippy one");
  assert.equal(
    levels.get("cast_precision_loss"),
    undefined,
    "a level under `[workspace.lints.clippy]` is a different table",
  );

  // A commented-out level is not a level.
  assert.equal(
    clippyLevelsIn(["[lints.clippy]", '# cast_sign_loss = "allow"', ""].join("\n")).get(
      "cast_sign_loss",
    ),
    undefined,
  );
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
  // first two spellings of it. A four-line a .cargo/config.toml at the repo
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
