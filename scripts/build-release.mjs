// Produces the installers, signed if the machine has what it needs to sign.
//
// Signing material never lives in the repo: everything comes from environment
// variables, and a build with none of them set still succeeds — it just emits
// unsigned artifacts, which is what you want for a local smoke test.
//
//   node scripts/build-release.mjs [--unsigned]
//
// Windows (Authenticode):
//   WINDOWS_CERT_THUMBPRINT   thumbprint of a cert in the Windows cert store
//
// macOS (Developer ID + notarization):
//   APPLE_SIGNING_IDENTITY    e.g. "Developer ID Application: MoggingLabs (TEAMID)"
//   APPLE_ID                  Apple account used for notarization
//   APPLE_PASSWORD            app-specific password for that account
//   APPLE_TEAM_ID             10-character team identifier
//   (or APPLE_API_KEY / APPLE_API_ISSUER / APPLE_API_KEY_PATH instead of the last three)
//
// Updater signature (both platforms):
//   TAURI_SIGNING_PRIVATE_KEY           the private key, or a path to it
//   TAURI_SIGNING_PRIVATE_KEY_PASSWORD  its password, if it has one

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

// Every variable that makes Tauri try to sign something.
const SIGNING_VARS = [
  "WINDOWS_CERT_THUMBPRINT",
  "APPLE_SIGNING_IDENTITY",
  "APPLE_CERTIFICATE",
  "APPLE_CERTIFICATE_PASSWORD",
  "APPLE_ID",
  "APPLE_PASSWORD",
  "APPLE_TEAM_ID",
  "APPLE_API_KEY",
  "APPLE_API_ISSUER",
  "APPLE_API_KEY_PATH",
  "TAURI_SIGNING_PRIVATE_KEY",
  "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
];

const unsigned = process.argv.includes("--unsigned");
const env = { ...process.env };

// GitHub Actions passes an *unset* secret as an empty string, and Tauri reads
// "present but empty" as "sign with this" — then dies on the empty material
// (`failed to import keychain certificate`, `Missing comment in secret key`).
// Absent and empty have to mean the same thing here.
for (const name of SIGNING_VARS) {
  if (env[name] === "" || (unsigned && env[name] !== undefined)) delete env[name];
}

const args = ["build"];
const notes = [];
/** Merged into tauri.conf.json at build time so nothing sensitive is committed. */
const configOverride = {};

if (unsigned) {
  notes.push("--unsigned given: skipping all signing");
} else if (process.platform === "win32") {
  if (env["WINDOWS_CERT_THUMBPRINT"]) {
    // Merged rather than committed, so the thumbprint stays out of the repo.
    configOverride.bundle = {
      windows: { certificateThumbprint: env["WINDOWS_CERT_THUMBPRINT"] },
    };
    notes.push("Authenticode: signing with WINDOWS_CERT_THUMBPRINT");
  } else {
    notes.push("Authenticode: WINDOWS_CERT_THUMBPRINT unset — artifacts will be UNSIGNED");
  }
} else if (process.platform === "darwin") {
  // Tauri reads these itself; they only need to be present.
  notes.push(
    env["APPLE_SIGNING_IDENTITY"]
      ? "Developer ID: signing with APPLE_SIGNING_IDENTITY"
      : "Developer ID: APPLE_SIGNING_IDENTITY unset — artifacts will be UNSIGNED",
  );

  const notarising =
    (env["APPLE_ID"] && env["APPLE_PASSWORD"] && env["APPLE_TEAM_ID"]) ||
    (env["APPLE_API_KEY"] && env["APPLE_API_ISSUER"]);
  notes.push(
    notarising
      ? "Notarization: credentials present"
      : "Notarization: credentials unset — Gatekeeper will block this build",
  );
}

// Updater artifacts are only worth producing when they can be signed: an
// unsigned one is rejected by every installed app. Tauri also refuses to build
// them without the key, so this is switched on here rather than in the
// committed config.
if (env["TAURI_SIGNING_PRIVATE_KEY"]) {
  configOverride.bundle = { ...configOverride.bundle, createUpdaterArtifacts: true };
  notes.push("Updater: signing update artifacts with TAURI_SIGNING_PRIVATE_KEY");
} else {
  notes.push("Updater: TAURI_SIGNING_PRIVATE_KEY unset — installers only, no update artifacts");
}

if (Object.keys(configOverride).length > 0) {
  args.push("--config", JSON.stringify(configOverride));
}

// The Tauri CLI is run directly — not `npm run tauri`, and not through a shell.
//
// Both of those silently destroyed `--config`, and with it every signed build
// this script claims to produce:
//
//   * `npm run tauri build --config <json>` — npm parses `--config` as one of
//     *its own* CLI configs, strips it, and forwards the bare JSON as a
//     positional argument. Tauri's positional slot is "arguments passed to the
//     runner", so the JSON went to `cargo`, which rejected it. The certificate
//     was never applied, `createUpdaterArtifacts` was never set, and the script
//     had already printed "signing with WINDOWS_CERT_THUMBPRINT". `npm run
//     tauri -- build …` fixes the stripping and not the next problem.
//   * `shell: true` — cmd.exe re-parses the argument, and JSON is nothing but
//     quotes and braces. Even correctly forwarded it would arrive mangled.
//
// Spawning `node tauri.js` with an argv array has neither failure: no parser
// between here and the CLI, and the JSON crosses as one argument whatever it
// contains. It is also why this went nine rounds undetected — the only path
// that works is the one with no signing material set, which is every run
// anybody has made.
const cli = createRequire(import.meta.url).resolve("@tauri-apps/cli/tauri.js");

// `--dry-run` prints the command instead of running it, and exists so this
// file can be gated at all.
//
// Building an installer takes minutes, needs a Rust toolchain and real signing
// material, and produces artifacts nothing here can inspect — so no test was
// ever going to run it, and none did. That is exactly how a `--config` that
// never reached Tauri survived nine review rounds: the argument list is the
// part that was wrong, and the argument list is cheap to assert.
// One description of the command, used by both the dry run and the spawn.
//
// Not two: a dry run that reports a plan the spawn does not follow is a gate
// that cannot see the thing it was written for. Reverting the line below to
// `npm`/`shell: true` has to change what the test reads.
const command = process.execPath;
const commandArgs = [cli, ...args];

if (process.argv.includes("--dry-run")) {
  // The plan alone on stdout, so it can be parsed. The notes travel inside it.
  console.log(JSON.stringify({ command, args: commandArgs, notes }));
  process.exit(0);
}

for (const note of notes) console.log(`[release] ${note}`);

const result = spawnSync(command, commandArgs, { stdio: "inherit", env });
process.exit(result.status ?? 1);
