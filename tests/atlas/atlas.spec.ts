/**
 * The state atlas: every reachable UI state, photographed, asserting nothing.
 *
 * Promoted from the throwaway capture matrix the 2026-08-02 UX audit was run
 * with, because the expensive part of that audit was reconstructing the
 * driver — the looking took minutes once the pictures existed. This produces
 * the pictures on demand (`npm run atlas`, or the Atlas workflow for Linux
 * rasterisation) and a person does the looking.
 *
 * Deliberately assertion-free and deliberately outside the gate (the root
 * config ignores `tests/atlas`): an atlas that failed builds would grow
 * assertions, and its job is coverage of what things look like, not
 * enforcement — the goldens enforce, over the states worth enforcing.
 */

import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import type { Page, Locator } from "@playwright/test";

import {
  bootSettings,
  bootShelf,
  expect,
  FIXTURE,
  HIDDEN_EVENT,
  land,
  NOW,
  openBrowse,
  PROBLEM_EVENT,
  SETTINGS_VIEWPORT,
  test,
  UPDATE_EVENT,
} from "../harness/app.ts";

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "output");
mkdirSync(OUT, { recursive: true });

function shot(target: Page | Locator, name: string): Promise<unknown> {
  return target.screenshot({ path: resolve(OUT, `${name}.png`), animations: "disabled" });
}

/** Every picture loaded plus two paint frames — the goldens' settling rule. */
async function settled(page: Page): Promise<void> {
  await page.waitForFunction(() =>
    [...document.images].every((image) => image.complete && image.naturalWidth > 0),
  );
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
}

const SECRET = {
  scanned: true,
  secrets: [{ kind: "serviceToken", label: "GitHub token", preview: "ghp_••••••" }],
};

test("browse states", async ({ page }) => {
  await bootShelf(page);
  await openBrowse(page);
  await shot(page, "browse-00-empty");

  await land(page, FIXTURE.wide, { ts: 1 });
  await settled(page);
  await shot(page, "browse-01-one");

  await land(page, FIXTURE.tall, { ts: 2 });
  await land(page, FIXTURE.square, { ts: 3 });
  await settled(page);
  await shot(page, "browse-02-three-shapes");

  for (let index = 4; index <= 12; index += 1) {
    await land(page, FIXTURE.wide, { ts: index });
  }
  await settled(page);
  await shot(page, "browse-03-twelve-top");

  await page.locator("#shelf-items").evaluate((list) => {
    list.scrollTop = list.scrollHeight;
  });
  await shot(page, "browse-04-twelve-bottom");
});

test("peek column", async ({ page }) => {
  await bootShelf(page);
  await land(page, FIXTURE.wide, { ts: 1 });
  await settled(page);
  await shot(page, "peek-01-one");
  await land(page, FIXTURE.tall, { ts: 2 });
  await land(page, FIXTURE.square, { ts: 3 });
  await settled(page);
  // The real column window is resized by Rust; at the fixed harness viewport
  // taller stacks clip — the reference is the shape, not the height.
  await shot(page, "peek-02-three-clipped-reference");
});

test("tile states", async ({ page }) => {
  await bootShelf(page);
  await land(page, FIXTURE.wide);
  await openBrowse(page);
  await settled(page);
  const tile = page.locator(".tile");
  await shot(tile, "tile-00-rest");

  await tile.hover();
  await shot(tile, "tile-01-hover-actions");

  await page.keyboard.press("ArrowDown");
  await shot(tile, "tile-02-picked-under-hover");
  await page.mouse.move(0, 0);
  await shot(tile, "tile-03-picked-rest");

  await tile.hover();
  await page.locator(".tile__action--pin").click();
  await shot(tile, "tile-04-pinned-under-hover");
  await page.mouse.move(0, 0);
  await shot(tile, "tile-05-pinned-rest-star-in-corner");
});

test("copy and reveal receipts, frozen mid-flash", async ({ page }) => {
  await page.clock.install({ time: new Date(NOW) });
  await bootShelf(page);
  await land(page, FIXTURE.wide);
  await openBrowse(page);
  await settled(page);
  const tile = page.locator(".tile");
  await tile.hover();
  await page.locator(".tile__action--copy").click();
  await expect(page.locator(".tile__action--ok")).toHaveCount(1);
  await shot(tile, "receipt-00-copy-ok-under-pointer");
  await page.mouse.move(0, 0);
  await shot(tile, "receipt-01-copy-ok-pointer-away");

  await page.clock.runFor(2_000);
  await page.evaluate(() => window.__shotshelf__.reject("reveal_capture", "no"));
  await tile.hover();
  await page.locator(".tile__action--reveal").click();
  await expect(page.locator(".tile__action--bad")).toHaveCount(1);
  await shot(tile, "receipt-02-reveal-bad");
});

test("multi-pick, cursor, drag source", async ({ page }) => {
  await bootShelf(page);
  await land(page, FIXTURE.wide, { ts: 1 });
  await land(page, FIXTURE.tall, { ts: 2 });
  await land(page, FIXTURE.square, { ts: 3 });
  await openBrowse(page);
  await settled(page);
  await page.keyboard.press("ArrowDown");
  await page.locator(".tile").last().click({ modifiers: ["Shift"] });
  await page.mouse.move(0, 0);
  await shot(page, "pick-00-three-with-cursor-halo");

  await page.evaluate(() => window.__shotshelf__.hang("plugin:drag|start_drag"));
  const box = await page.locator(".tile").first().boundingBox();
  if (box) {
    await page.mouse.move(box.x + 40, box.y + 40);
    await page.mouse.down();
    await page.mouse.move(box.x + 90, box.y + 90, { steps: 4 });
    await shot(page, "pick-01-dragging-source-faded");
    await page.mouse.up();
  }
});

test("credential markers, every kind", async ({ page }) => {
  await bootShelf(page);
  for (const [index, kind, label] of [
    [1, "serviceToken", "GitHub token"],
    [2, "privateKey", "private key"],
    [3, "personalData", "email address"],
  ] as const) {
    await page.evaluate(
      ([k, l]) =>
        window.__shotshelf__.respond("describe_capture", {
          scanned: true,
          secrets: [{ kind: k, label: l, preview: "••••" }],
        }),
      [kind, label] as const,
    );
    await land(page, FIXTURE.wide, { ts: index });
  }
  await page.evaluate(() =>
    window.__shotshelf__.respond("describe_capture", { scanned: false, secrets: [] }),
  );
  await land(page, FIXTURE.tall, { ts: 4 });
  await openBrowse(page);
  await settled(page);
  await shot(page, "secret-00-three-kinds-and-unscanned");

  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await shot(page.locator(".tile").nth(2), "secret-01-picked-composes-rim");
});

test("video and missing", async ({ page }) => {
  await bootShelf(page);
  await page.evaluate(() => {
    window.__shotshelf__.respond("video_details", {
      poster: null,
      durationMs: 65_432,
      bytes: 12_345_678,
    });
  });
  await land(page, "/clips/atlas.mp4", { kind: "video", ts: 1 });
  await land(page, FIXTURE.missing, { ts: 2 });
  await openBrowse(page);
  await shot(page, "tile-06-video-badge-and-missing-rim");
});

test("quick look and editor", async ({ page }) => {
  await bootShelf(page);
  await page.evaluate(() => window.__shotshelf__.respond("preview_shelf", null));
  await land(page, FIXTURE.wide);
  await openBrowse(page);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press(" ");
  await expect(page.locator(".preview__picture")).toBeVisible();
  await settled(page);
  await shot(page, "overlay-00-preview-at-225");
  await page.keyboard.press(" ");

  await page.locator("#shelf-edit").click();
  await expect(page.locator(".editor__canvas")).toBeVisible();
  await settled(page);
  await shot(page, "overlay-01-editor-open");

  for (const tool of ["crop", "box", "arrow", "callout", "redact"]) {
    await page.locator(`.editor__tool[data-tool="${tool}"]`).click();
    await shot(page.locator(".editor__bar"), `overlay-02-tool-${tool}`);
  }

  // A drawn box and a redaction, then a failed save with its strip.
  await page.locator('.editor__tool[data-tool="box"]').click();
  const canvas = await page.locator(".editor__canvas").boundingBox();
  if (canvas) {
    await page.mouse.move(canvas.x + 20, canvas.y + 20);
    await page.mouse.down();
    await page.mouse.move(canvas.x + 120, canvas.y + 80, { steps: 4 });
    await page.mouse.up();
  }
  await shot(page, "overlay-03-editor-drawn-box");

  await page.evaluate(() => window.__shotshelf__.reject("save_edit", "the disk is full"));
  await page.locator("#editor-save").click();
  await expect(page.locator("#shelf-alert")).toBeVisible();
  await shot(page, "overlay-04-editor-save-failed");
});

test("settings window states", async ({ page }) => {
  // The window's own page, at the size the OS gives it: every section, the
  // recorder mid-recording, and a save error with Rust's sentence in it.
  await page.setViewportSize(SETTINGS_VIEWPORT);
  await bootSettings(page);
  await settled(page);
  await shot(page, "settings-00-general");

  for (const section of ["capturing", "appearance", "shortcuts", "about"]) {
    await page.locator(`button[data-section="${section}"]`).click();
    await settled(page);
    await shot(page, `settings-01-${section}`);
  }

  await page.locator('button[data-section="shortcuts"]').click();
  await page.locator("#setting-hotkey").click();
  await expect(page.locator("#setting-hotkey")).toHaveText("Press keys…");
  await shot(page, "settings-02-hotkey-recording");
  await page.keyboard.press("Escape");

  await page.locator('button[data-section="general"]').click();
  await page.evaluate(() =>
    window.__shotshelf__.reject(
      "set_settings",
      '"CommandOrControl+Shift+K" is already in use by Shotshelf',
    ),
  );
  await page.locator("#setting-max").fill("120");
  await page.locator("#setting-max").dispatchEvent("change");
  await expect(page.locator("#settings-note")).not.toHaveText("");
  await shot(page, "settings-03-save-error-note");
});

test("the light theme, shelf side", async ({ page }) => {
  await bootShelf(page, { settings: { theme: "light" } });
  await land(page, FIXTURE.wide);
  await openBrowse(page);
  await settled(page);
  await shot(page, "light-00-browse");
});

test("the light theme, settings side", async ({ page }) => {
  await page.setViewportSize(SETTINGS_VIEWPORT);
  await bootSettings(page, { settings: { theme: "light" } });
  await settled(page);
  await shot(page, "light-01-settings");
});

test("the strip's vocabulary", async ({ page }) => {
  await bootShelf(page);
  await land(page, FIXTURE.wide);
  await openBrowse(page);

  await page.keyboard.press("t");
  await expect(page.locator("#shelf-alert")).toBeVisible();
  await shot(page, "strip-00-pick-a-capture-first");

  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("t");
  await expect(page.locator("#shelf-alert")).toContainText("copied");
  await shot(page, "strip-01-text-copied");

  await page.keyboard.press("Delete");
  await expect(page.locator("#shelf-alert")).toContainText("Ctrl+Z");
  await shot(page, "strip-02-removed-with-undo-offer");

  await page.keyboard.press("Control+z");
  await expect(page.locator("#shelf-alert")).toContainText("back on the shelf");
  await shot(page, "strip-03-restored");

  await page.evaluate(
    ([event]) => window.__shotshelf__.emit(event, "0.3.0"),
    [UPDATE_EVENT] as const,
  );
  await expect(page.locator("#shelf-alert")).toContainText("available");
  await shot(page, "strip-04-update-available");
});

test("a lost capture reshapes a hidden window", async ({ page }) => {
  await bootShelf(page);
  await page.evaluate(([event]) => window.__shotshelf__.emit(event, null), [HIDDEN_EVENT] as const);
  await page.evaluate(
    ([event, message]) => window.__shotshelf__.emit(event, message),
    [PROBLEM_EVENT, "That capture could not be saved — it existed only in the clipboard."] as const,
  );
  await expect(page.locator("#shelf-alert")).toBeVisible();
  await shot(page, "strip-05-lost-capture-column");
});

test("focus walk, labelled", async ({ page }) => {
  await bootShelf(page);
  await land(page, FIXTURE.wide);
  await openBrowse(page);
  await settled(page);
  for (let step = 0; step < 8; step += 1) {
    await page.keyboard.press("Tab");
    const on = await page.evaluate(() => {
      const active = document.activeElement;
      if (!active) return "none";
      return active.id || active.className.split(" ")[0] || active.tagName;
    });
    await shot(page, `focus-${String(step).padStart(2, "0")}-${on.replaceAll(/[^\w-]/g, "_")}`);
  }
});

test.describe("emulations", () => {
  test.describe("reduced motion", () => {
    test("hover flattens instantly", async ({ page }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await bootShelf(page);
      await land(page, FIXTURE.wide);
      await openBrowse(page);
      await settled(page);
      await page.locator(".tile").hover();
      await shot(page.locator(".tile"), "emulate-00-reduced-motion-hover");
    });
  });

  test.describe("forced colors", () => {
    test("picked and secret survive high contrast", async ({ page }) => {
      await page.emulateMedia({ forcedColors: "active" });
      await bootShelf(page);
      await page.evaluate(
        ([secret]) => window.__shotshelf__.respond("describe_capture", secret),
        [SECRET] as const,
      );
      await land(page, FIXTURE.wide);
      await openBrowse(page);
      await page.keyboard.press("ArrowDown");
      await shot(page, "emulate-01-forced-colors-picked-secret");
    });
  });

  test.describe("2x", () => {
    test.use({ deviceScaleFactor: 2 });
    test("the dense surfaces at retina", async ({ page }) => {
      await bootShelf(page);
      await land(page, FIXTURE.wide);
      await openBrowse(page);
      await settled(page);
      await shot(page, "emulate-02-browse-2x");
    });
    test("the settings window at retina", async ({ page }) => {
      await page.setViewportSize(SETTINGS_VIEWPORT);
      await bootSettings(page);
      await settled(page);
      await shot(page, "emulate-03-settings-2x");
    });
  });
});
