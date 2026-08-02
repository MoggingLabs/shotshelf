import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { defineConfig, devices } from "@playwright/test";

/**
 * The state atlas's own config, deliberately not the gate's.
 *
 * The root config's `testDir: "tests"` would sweep the atlas into
 * `npm run test` — a ~50-screenshot photography session inside every gate
 * run — so the root ignores `tests/atlas` and this config is the only way
 * in. The webview setup mirrors the root config: the popover's real
 * viewport read from `tauri.conf.json`, and the built bundle served the one
 * way `npm run preview` defines (see the root config for why those flags
 * and `reuseExistingServer: false` are load-bearing).
 */
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const shelfWindow = (
  JSON.parse(readFileSync(resolve(repo, "src-tauri/tauri.conf.json"), "utf8")) as {
    app: { windows: { width: number; height: number }[] };
  }
).app.windows[0];
if (!shelfWindow) throw new Error("tauri.conf.json declares no shelf window");

export default defineConfig({
  testDir: ".",
  outputDir: "./test-output",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  reporter: [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://127.0.0.1:4173",
    locale: "en-US",
    timezoneId: "UTC",
    // Pinned for the same reason the main config pins it: "system" resolves
    // against the browser's scheme, and Playwright's default is light.
    colorScheme: "dark",
    viewport: { width: shelfWindow.width, height: shelfWindow.height },
    deviceScaleFactor: 1,
  },
  webServer: {
    command: "npm run build && npm run preview",
    cwd: repo,
    url: "http://127.0.0.1:4173",
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
