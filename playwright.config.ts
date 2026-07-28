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
/** The popover's real size. Layout assertions are only meaningful at it. */
const POPOVER_VIEWPORT = { width: 225, height: 420 };

export default defineConfig({
  testDir: "tests",
  // A failing gate that passes on a retry is not a gate. CI retries once, to
  // absorb runner flakiness, and any test that needs it is a bug to fix.
  retries: process.env["CI"] ? 1 : 0,
  forbidOnly: Boolean(process.env["CI"]),
  fullyParallel: true,
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
  ],

  // The built bundle, not the dev server: the gate should run against what
  // actually ships, and Vite's dev transform is not that.
  webServer: {
    // `--host 127.0.0.1` is load-bearing: left to itself Vite binds localhost
    // as IPv6 only, and Playwright's readiness probe hits 127.0.0.1 and waits
    // out its whole timeout against a server that is already up.
    command: "npm run build && npx vite preview --port 4173 --strictPort --host 127.0.0.1",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: !process.env["CI"],
    timeout: 120_000,
  },
});
