// Every file, symbol and test a comment names must exist.
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

import { globSync, readFileSync } from "node:fs";
import path from "node:path";

const SOURCE_GLOBS = [
  "src/**/*.ts",
  "src-tauri/src/**/*.rs",
  "tests/**/*.ts",
  "scripts/*.mjs",
  "*.md",
  "docs/**/*.md",
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
  if (file.endsWith(".md")) return source;

  const comments = [];
  // Block comments, including Rust's and JSDoc.
  for (const match of source.matchAll(/\/\*[\s\S]*?\*\//g)) comments.push(match[0]);
  // Line comments. The `[^:]` guard keeps `https://…` inside code out of it.
  for (const match of source.matchAll(/(?:^|[^:])(\/\/[^\n]*)/g)) comments.push(match[1]);
  return comments.join("\n");
}

/** Every file in the repo, by basename, for resolving a bare mention. */
function repoFiles() {
  const byName = new Map();
  const all = globSync("**/*", {
    exclude: (entry) =>
      entry.includes("node_modules") ||
      entry.includes(`${path.sep}target${path.sep}`) ||
      entry.startsWith("target") ||
      entry.includes(".git") ||
      entry.includes("test-results") ||
      entry.includes("dist"),
  });

  for (const entry of all) {
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
