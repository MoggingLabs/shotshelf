/**
 * The visual gate that runs everywhere.
 *
 * Pixel goldens are pinned to one OS because font rasterisation differs
 * between them; these assertions are about geometry and computed style, so
 * they hold identically on every platform and never flake on a shadow.
 *
 * Every rule below is one that has actually broken. A shelf whose thumbnails
 * are unrecognisable still passes every behavioural test ever written — the
 * cards are there, the counts are right, the drags work — which is precisely
 * why appearance needs gating of its own.
 */

import { bootShelf, expect, FIXTURE, land, openBrowse, test } from "../harness/app.ts";

/** The card geometry the column window is sized against. */
const CARD_WIDTH = 199;
const CARD_HEIGHT = 112;

test("a card is 16:9, the shape of the screen it came from", async ({ page }) => {
  await bootShelf(page);
  await land(page, FIXTURE.wide);

  const box = await page.locator(".tile").boundingBox();
  expect(box).not.toBeNull();
  // The original 3.8:1 tile kept only the middle 46% of a 1080p capture and
  // threw away the top, which is where a screenshot keeps its meaning.
  expect(box!.width / box!.height).toBeCloseTo(16 / 9, 1);
});

test("a card is the same size in the column and in the browse view", async ({ page }) => {
  await bootShelf(page);
  await land(page, FIXTURE.wide);

  const inColumn = await page.locator(".tile").boundingBox();
  await openBrowse(page);
  const inBrowse = await page.locator(".tile").boundingBox();

  // The whole point of the column: what pops up is the card you already know.
  expect(inColumn!.width).toBeCloseTo(inBrowse!.width, 0);
  expect(inColumn!.height).toBeCloseTo(inBrowse!.height, 0);
  expect(inColumn!.width).toBeCloseTo(CARD_WIDTH, 0);
  expect(inColumn!.height).toBeCloseTo(CARD_HEIGHT, 0);
});

test("thumbnails are fitted whole, never cropped to their middle", async ({ page }) => {
  await bootShelf(page);
  await land(page, FIXTURE.tall);

  // `cover` on a portrait capture in a 16:9 card discards most of it. `contain`
  // is what keeps an odd-shaped capture identifiable.
  await expect(page.locator(".tile__thumb")).toHaveCSS("object-fit", "contain");
});

test("the bars beside a fitted thumbnail carry a wash of the capture itself", async ({ page }) => {
  await bootShelf(page);
  await land(page, FIXTURE.tall);

  const wash = await page
    .locator(".tile")
    .evaluate((tile) => getComputedStyle(tile).getPropertyValue("--wash"));
  expect(wash).toContain("url(");

  // And the wash sits behind the picture, not over it.
  const order = await page.locator(".tile").evaluate((tile) => {
    const before = getComputedStyle(tile, "::before");
    return { position: before.position, opacity: Number(before.opacity) };
  });
  expect(order.position).toBe("absolute");
  expect(order.opacity).toBeGreaterThan(0);
  expect(order.opacity).toBeLessThan(1);
});

test("a recording keeps its film glyph and never renders a wash it has no picture for", async ({
  page,
}) => {
  await bootShelf(page);
  await page.evaluate(() =>
    window.__shotshelf__.reject("video_details", "ffmpeg unavailable"),
  );
  await land(page, "/clips/screencast.mp4", { kind: "video" });

  await expect(page.locator(".tile__thumb--glyph")).toBeVisible();
  const wash = await page
    .locator(".tile")
    .evaluate((tile) => getComputedStyle(tile).getPropertyValue("--wash"));
  expect(wash.trim()).toBe("");
});

test("a capture whose file has gone shows a warning rather than a hole", async ({ page }) => {
  await bootShelf(page);
  await land(page, FIXTURE.missing);

  // The fixture route 404s this one, so the real image error path runs.
  await expect(page.locator(".tile__thumb--missing")).toBeVisible();
});

test("the shelf is one column in both shapes", async ({ page }) => {
  await bootShelf(page);
  await land(page, FIXTURE.wide, { ts: 1 });
  await land(page, FIXTURE.tall, { ts: 2 });

  const columnTracks = await trackCount(page);
  await openBrowse(page);
  const browseTracks = await trackCount(page);

  // Two columns at 225 wide leaves a card too small to recognise anything in.
  expect(columnTracks).toBe(1);
  expect(browseTracks).toBe(1);
});

test("the popover's corner radius matches what rounds the window", async ({ page }) => {
  await bootShelf(page);

  const radius = await page.locator(".shelf").evaluate((el) => getComputedStyle(el).borderRadius);
  // Which OS this is comes from the test process, not from the page.
  //
  // The page's answer is `data-os`, which `main.ts` sets by sniffing the user
  // agent — and the radius is selected by that same attribute. Asking the page
  // therefore compared the stylesheet against itself: if the sniff regressed,
  // `data-os` went undefined, the expectation moved to "14px", the CSS
  // override stopped matching, and the test passed while the window showed the
  // exact wedge it exists to catch.
  const onWindows = process.platform === "win32";

  // On Windows the window itself is rounded by DWM at a fixed 8px, and a panel
  // that disagrees leaves the acrylic backdrop showing as a wedge in each
  // corner — which is exactly what "the corners look square" turned out to be.
  expect(radius).toBe(onWindows ? "8px" : "14px");

  // And the sniff that selects it is asserted rather than assumed.
  const flagged = await page.evaluate(() => document.documentElement.dataset["os"]);
  expect(flagged).toBe(onWindows ? "windows" : undefined);
});

test("card controls stay out of the way until you hover", async ({ page }) => {
  await bootShelf(page);
  await land(page, FIXTURE.wide);

  const actions = page.locator(".tile__actions");
  expect(await actions.evaluate((el) => Number(getComputedStyle(el).opacity))).toBe(0);

  await page.locator(".tile").hover();
  await expect
    .poll(() => actions.evaluate((el) => Number(getComputedStyle(el).opacity)))
    .toBeGreaterThan(0);
});

test("the empty state is centred, and stops being centred once a capture lands", async ({
  page,
}) => {
  await bootShelf(page);
  await openBrowse(page);
  await expect(page.locator("#shelf-items")).toHaveAttribute("data-empty", "true");

  await land(page, FIXTURE.wide);
  await openBrowse(page);

  // The flag was once set but never cleared, which left the grid centring
  // itself on content that was no longer empty.
  await expect(page.locator("#shelf-items")).toHaveAttribute("data-empty", "false");
});

/**
 * How many columns the card grid is laid out in.
 *
 * Returns 0 when the element is not a grid at all, which is the case this has
 * to be able to tell apart. `gridTemplateColumns` computes to the single token
 * `"none"` on a non-grid, so splitting on whitespace and counting gave 1 —
 * indistinguishable from one column, and green with `display: grid` deleted
 * from the stylesheet outright.
 */
async function trackCount(page: import("@playwright/test").Page): Promise<number> {
  return page
    .locator(".group__grid")
    .first()
    .evaluate((grid) => {
      const style = getComputedStyle(grid);
      if (!style.display.includes("grid")) return 0;
      const tracks = style.gridTemplateColumns;
      if (tracks === "none" || tracks === "") return 0;
      return tracks.split(/\s+/).filter(Boolean).length;
    });
}
