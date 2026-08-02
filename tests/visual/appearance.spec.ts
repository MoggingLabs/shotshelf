/**
 * Pixel goldens.
 *
 * Pinned to Linux, and skipped everywhere else. Font rasterisation differs
 * between operating systems, so a golden taken on one and compared on another
 * fails on every glyph and tells you nothing — a gate that cries wolf is a
 * gate people learn to ignore, which is worse than no gate at all. The
 * deterministic half of the appearance gate lives in `layout.spec.ts` and runs
 * on every platform.
 *
 * Update goldens with `npm run test:visual -- --update-snapshots` on Linux, or
 * through the CI job, and read the diff before committing it: a golden updated
 * without being looked at is a regression signed off by accident.
 */

import { bootShelf, DAY, expect, FIXTURE, land, NOW, openBrowse, test } from "../harness/app.ts";

test.describe("appearance", () => {
  test.skip(
    process.platform !== "linux",
    "goldens are taken on Linux; other platforms rasterise text differently",
  );

  test.beforeEach(async ({ page }) => {
    await page.clock.install({ time: new Date(NOW) });
  });

  /** Wait for every picture to finish loading, so a golden is never a race. */
  async function settled(page: import("@playwright/test").Page): Promise<void> {
    await page.waitForFunction(() =>
      [...document.images].every((image) => image.complete && image.naturalWidth > 0),
    );
    // The wash is a CSS background, not an <img>, so give paint a frame.
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
  }

  /** The editor, mounted and painted, ready to be photographed. */
  async function openEditorForGolden(page: import("@playwright/test").Page): Promise<void> {
    await bootShelf(page);
    await page.evaluate(() => window.__shotshelf__.respond("preview_shelf", null));
    await land(page, FIXTURE.wide);
    await openBrowse(page);
    await page.keyboard.press("ArrowDown");
    await page.locator("#shelf-edit").click();
    await expect(page.locator(".editor__canvas")).toBeVisible();
    await settled(page);
  }

  test("the editor, open on a capture", async ({ page }) => {
    // The editor is the largest visual feature in the app — two modules of it,
    // `src/editor/index.ts` and `src/editor/draw.ts` — and had **no committed
    // image of itself**, while the shelf had six. (A line count stood here and
    // had drifted by fifty, in a repo whose own gates argue that a tally in
    // prose goes stale and a criterion does not.) The canvas-pixel tests next door
    // check that two code paths agree with each other; nothing checked that
    // either of them renders what it should. A toolbar that loses its layout,
    // a stage that stops centring, a control that disappears: all invisible.
    await openEditorForGolden(page);
    await expect(page.locator(".editor")).toHaveScreenshot("editor.png");
  });

  test("the quick look, open on a capture", async ({ page }) => {
    await bootShelf(page);
    await page.evaluate(() => window.__shotshelf__.respond("preview_shelf", null));
    await land(page, FIXTURE.wide);
    await openBrowse(page);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press(" ");
    await expect(page.locator(".preview__picture")).toBeVisible();
    await settled(page);
    await expect(page.locator(".preview")).toHaveScreenshot("preview.png");
  });

  test("the settings panel", async ({ page }) => {
    // Seven controls, and their layout is the only place the app asks the user
    // for anything.
    await bootShelf(page);
    await openBrowse(page);
    await page.locator("#shelf-settings").click();
    await expect(page.locator("#settings-panel")).toBeVisible();
    await settled(page);
    await expect(page.locator("#settings-panel")).toHaveScreenshot("settings.png");
  });

  test("a card carrying a credential warning", async ({ page }) => {
    // The badge that says "this screenshot has a token in it" — the most
    // consequential thing the shelf draws, and it had no image either.
    await bootShelf(page);
    await page.evaluate(() =>
      window.__shotshelf__.respond("describe_capture", {
        scanned: true,
        secrets: [{ kind: "serviceToken", label: "GitHub token", preview: "ghp_••••••" }],
      }),
    );
    await land(page, FIXTURE.wide);
    await openBrowse(page);
    await expect(page.locator(".tile__secret")).toBeVisible();
    await settled(page);
    await expect(page.locator(".shelf")).toHaveScreenshot("secret-warning.png");
  });

  test("the empty shelf", async ({ page }) => {
    await bootShelf(page);
    await openBrowse(page);
    await expect(page.locator(".shelf")).toHaveScreenshot("empty.png");
  });

  test("one card in the column", async ({ page }) => {
    await bootShelf(page);
    await land(page, FIXTURE.wide);
    await settled(page);
    await expect(page.locator(".shelf")).toHaveScreenshot("column-one.png");
  });

  test("a column of three, in three different shapes", async ({ page }) => {
    await bootShelf(page);
    await land(page, FIXTURE.wide, { ts: 1 });
    await land(page, FIXTURE.tall, { ts: 2 });
    await land(page, FIXTURE.square, { ts: 3 });
    await settled(page);
    // The two odd shapes are the point: fitted whole, with the bars either
    // side carrying a blurred wash of the capture itself.
    await expect(page.locator(".shelf")).toHaveScreenshot("column-three.png");
  });

  test("the browse view, grouped by day", async ({ page }) => {
    await bootShelf(page);
    await land(page, FIXTURE.wide, { ts: NOW - DAY });
    await land(page, FIXTURE.tall, { ts: NOW - 2 * DAY });
    await openBrowse(page);
    await settled(page);
    await expect(page.locator(".shelf")).toHaveScreenshot("browse.png");
  });

  test("a card with its controls showing", async ({ page }) => {
    await bootShelf(page);
    await land(page, FIXTURE.wide);
    await settled(page);
    await page.locator(".tile").hover();
    await expect(page.locator(".tile")).toHaveScreenshot("tile-hover.png");
  });

  test("a capture whose file has gone", async ({ page }) => {
    await bootShelf(page);
    await land(page, FIXTURE.missing);
    await expect(page.locator(".tile")).toHaveScreenshot("tile-missing.png");
  });

  // ── Composed states ──────────────────────────────────────────────────
  // The audit's worst finds were compositions losing to specificity: hover
  // erasing the picked ring, picking erasing the credential rim, the pinned
  // star floating mid-edge. Each is a single box-shadow or width rule away
  // from regressing invisibly, so each composition gets its own image.

  test("a pinned card at rest anchors its star to the corner", async ({ page }) => {
    await bootShelf(page);
    await land(page, FIXTURE.wide);
    await openBrowse(page);
    await page.locator(".tile").hover();
    await page.locator(".tile__action--pin").click();
    await page.mouse.move(0, 0);
    await settled(page);
    await expect(page.locator(".tile")).toHaveScreenshot("pinned-at-rest.png");
  });

  test("a pinned credential-carrying card keeps both corners", async ({ page }) => {
    // The corner-grammar worst case: safety top-left, state top-right,
    // neither erasing the other.
    await bootShelf(page);
    await page.evaluate(() =>
      window.__shotshelf__.respond("describe_capture", {
        scanned: true,
        secrets: [{ kind: "serviceToken", label: "GitHub token", preview: "ghp_••••••" }],
      }),
    );
    await land(page, FIXTURE.wide);
    await openBrowse(page);
    await expect(page.locator(".tile__secret")).toBeVisible();
    await page.locator(".tile").hover();
    await page.locator(".tile__action--pin").click();
    await page.mouse.move(0, 0);
    await settled(page);
    await expect(page.locator(".tile")).toHaveScreenshot("pinned-secret-at-rest.png");
  });

  test("a picked card under the pointer keeps its ring", async ({ page }) => {
    await bootShelf(page);
    await land(page, FIXTURE.wide);
    await openBrowse(page);
    await page.keyboard.press("ArrowDown");
    await page.locator(".tile").hover();
    await settled(page);
    await expect(page.locator(".tile")).toHaveScreenshot("picked-under-hover.png");
  });

  test("picking a credential-carrying card keeps the warning rim", async ({ page }) => {
    await bootShelf(page);
    await page.evaluate(() =>
      window.__shotshelf__.respond("describe_capture", {
        scanned: true,
        secrets: [{ kind: "serviceToken", label: "GitHub token", preview: "ghp_••••••" }],
      }),
    );
    await land(page, FIXTURE.wide);
    await openBrowse(page);
    await expect(page.locator(".tile__secret")).toBeVisible();
    await page.keyboard.press("ArrowDown");
    await settled(page);
    await expect(page.locator(".tile")).toHaveScreenshot("secret-picked.png");
  });

  test("a multi-pick marks the cursor card and counts itself", async ({ page }) => {
    await bootShelf(page);
    await land(page, FIXTURE.wide, { ts: 1 });
    await land(page, FIXTURE.tall, { ts: 2 });
    await land(page, FIXTURE.square, { ts: 3 });
    await openBrowse(page);
    await page.keyboard.press("ArrowDown");
    await page.locator(".tile").last().click({ modifiers: ["Shift"] });
    await page.mouse.move(0, 0);
    await settled(page);
    await expect(page.locator(".shelf")).toHaveScreenshot("multi-pick-cursor.png");
  });
});
