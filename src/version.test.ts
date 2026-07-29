/**
 * The three places a version number is written.
 *
 * `tauri.conf.json` is the authoritative one: `tauri-codegen` makes it
 * `PackageInfo.version`, which is what the bundle is named with and what the
 * updater substitutes into `{{current_version}}`. `Cargo.toml`'s is a fallback
 * that can never fire while the JSON has one, and `package.json`'s is read by
 * nothing in the build at all.
 *
 * So the obvious releaser action — `npm version 0.2.0` — bumps only the file
 * that does not ship, and every gate stays green while the installer, the
 * update feed and the tag all disagree. Three literals with nothing joining
 * them is the same class of defect as the settings bounds and the default
 * settings, both of which are already joined by a shared fixture; this one is
 * joined by an assertion instead, because the files are not ours to reshape.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

function tomlVersion(raw: string): string | undefined {
  // The first `version = "…"` after `[package]`, which is the crate's own.
  const packageSection = raw.slice(raw.indexOf("[package]"));
  return /^version\s*=\s*"([^"]+)"/m.exec(packageSection)?.[1];
}

test("every version literal agrees with the one that actually ships", () => {
  const tauri = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8")) as {
    version: string;
  };
  const npm = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
  const cargo = tomlVersion(readFileSync("src-tauri/Cargo.toml", "utf8"));

  assert.match(tauri.version, /^\d+\.\d+\.\d+$/, "the shipping version is a version");
  assert.equal(
    npm.version,
    tauri.version,
    "package.json disagrees with tauri.conf.json, which is the one that ships",
  );
  assert.equal(
    cargo,
    tauri.version,
    "Cargo.toml disagrees with tauri.conf.json, which overrides it",
  );
});
