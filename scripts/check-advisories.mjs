// The advisories this tree carries, held to the set someone actually decided about.
//
// `SECURITY.md` carried a hand-written section headed "One open advisory,
// carried knowingly". `cargo audit` reports **eighteen**: one unsoundness — the
// one that section names — and seventeen unmaintained crates, almost all of
// Tauri's GTK3 stack. Nothing was wrong with the reasoning about the one; what
// was wrong is that a human list of a moving set is a list that is right on the
// day it is written and slowly stops being right afterwards, with no signal.
//
// So the list moves into a fixture and this compares against it, both ways:
//
//   - An advisory `cargo audit` reports that the fixture does not name is new.
//     Someone has to look at it and either fix it or write down why not.
//   - An advisory the fixture names that `cargo audit` no longer reports has
//     **cleared**. That is the good direction and it still fails, because the
//     glib entry is documented as "will clear when Tauri updates" and nothing
//     was watching for the day it did.
//
// A *vulnerability* is never accepted here. `cargo audit` currently reports
// zero, the fixture's `vulnerabilities` array is empty, and anything landing in
// that category fails no matter what the fixture says — it belongs fixed.
//
// Not part of `npm run gate`, deliberately. This needs `cargo audit` installed
// and the RUSTSEC database fetched over the network, and the gate is meant to
// run offline on a laptop. `.github/workflows/audit.yml` runs it weekly and
// whenever a lockfile changes, which is when the answer can actually differ.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const FIXTURE = "tests/fixtures/known-advisories.json";

const known = JSON.parse(readFileSync(FIXTURE, "utf8"));
const accepted = new Set([...Object.keys(known.unsound ?? {}), ...Object.keys(known.unmaintained ?? {})]);

let report;
try {
  report = JSON.parse(
    execFileSync("cargo", ["audit", "--file", "src-tauri/Cargo.lock", "--json"], {
      encoding: "utf8",
      // `cargo audit` exits non-zero whenever it reports anything, which is the
      // normal state here — the findings are on stdout either way.
      stdio: ["ignore", "pipe", "ignore"],
    }),
  );
} catch (error) {
  // A non-zero exit still carries the JSON; anything else is a real failure.
  if (error.stdout) {
    report = JSON.parse(error.stdout);
  } else {
    console.error(
      `\nCould not run \`cargo audit\`: ${error.message}\n` +
        `Install it with \`cargo install cargo-audit --locked\`.`,
    );
    process.exit(2);
  }
}

const problems = [];

// A vulnerability is not something the fixture gets to accept.
const vulnerabilities = report.vulnerabilities?.list ?? [];
for (const found of vulnerabilities) {
  problems.push(
    `  ${found.advisory.id} — VULNERABILITY in ${found.package.name} ${found.package.version}: ` +
      `${found.advisory.title}. This is not an accepted-warning category; fix or upgrade it.`,
  );
}

/** Every warning id `cargo audit` reported, whatever its kind. */
const reported = new Map();
for (const [kind, list] of Object.entries(report.warnings ?? {})) {
  for (const warning of list ?? []) {
    reported.set(warning.advisory.id, `${kind}: ${warning.package.name} ${warning.package.version}`);
  }
}

for (const [id, where] of reported) {
  if (!accepted.has(id)) {
    problems.push(
      `  ${id} — new advisory (${where}), not in ${FIXTURE}. ` +
        `Decide about it, then record it there and in SECURITY.md.`,
    );
  }
}

for (const id of accepted) {
  if (!reported.has(id)) {
    problems.push(
      `  ${id} — CLEARED: ${FIXTURE} still carries it but \`cargo audit\` no longer reports it. ` +
        `Take it out of the fixture, and out of SECURITY.md if it is named there.`,
    );
  }
}

if (problems.length > 0) {
  console.error(`\nThe advisory set has changed:\n${problems.join("\n")}\n`);
  process.exit(1);
}

console.info(
  `Checked ${reported.size} known advisories and ${vulnerabilities.length} vulnerabilities ` +
    `against ${FIXTURE}.`,
);
