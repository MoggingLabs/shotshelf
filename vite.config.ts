import { defineConfig } from "vite";

// Shotshelf is desktop-only (Tauri v2), and this config stays free of Node
// globals so the bundle it produces has none.
//
// It used to say that was to avoid needing `@types/node`, which was never true
// and got less true: `@types/node` is a devDependency, `tsconfig.json` loads
// it, and `playwright.config.ts` imports `node:fs`. The reason that survives is
// the simpler one — what is written here ends up shipped, and the tooling
// around it does not.
export default defineConfig({
  // Tauri's CLI owns the terminal output; don't let Vite wipe it.
  clearScreen: false,
  server: {
    // Must match `build.devUrl` in src-tauri/tauri.conf.json.
    port: 1420,
    strictPort: true,
    watch: {
      // Rust rebuilds are driven by Tauri, not Vite.
      ignored: ["**/src-tauri/**"],
    },
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: {
    // Windows 11 -> WebView2 (Chromium), macOS -> WKWebView (Safari 16+ on the
    // macOS versions Tauri v2 supports). Targeting both keeps one build honest.
    target: ["chrome105", "safari16"],
    // Debug builds keep sources readable; release builds stay small.
    sourcemap: false,
  },
});
