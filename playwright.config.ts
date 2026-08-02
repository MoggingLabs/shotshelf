import { readFileSync } from "node:fs";

import { defineConfig, devices } from "@playwright/test";

/**
 * The front-end gate.
 *
 * Shotshelf's UI is a webview, so the honest way to test it is a browser with
 * the Tauri runtime stubbed (see `tests/harness/tauri-mock.ts`). Chromium only:
 * the app ships on WebView2 and WKWebView, and testing Firefox would gate
 * behaviour no user will ever see.
 *
 * Screenshots are compared against committed goldens, and font rasterisation
 * differs between operating systems — so visual tests are pinned to Linux in
 * CI, where the goldens were taken. Running them on Windows or macOS produces
 * a diff on every glyph and tells you nothing. `npm run test:e2e` runs the
 * behavioural specs everywhere; `npm run test:visual` is the pinned one.
 */
/**
 * The popover's real size. Layout assertions are only meaningful at it.
 *
 * Read from the Tauri config rather than written out again here. The number
 * lived in three hand-maintained places — this file, `tauri.conf.json` and
 * `window.rs` — with nothing checking they agreed, so a resized window would
 * have left every layout test measuring a shape the app no longer takes.
 * `window.rs` cannot import JSON, so a Rust test asserts its constant against
 * the same file.
 */
const shelfWindow = (
  JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8")) as {
    app: { windows: { width: number; height: number }[] };
  }
).app.windows[0];
if (!shelfWindow) throw new Error("tauri.conf.json declares no shelf window");
const POPOVER_VIEWPORT = { width: shelfWindow.width, height: shelfWindow.height };

/**
 * A user agent with no "Windows" in it.
 *
 * `main.ts` sets `data-os="windows"` from `navigator.userAgent`, and the
 * stylesheet picks the DWM corner radius from that — so a runner whose UA says
 * Windows can never exercise the default. This is the same Chrome build string
 * with the platform token swapped, which is exactly what the sniff reads.
 */
const NON_WINDOWS_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/151.0.0.0 Safari/537.36";

export default defineConfig({
  testDir: "tests",
  // The state atlas is photography, not a gate — ~50 screenshots per run.
  // It has its own config (tests/atlas/atlas.config.ts) and only runs when
  // asked for by name.
  testIgnore: "**/atlas/**",
  // A failing gate that passes on a retry is not a gate. CI retries once, to
  // absorb runner flakiness, and any test that needs it is a bug to fix.
  retries: process.env["CI"] ? 1 : 0,
  forbidOnly: Boolean(process.env["CI"]),
  fullyParallel: true,
  // Half the cores, not all of them.
  //
  // Playwright's default is `cores / 2` already, but a developer box runs the
  // Rust half of the gate, a Vite preview and an editor alongside this, and the
  // editor specs decode real PNGs inside the page with `createImageBitmap`.
  // Under full contention three different editor specs failed across two runs
  // of the whole suite and every one passed in isolation and at a lower worker
  // count — which is the retry this config refuses to allow, arriving as
  // scheduling instead.
  //
  // A cap rather than a retry, because the two are not the same admission: a
  // retry says the assertion is unreliable, and a cap says the machine was
  // oversubscribed. Nothing here waits on the network, so the wall-clock cost
  // is small and the determinism is the point.
  workers: process.env["CI"] ? "50%" : 2,
  reporter: process.env["CI"] ? [["github"], ["list"]] : [["list"]],

  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "retain-on-failure",
    // Pinned because the app formats dates with the runtime's defaults:
    // `dayLabel` falls through to `toLocaleDateString([], …)` and `dayKey`
    // uses local time. The clock was pinned after a golden baked in
    // "YESTERDAY"; these two are the other half of the same ambient input, and
    // without them a golden encodes "26 July" versus "July 26" as a property
    // of the runner image rather than of the code.
    locale: "en-US",
    timezoneId: "UTC",
  },

  expect: {
    toHaveScreenshot: {
      // Sub-pixel antialiasing moves a handful of pixels between runs even on
      // one machine. Tight enough to catch a layout change, loose enough not
      // to fail on a rounding difference in a shadow.
      maxDiffPixelRatio: 0.002,
      animations: "disabled",
      scale: "css",
    },
  },

  projects: [
    {
      name: "chromium",
      // Viewport last: the device preset carries its own 1280x720, and letting
      // it win measured a card at 1254 wide in a popover that is 225.
      use: { ...devices["Desktop Chrome"], viewport: POPOVER_VIEWPORT, deviceScaleFactor: 1 },
    },
    {
      // The same browser without the preset's Windows user agent.
      //
      // `devices["Desktop Chrome"]` carries `Mozilla/5.0 (Windows NT 10.0; …)`
      // on *every* host, so the app's `data-os` sniff answered "windows" on the
      // macOS and Linux runners too. The corner radius that macOS and Linux
      // actually show — the 14px default — was asserted only by the dead arm of
      // a ternary, and the committed Linux goldens encode the Windows 8px
      // corner. Setting `--radius: 99px` left the whole visual suite green.
      //
      // Only the layout spec: it is the one that reads computed style, and the
      // pixel goldens are pinned to one OS and one UA on purpose.
      name: "chromium-not-windows",
      testMatch: /tests\/visual\/layout\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        userAgent: NON_WINDOWS_UA,
        viewport: POPOVER_VIEWPORT,
        deviceScaleFactor: 1,
      },
    },
  ],

  // The built bundle, not the dev server: the gate should run against what
  // actually ships, and Vite's dev transform is not that.
  webServer: {
    // Through `npm run preview`, so there is one definition of how the built
    // bundle is served.
    //
    // These flags are load-bearing: left to itself Vite binds localhost as IPv6
    // only, and Playwright's readiness probe hits 127.0.0.1 and waits out its
    // whole timeout against a server that is already up. They used to live only
    // here, while `package.json` carried a bare `vite preview` that nothing
    // invoked — so the one script a person would reach for was the one that
    // reproduced the bug this comment describes.
    command: "npm run build && npm run preview",
    url: "http://127.0.0.1:4173",
    // Never reused, including locally, and this is not a performance oversight.
    //
    // `reuseExistingServer: !process.env["CI"]` is the idiom, and it is wrong
    // for a gate whose whole premise is the line above: a `vite preview` left
    // over from an earlier run keeps serving the bundle it was started with,
    // so every subsequent local run tests **the previous build**. Source edits
    // are invisible to it. That cost a full review round here — a real crop
    // fix looked unverifiable because the spec probing it, the spec's three
    // rewrites, and the run that "confirmed the fix was already correct" were
    // all measuring a bundle from before the fix existed. A gate that reports
    // on code that was never built is worse than no gate, because it is
    // believed.
    //
    // The price is one `tsc && vite build` per invocation, a few seconds. That
    // is the cost of the result meaning what it says.
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
