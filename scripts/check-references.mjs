// Three kinds of thing a comment names must actually exist.
//
// Not "every file, symbol and test", which is what this said and could not
// deliver: TypeScript symbols are never checked at all, and TS symbol
// references are most of what this codebase's comments are made of. The three
// rules below are the whole of it, and the headline should not promise past
// them — a gate against overclaiming that overclaims is not a good look.
//
// This repository's most persistent defect is not a bug in the code. Across
// eight review rounds the single recurring finding has been *comments and docs
// asserting properties the code does not have* — a docstring claiming a
// division the function never did, a module pointing at a webview_path helper
// that has never existed, a test comment describing a clamp its stub could not
// produce, a docs table naming a screenshot that was never committed.
//
// Nothing in this repo could see any of it. `eslint`, `tsc`, `clippy` and
// `knip` all stop at the comment marker; a comment is the one place where a
// statement about the code is never checked against the code. That is exactly
// where false claims accumulate, and they are worse than no comment at all,
// because the next person reads them and believes them.
//
// A gate cannot decide whether prose is *true*. It can decide whether the
// things prose names are *real*, which is the mechanically checkable subset —
// and it is the subset that actually produced the findings above. Three rules:
//
//   A. A backticked path that refers to a file *in this repository* must
//      resolve to one.
//   B. A backticked module::item reference must name an item that module
//      actually defines.
//   C. A backticked spec file followed by a quoted title must name a test that
//      file declares — so "this behaviour is gated by X" is a claim that can
//      fail rather than a reassurance nobody checks.
//
// Deliberately conservative. A gate that fires on ordinary prose gets
// suppressed and then ignored, so every rule requires backticks — an explicit
// "this is a code reference" from the author — and anything ambiguous is
// skipped rather than guessed at.

import { execFileSync } from "node:child_process";
import { globSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Everything whose comments make claims about this repository.
 *
 * The config files were missing and are among the worst offenders:
 * `playwright.config.ts` names `tests/harness/tauri-mock.ts`, `tauri.conf.json`
 * and `window.rs` in backticks and makes exactly the cross-file claims this
 * gate exists to check, and `Cargo.toml` cited a research note in a directory
 * no clone has. A gate that reads only the files most likely to be careful is
 * a gate aimed away from the problem.
 */
const SOURCE_GLOBS = [
  "src/**/*.ts",
  "src/**/*.css",
  "src-tauri/src/**/*.rs",
  "src-tauri/build.rs",
  "src-tauri/*.toml",
  "tests/**/*.ts",
  "scripts/*.mjs",
  "*.md",
  "docs/**/*.md",
  "*.config.ts",
  "*.config.js",
  ".github/workflows/*.yml",
  "index.html",
];

/**
 * Extensions that make a backticked token a claim about a file.
 *
 * Split in two, because most of what looks like a filename in these comments
 * is not one of ours. `Screenshot.png` is an example of what a capture tool
 * names its output; `settings.json` is a file on the user's disk. Demanding
 * those exist here would be wrong, and suppressing the rule to allow them
 * would blunt it.
 *
 * So: source files are checked wherever they are named, because a bare
 * `poster.rs` is unambiguously this repository's. Everything else is only
 * checked when the reference carries a directory: a picture named with its
 * folder is a claim about this repository in a way that a bare filename,
 * which is just as likely to be an example, is not.
 */
const SOURCE_FILE = /\.(ts|tsx|mjs|rs)$/;
const DATA_FILE = /\.(js|json|css|html|md|png|svg|yml|yaml|toml|ico|icns)$/;

/**
 * A path on the user's machine rather than a path in this repository.
 *
 * Absolute in any of the four ways these comments write one: a Windows drive,
 * a UNC or Windows-separated path, a POSIX root, a home-relative path, or an
 * environment variable.
 */
const NOT_OURS = /^(?:[A-Za-z]:|\\|\/|~|%|\$)/;

/**
 * Rust items a `module::item` reference may name.
 *
 * Not just `fn`: the references that appear in practice point at constants and
 * types as often as functions, and a rule that only knew about functions would
 * have to be suppressed for the rest — which is how a gate stops being one.
 */
const RUST_ITEM = (item) =>
  new RegExp(
    `(?:^|\\s)(?:pub(?:\\([^)]*\\))?\\s+)?(?:async\\s+)?` +
      `(?:fn|struct|enum|const|static|type|trait|mod|union)\\s+${item}\\b`,
    "m",
  );

/**
 * Comment text only.
 *
 * The rules must not see string literals: `invoke("save_edit")` is code, and
 * `"…"` inside it is data, not a claim about the codebase. Markdown is prose
 * throughout, so it is taken whole.
 */
function commentsIn(file, source) {
  if (file.endsWith(".md")) return unwrap(source);
  if (file.endsWith(".toml") || file.endsWith(".yml") || file.endsWith(".yaml")) {
    return unwrap(
      [...source.matchAll(/(?:^|\s)(#[^\n]*)/g)].map((match) => match[1]).join("\n"),
    );
  }
  if (file.endsWith(".html")) {
    return unwrap([...source.matchAll(/<!--[\s\S]*?-->/g)].map((match) => match[0]).join("\n"));
  }
  if (file.endsWith(".css")) {
    return unwrap([...source.matchAll(/\/\*[\s\S]*?\*\//g)].map((match) => match[0]).join("\n"));
  }

  const comments = [];
  // Block comments, including Rust's and JSDoc.
  for (const match of source.matchAll(/\/\*[\s\S]*?\*\//g)) comments.push(match[0]);
  // Line comments, gathered into *runs* of consecutive lines.
  //
  // One run is one comment. Collecting each `//` line separately was the
  // second half of why Rule C matched nothing: unwrapping a single line
  // returns that line, so a paragraph written as six `//` lines stayed six
  // lines however well the unwrapper worked. Rust and TypeScript here write
  // nearly every explanation this way.
  comments.push(...lineCommentRuns(source));
  // Unwrapped individually, so a title can never pair with a spec name from a
  // different comment.
  return comments.map(unwrap).join("\n");
}

/**
 * Consecutive `//` lines, joined into one comment each.
 *
 * A blank line or any line of code ends the run, which is the same boundary a
 * reader sees: two paragraphs separated by code are two claims, and a title
 * from one must not pair with a filename from the other.
 */
function lineCommentRuns(source) {
  const runs = [];
  let current = [];

  for (const raw of source.split("\n")) {
    // The `[^:]` guard keeps `https://…` inside code out of it.
    const found = /(?:^|[^:])(\/\/.*)$/.exec(raw);
    if (found?.[1]) {
      current.push(found[1]);
    } else if (current.length > 0) {
      runs.push(current.join("\n"));
      current = [];
    }
  }

  if (current.length > 0) runs.push(current.join("\n"));
  return runs;
}

/**
 * Put a wrapped comment back onto one line per paragraph.
 *
 * This is the difference between a rule that fires and a rule that does not,
 * and it was missing. Rule C matched a spec name and a quoted title only on
 * the *same line*; this repo wraps comments at about 76 columns, so the one
 * comment in the tree written in that shape — the "Gated by" note in
 * `src/editor/index.ts`, naming the second-crop spec — spanned two lines and
 * matched nothing. The rule fired on a planted one-line probe, which is how it
 * came to be believed: it worked in the only shape the codebase never uses. A
 * gate that reports green because its input is the wrong shape is the exact
 * failure this gate exists to catch, so it is fixed where the shape is decided
 * rather than by loosening the pattern.
 *
 * Blank lines stay blank, so paragraphs remain separate: a title in one
 * paragraph must not pair with a filename in another.
 */
function unwrap(block) {
  const paragraphs = [];
  let current = [];

  for (const raw of block.split("\n")) {
    const line = raw
      // Leaders: `//`, `///`, `//!`, `/*`, `*`, `*/`, `#`, `<!--`, `-->`.
      .replace(/^\s*(?:\/\/[!/]?|\/\*+|\*+\/?|#+|<!--|-->)\s?/, "")
      .replace(/(?:\*\/|-->)\s*$/, "")
      .trim();

    if (line === "") {
      if (current.length > 0) paragraphs.push(current.join(" "));
      current = [];
    } else {
      current.push(line);
    }
  }

  if (current.length > 0) paragraphs.push(current.join(" "));
  return paragraphs.join("\n");
}

/**
 * Every **tracked** file, by basename.
 *
 * `git ls-files`, not a glob of the working tree, and the difference is the
 * whole point. Globbing resolved references against files git does not
 * track — `prompts/` and `reference/` are git-ignored and present on the
 * author's machine, `src-tauri/binaries/` holds an 82 MB local ffmpeg — so a
 * comment pointing into one of them passed here and would fail on any other
 * clone and in CI. A gate whose verdict depends on untracked files is a gate
 * that answers a different question on every machine.
 */
function repoFiles() {
  const byName = new Map();
  const listed = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" });

  for (const entry of listed.split("\0")) {
    if (entry === "") continue;
    const name = path.basename(entry);
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(entry);
  }
  return byName;
}

/** Rust modules by name, so `poster::cached` can be resolved. */
function rustModules() {
  const modules = new Map();
  for (const file of globSync("src-tauri/src/**/*.rs")) {
    const name = path.basename(file, ".rs");
    // `mod.rs` is named by its directory.
    const key = name === "mod" ? path.basename(path.dirname(file)) : name;
    modules.set(key, file);
  }
  return modules;
}

const files = repoFiles();
const modules = rustModules();
const problems = [];

function report(file, reference, why) {
  problems.push(`  ${file}: \`${reference}\` — ${why}`);
}

for (const file of SOURCE_GLOBS.flatMap((glob) => globSync(glob))) {
  const source = readFileSync(file, "utf8");
  const prose = commentsIn(file, source);

  // ── Rule A and B: every backticked reference ─────────────────────────────
  for (const [, reference] of prose.matchAll(/`([^`\n]+)`/g)) {
    const token = reference.trim();

    const named = token.replace(/^\.\//, "");
    const isPath = named.includes("/");
    const claimsOurFile =
      !token.includes(" ") &&
      !NOT_OURS.test(named) &&
      !named.includes("\\") &&
      (SOURCE_FILE.test(named) || (DATA_FILE.test(named) && isPath));

    if (claimsOurFile) {
      const candidates = files.get(path.basename(named)) ?? [];
      const exists = isPath
        ? candidates.some((found) => found.replaceAll("\\", "/").endsWith(named))
        : candidates.length > 0;
      if (!exists) report(file, token, "no such file in the repository");
      continue;
    }

    // `module::item`, Rust's own way of naming a thing somewhere else.
    const rust = /^([a-z_][a-z0-9_]*)::([A-Za-z_][A-Za-z0-9_]*)$/.exec(token);
    if (rust) {
      const [, module, item] = rust;
      const source_file = modules.get(module);
      // An unknown module is not necessarily wrong — `std::fs`, `tauri::ipc`
      // and every dependency look identical to ours from here.
      if (!source_file) continue;
      if (!RUST_ITEM(item).test(readFileSync(source_file, "utf8"))) {
        report(file, token, `${source_file} defines no \`${item}\``);
      }
    }
  }

  // ── Rule C: a spec file, then a quoted test title ────────────────────────
  //
  // The shape a comment uses to say "this behaviour is gated". Matching the
  // pair rather than the title alone is what keeps it precise: a quoted string
  // anywhere near a comment is usually a message, not a test name.
  for (const [, spec, title] of prose.matchAll(
    /`([\w./-]+\.spec\.ts)`[^\n]{0,80}?[""]([^""\n]{6,})[""]/g,
  )) {
    const candidates = files.get(path.basename(spec)) ?? [];
    if (candidates.length === 0) continue; // Rule A already reported it.
    const declared = candidates.some((candidate) =>
      readFileSync(candidate, "utf8").includes(title),
    );
    if (!declared) report(file, `${spec} → "${title}"`, "that file declares no such test");
  }
}

if (problems.length > 0) {
  console.error(
    "\nComments naming things that do not exist:\n" +
      problems.join("\n") +
      "\n\nA comment is the one statement about this code that nothing else " +
      "checks. Fix the reference, or fix the comment — but a stale one is " +
      "read and believed.",
  );
  process.exit(1);
}

console.info(`Checked comment references across ${SOURCE_GLOBS.length} source trees.`);
