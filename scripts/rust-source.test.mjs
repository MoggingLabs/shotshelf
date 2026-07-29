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

import { codeOnly, grantsIn, silencedIn } from "./rust-source.mjs";

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
    // Not a clippy lint, and not `warnings`: nothing in `clippy.toml` is
    // switched off by it.
    "#[allow(dead_code)]",
    "#[rustfmt::skip]",
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
  assert.deepEqual(silencedIn(file("#[allow(unused, warnings)]")), ["warnings"]);
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

void test("a char literal holding a quote does not open a string", () => {
  // `'"'` is a char literal. Read as a quote it would open a string that never
  // closes, and everything after it in the file would go unscanned — including
  // any attribute.
  const source = file("fn c() -> char { '\"' }\n#[allow(clippy::disallowed_methods)]\nfn d() {}");
  assert.deepEqual(silencedIn(source), ["clippy::disallowed_methods"]);
});
