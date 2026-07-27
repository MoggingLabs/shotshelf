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

const args = ["tauri", "build"];
const notes = [];

if (unsigned) {
  notes.push("--unsigned given: skipping all signing");
} else if (process.platform === "win32") {
  if (env["WINDOWS_CERT_THUMBPRINT"]) {
    // Merged rather than committed, so the thumbprint stays out of the repo.
    args.push(
      "--config",
      JSON.stringify({
        bundle: { windows: { certificateThumbprint: env["WINDOWS_CERT_THUMBPRINT"] } },
      }),
    );
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

if (!env["TAURI_SIGNING_PRIVATE_KEY"]) {
  notes.push(
    "Updater: TAURI_SIGNING_PRIVATE_KEY unset — update artifacts will be unsigned and rejected by installed apps",
  );
}

for (const note of notes) console.log(`[release] ${note}`);

const result = spawnSync("npm", ["run", ...args], { stdio: "inherit", shell: true, env });
process.exit(result.status ?? 1);
