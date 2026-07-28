/**
 * Booting the real front-end in a browser, with the Tauri runtime stubbed and
 * capture files served from `tests/fixtures`.
 *
 * Every spec goes through here so there is one definition of "the app, ready"
 * — a test that reaches into the page and builds its own start-up sequence is
 * a test that stops matching the app the moment start-up changes.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, type Page, test as base } from "@playwright/test";

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

/** A capture payload as Rust would emit it. */
function capture(
  file: string,
  options: { ts?: number; kind?: "image" | "video" } = {},
): { path: string; kind: "image" | "video"; ts: number } {
  return { path: file, kind: options.kind ?? "image", ts: options.ts ?? Date.UTC(2026, 6, 27, 12) };
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
  settings?: Partial<{
    retentionHours: number | null;
    maxItems: number;
    hotkey: string;
    pinned: { path: string; kind: "image" | "video"; ts: number }[];
  }>;
}

export async function bootShelf(page: Page, options: BootOptions = {}): Promise<void> {
  if (options.settings) {
    await page.addInitScript((settings) => {
      window.__shotshelfStubs__ = {
        get_settings: {
          retentionHours: null,
          maxItems: 50,
          hotkey: "CommandOrControl+Shift+S",
          pinned: [],
          ...settings,
        },
      };
    }, options.settings);
  }

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
