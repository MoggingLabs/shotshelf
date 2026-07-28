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
});
