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
const TRIPLES = {
  "win32-x64": "x86_64-pc-windows-msvc",
  "win32-arm64": "aarch64-pc-windows-msvc",
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-x64": "x86_64-unknown-linux-gnu",
  "linux-arm64": "aarch64-unknown-linux-gnu",
};

const platform = `${process.platform}-${process.arch}`;
const triple = TRIPLES[platform];

if (!triple) {
  console.error(`[sidecar] no target triple known for ${platform}`);
  process.exit(1);
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

if (existsSync(target) && statSync(target).size === statSync(source).size) {
  console.log(`[sidecar] ffmpeg-${triple}${suffix} is already in place`);
  process.exit(0);
}

mkdirSync(dirname(target), { recursive: true });
copyFileSync(source, target);
if (process.platform !== "win32") chmodSync(target, 0o755);

const megabytes = (statSync(target).size / 1024 / 1024).toFixed(1);
console.log(`[sidecar] ffmpeg-${triple}${suffix} ready (${megabytes} MB)`);
