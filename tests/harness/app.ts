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
import windowEvents from "../fixtures/window-events.json" with { type: "json" };

/**
 * The event names and payloads Rust emits, read rather than restated.
 *
 * `src-tauri/src/window.rs` asserts its own constants against this same file,
 * so a rename on either side fails a test instead of silently detaching the
 * front end from the events it listens for.
 */
const WINDOW_EVENTS = {
  opened: windowEvents.opened,
  hidden: windowEvents.hidden,
  deliberate: windowEvents.deliberate,
  // The launch appearance's payload, and it had no reader here at all.
  //
  // A fixture entry only one side reads is not a join: the Rust test compared
  // `launch` to a `false` written in the test beside it, and the three specs
  // that model a launch appearance hard-coded their own `false`.
  //
  // What that buys, precisely: the *name and payload* of the launch event now
  // have one definition, so a spec cannot model the launch appearance as a
  // deliberate open by writing the wrong boolean. What it does **not** buy —
  // and an earlier version of this comment claimed it did — is any check on the
  // call site: flipping `window::open(app.handle(), false)` to `true` in
  // `lib.rs` still passes every gate, because no browser spec executes a
  // `#[tauri::command]` and no Rust test observes that argument.
  // `src-tauri/src/window.rs` states that limit correctly; this comment used to
  // contradict it two files away.
  launch: windowEvents.launch,
};

/**
 * The two events the *app* listens for, as opposed to the two the mock emits.
 *
 * Read here for the same reason, and it was the half the join missed: the Rust
 * test pinned `capture://new` and `update://available` against the fixture, and
 * nothing pinned the fixture against TypeScript. Renaming the Rust constant
 * *and* the fixture together passed the whole gate — while in the real app Rust
 * would emit one name and `main.ts` would listen for another, so no capture
 * would ever reach the shelf. Silent and total.
 *
 * `land` and every spec that emits one now go through these.
 */
export const CAPTURE_EVENT = windowEvents.capture;
export const UPDATE_EVENT = windowEvents.update;
/** The catch engine's one channel for a capture it could not save. */
export const PROBLEM_EVENT = windowEvents.problem;
/**
 * The hide event, exported for the same reason as the three above.
 *
 * It was left inside the un-exported `WINDOW_EVENTS` while the other three were
 * exported, so five specs wrote `"shelf://hidden"` by hand — and renaming both
 * `window::HIDDEN_EVENT` and this fixture, leaving `main.ts` on the old name,
 * passed 142 Rust tests, 126 browser tests and all three script gates. That is
 * exactly the drift the fixture exists to prevent, and exactly the criticism
 * this file already makes of `launch` one comment up.
 *
 * `opened` needs no export: every spec reaches it through `openBrowse` or
 * `launchAppearance`, so its name already flows from the fixture. Exporting it
 * as well would be an unread symbol, which `knip` correctly refuses.
 */
export const HIDDEN_EVENT = windowEvents.hidden;

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

  await page.addInitScript(installTauriMock, WINDOW_EVENTS);
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
  await page.evaluate(
    ([event, payload]) => window.__shotshelf__.emit(event, payload),
    [CAPTURE_EVENT, capture(file, options)] as const,
  );
}

/**
 * Open the browse view the way the tray does — by emitting, not by clicking.
 *
 * `true` is the payload Rust sends for a *deliberate* open. The launch
 * appearance sends `false`, which is what lets it keep its own dismissal timer
 * instead of cancelling it with its own event.
 */
export async function openBrowse(page: Page): Promise<void> {
  await page.evaluate(
    ([event, deliberate]) => window.__shotshelf__.emit(event, deliberate),
    [WINDOW_EVENTS.opened, WINDOW_EVENTS.deliberate] as const,
  );
}

/**
 * The appearance nobody asked for: the four-second one at start-up.
 *
 * Same event as [`openBrowse`], opposite payload — and that payload is what
 * lets the appearance keep its own dismissal timer instead of standing it down.
 * Read from the fixture rather than written as `false` at each call site, which
 * is what three specs did while the Rust test compared the fixture to a literal
 * beside itself. Nothing joined the two, so the boolean the launch depends on
 * could be flipped at its one call site with every gate green.
 */
export async function launchAppearance(page: Page): Promise<void> {
  await page.evaluate(
    ([event, launch]) => window.__shotshelf__.emit(event, launch),
    [WINDOW_EVENTS.opened, WINDOW_EVENTS.launch] as const,
  );
}

export const test = base;
export { expect } from "@playwright/test";
