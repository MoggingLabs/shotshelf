/**
 * Booting the real front-end in a browser, with the Tauri runtime stubbed and
 * capture files served from `tests/fixtures`.
 *
 * Every spec goes through here so there is one definition of "the app, ready"
 * — a test that reaches into the page and builds its own start-up sequence is
 * a test that stops matching the app the moment start-up changes.
 */

import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, type Page, test as base } from "@playwright/test";

import type { Settings } from "../../src/settings.ts";
import { installTauriMock } from "./tauri-mock.ts";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

/** Fixture captures, in the shapes that have broken thumbnails before. */
export const FIXTURE = {
  /** 16:9 — fills a card exactly. */
  wide: "/captures/wide.png",
  /** Portrait — fitted, so the wash fills the bars either side. */
  tall: "/captures/tall.png",
  square: "/captures/square.png",
  /** Deliberately absent, to exercise the missing-file fallback. */
  missing: "/captures/gone.png",
} as const;

/**
 * A fixed "now" for every test that cares what day it is.
 *
 * Day headings read "Today" and "Yesterday" relative to the clock, so anything
 * asserting on them — or screenshotting them — has to pin it, or the gate
 * starts failing on the calendar rather than on a change.
 */
export const NOW = Date.UTC(2026, 6, 28, 12);
export const DAY = 86_400_000;

/** A capture payload as Rust would emit it. */
function capture(
  file: string,
  options: { ts?: number; kind?: "image" | "video" } = {},
): { path: string; kind: "image" | "video"; ts: number } {
  return { path: file, kind: options.kind ?? "image", ts: options.ts ?? NOW };
}

/**
 * Serve fixture images, and 404 anything the app asks for that we do not have
 * — which is how the missing-capture path gets exercised for real rather than
 * by poking at the DOM.
 */
async function serveFixtures(page: Page): Promise<void> {
  await page.route("**/fixtures/*", async (route, request) => {
    const name = request.url().split("/").pop() ?? "";
    try {
      const body = await readFile(path.join(FIXTURES, name));
      await route.fulfill({ body, contentType: "image/png" });
    } catch {
      await route.fulfill({ status: 404, body: "" });
    }
  });
}

/**
 * Load the app and wait until it has settled: start-up reads settings and the
 * watch folders, and asserting before those land is how a suite becomes flaky.
 */
export interface BootOptions {
  /**
   * Settings the app should read at start-up. Seeded before any app module
   * runs, because the shelf has already read its limits by the time a test
   * could stub them from the outside.
   */
  /**
   * Imported rather than restated. A hand-written copy drifted the moment a
   * setting was added — `checkForUpdates` existed in Rust, in the front end
   * and in the shared fixture while this type still had five fields, so no
   * spec could seed it.
   */
  settings?: Partial<Settings>;
}

/**
 * The defaults the app really starts on, read from the file both Rust and the
 * front-end assert against.
 *
 * Not written out again here. The harness used to carry its own copy — two, in
 * fact — so adding a setting could pass the Rust round-trip test and the
 * TypeScript one while every e2e test silently ran against a settings object
 * missing the new field. That is precisely the drift the fixture exists to
 * prevent, reproduced inside the gate meant to catch it.
 */
export const DEFAULT_SETTINGS = JSON.parse(
  readFileSync(path.join(FIXTURES, "default-settings.json"), "utf8"),
) as Record<string, unknown>;

/**
 * What the item cap may be set to, shared with Rust.
 *
 * The same joining trick as `DEFAULT_SETTINGS`: `settings.rs` asserts its
 * constants against this file, and a spec asserts the HTML input against it,
 * so neither side can move without the other.
 */
export const BOUNDS = JSON.parse(
  readFileSync(path.join(FIXTURES, "settings-bounds.json"), "utf8"),
) as { maxItems: { min: number; max: number } };

export async function bootShelf(page: Page, options: BootOptions = {}): Promise<void> {
  await page.addInitScript((seed) => {
    // Merged, not assigned. A spec that seeds its own start-up stubs runs its
    // init script before this one, and assigning wholesale dropped them —
    // silently, so the next test to seed both would have failed for a reason
    // with nothing to do with what it was testing.
    const existing = window.__shotshelfStubs__ ?? {};
    window.__shotshelfStubs__ = { get_settings: seed, ...existing };
  }, { ...DEFAULT_SETTINGS, ...options.settings });

  await page.addInitScript(installTauriMock);
  await serveFixtures(page);
  await page.goto("/");
  await expect(page.locator(".shelf")).toBeVisible();
  await page.waitForFunction(() => window.__shotshelf__.callsTo("catch_watch_dirs").length > 0);
}

/** Deliver a `capture://new` event exactly as Rust would. */
export async function land(
  page: Page,
  file: string,
  options: { ts?: number; kind?: "image" | "video" } = {},
): Promise<void> {
  await page.evaluate((payload) => window.__shotshelf__.emit("capture://new", payload), capture(file, options));
}

/** Open the browse view the way the tray does — by emitting, not by clicking. */
export async function openBrowse(page: Page): Promise<void> {
  await page.evaluate(() => window.__shotshelf__.emit("shelf://opened", null));
}

export const test = base;
export { expect } from "@playwright/test";
