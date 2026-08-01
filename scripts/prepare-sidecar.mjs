// Puts ffmpeg where Tauri expects a sidecar to be.
//
// Tauri resolves external binaries by target triple, so the build for this
// platform that `ffmpeg-static` fetched is copied to `ffmpeg-<triple>`. The
// binary is ~80 MB per platform, which is why it is fetched at install time
// and git-ignored rather than committed — it still ends up bundled inside the
// installer, so nothing is ever downloaded at runtime.

import { chmodSync, copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Derived from platform/arch rather than `rustc -vV` so this works before the
// Rust toolchain is installed, which is the order CI happens to use.
/**
 * ffmpeg is GPL-3.0, and a distributed build carries obligations for it.
 *
 * `ffmpeg-static` downloads `ffmpeg.LICENSE` alongside the binary; copying
 * only the binary shipped a GPL-licensed executable with no licence text in
 * every installer. README states the obligation and nothing discharged it.
 */
const LICENSE_SUFFIX = ".LICENSE";

const TRIPLES = {
  "win32-x64": "x86_64-pc-windows-msvc",
  // No `win32-arm64`. `ffmpeg-static` ships no Windows-on-ARM binary, so
  // naming the triple here implied a platform that cannot be built: the
  // download step warned and exited 0, and the failure surfaced minutes
  // later inside `tauri build` as a missing sidecar. An unmapped platform
  // now says so immediately, and says why.
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-x64": "x86_64-unknown-linux-gnu",
  "linux-arm64": "aarch64-unknown-linux-gnu",
};

const platform = `${process.platform}-${process.arch}`;
const triple = TRIPLES[platform];

if (!triple) {
  // A warning, not a failure. This runs from `postinstall`, so exiting non-zero
  // here failed `npm install` outright on any platform outside the map —
  // including `linux-arm`, which `ffmpeg-static` does support. Someone
  // installing dependencies to work on the front end does not need a sidecar,
  // and `tauri build` complains loudly if one is genuinely missing.
  console.warn(
    `[sidecar] no target triple known for ${platform} — skipping. ` +
      `A bundle built here will have no ffmpeg, so poster frames for recordings ` +
      `will be missing; everything else works. Windows on ARM is the known case: ` +
      `\`ffmpeg-static\` publishes no binary for it.`,
  );
  process.exit(0);
}

let source;
try {
  source = require("ffmpeg-static");
} catch {
  // A production install without dev dependencies has no ffmpeg to copy. Don't
  // fail the install over it; `tauri build` will complain loudly if the sidecar
  // really is needed and missing.
  console.warn("[sidecar] ffmpeg-static is not installed — skipping");
  process.exit(0);
}

if (!source || !existsSync(source)) {
  console.warn("[sidecar] ffmpeg-static did not produce a binary — skipping");
  process.exit(0);
}

const suffix = process.platform === "win32" ? ".exe" : "";
const target = join(root, "src-tauri", "binaries", `ffmpeg-${triple}${suffix}`);

mkdirSync(dirname(target), { recursive: true });

// The GPL text, beside the binary it covers.
//
// `ffmpeg-static` downloads `ffmpeg.LICENSE` next to the executable. Copying
// only the executable meant every installer would have shipped a GPL-3.0
// binary with no licence text — an obligation README states plainly and
// nothing discharged.
// Named after the binary — `ffmpeg.exe.LICENSE` on Windows, `ffmpeg.LICENSE`
// elsewhere — so it is derived rather than guessed.
const licence = `${source}${LICENSE_SUFFIX}`;
const licenceTarget = join(dirname(target), `ffmpeg${LICENSE_SUFFIX}`);
if (existsSync(licence)) {
  copyFileSync(licence, licenceTarget);
} else {
  console.warn(`[sidecar] no licence beside ffmpeg — GPL text must ship with the binary`);
}

if (existsSync(target) && statSync(target).size === statSync(source).size) {
  console.log(`[sidecar] ffmpeg-${triple}${suffix} is already in place`);
  process.exit(0);
}

copyFileSync(source, target);
if (process.platform !== "win32") chmodSync(target, 0o755);

const megabytes = (statSync(target).size / 1024 / 1024).toFixed(1);
console.log(`[sidecar] ffmpeg-${triple}${suffix} ready (${megabytes} MB)`);
