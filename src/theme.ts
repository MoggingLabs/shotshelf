/**
 * Which palette the document wears, kept in step with the setting.
 *
 * Shared by both windows: each stamps `data-theme` on its own root at boot
 * and again on every `settings://changed`. `"system"` resolves through the
 * OS preference and keeps following it live — WebView2 and WKWebView both
 * track the OS setting through `prefers-color-scheme`.
 *
 * The stylesheet is the other half: `:root[data-theme="light"]` swaps the
 * palette tokens, and everything built on tokens follows for free.
 */

import type { Settings } from "./settings.ts";

const dark = window.matchMedia("(prefers-color-scheme: dark)");

let wanted: Settings["theme"] = "system";

function stamp(): void {
  const resolved = wanted === "system" ? (dark.matches ? "dark" : "light") : wanted;
  document.documentElement.dataset["theme"] = resolved;
}

// One listener for the life of the window: it only matters while the setting
// is "system", and `stamp` re-reads that on every fire.
dark.addEventListener("change", () => {
  if (wanted === "system") stamp();
});

/** Apply a theme choice now, and keep following the OS if it is "system". */
export function applyTheme(theme: Settings["theme"]): void {
  wanted = theme;
  stamp();
}
