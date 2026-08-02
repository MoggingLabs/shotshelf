/**
 * Build-time constants vite's `define` inlines.
 *
 * The version reaches the About section this way — from `package.json` at
 * build time — because the alternative is a runtime `getVersion` call that
 * needs a `core:app` permission the webview otherwise has no reason to hold.
 */
declare const __APP_VERSION__: string;
