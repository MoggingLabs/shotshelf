/**
 * Driving the shelf from the keyboard, and reading a capture at full size.
 *
 * The shelf is summoned by a hotkey, so reaching for the mouse to act on what
 * it shows undoes the point of summoning it that way. And at 225px wide a card
 * is enough to *recognise* a screenshot and nowhere near enough to read one —
 * without a preview, checking which of two similar captures you are about to
 * send means opening it in another app, which is the round trip the shelf
 * exists to save.
 */

import { bootShelf, expect, FIXTURE, land, openBrowse, test } from "../harness/app.ts";

async function threeOpen(page: import("@playwright/test").Page): Promise<void> {
  await bootShelf(page);
  await page.evaluate(() => window.__shotshelf__.respond("preview_shelf", [800, 450]));
  await land(page, FIXTURE.wide, { ts: 1 });
  await land(page, FIXTURE.tall, { ts: 2 });
  await land(page, FIXTURE.square, { ts: 3 });
  await openBrowse(page);
  await expect(page.locator(".tile")).toHaveCount(3);
}

test("arrows walk the shelf in the order it is shown", async ({ page }) => {
  await threeOpen(page);

  await page.keyboard.press("ArrowDown");
  await expect(page.locator(".tile--picked")).toHaveCount(1);
  // The first press lands on the newest, which is the top of the list.
  await expect(page.locator(".tile").first()).toHaveClass(/tile--picked/);

  await page.keyboard.press("ArrowDown");
  await expect(page.locator(".tile").nth(1)).toHaveClass(/tile--picked/);

  await page.keyboard.press("ArrowUp");
  await expect(page.locator(".tile").first()).toHaveClass(/tile--picked/);
});

test("arrowing past either end stays put rather than wrapping", async ({ page }) => {
  await threeOpen(page);

  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expect(page.locator(".tile").first()).toHaveClass(/tile--picked/);

  for (let press = 0; press < 6; press += 1) await page.keyboard.press("ArrowDown");
  // Wrapping around a list you are reading top to bottom loses your place.
  await expect(page.locator(".tile").last()).toHaveClass(/tile--picked/);
  await expect(page.locator(".tile--picked")).toHaveCount(1);
});

test("space shows the picked capture large, and space closes it", async ({ page }) => {
  await threeOpen(page);
  await page.keyboard.press("ArrowDown");

  await page.keyboard.press(" ");
  await expect(page.locator(".preview__picture")).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.__shotshelf__.callsTo("preview_shelf").length))
    .toBe(1);

  await page.keyboard.press(" ");
  await expect(page.locator(".preview")).toHaveCount(0);
  // Closing a preview is "show the browse view, focused" — the same command
  // that opens it. A second command doing exactly that was two names for one
  // behaviour and two pieces of webview-reachable surface.
  await expect
    .poll(async () => {
      const calls = await page.evaluate(() => window.__shotshelf__.callsTo("show_shelf"));
      return calls.filter((call) => call.args["focus"] === true).length;
    })
    .toBe(1);
});

test("escape backs out of the preview before it backs out of the shelf", async ({ page }) => {
  await threeOpen(page);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press(" ");
  await expect(page.locator(".preview")).toHaveCount(1);
  await page.evaluate(() => window.__shotshelf__.clearCalls());

  await page.keyboard.press("Escape");
  await expect(page.locator(".preview")).toHaveCount(0);
  // One key closing two things at once is one key that loses your place.
  expect(await page.evaluate(() => window.__shotshelf__.callsTo("hide_shelf").length)).toBe(0);

  await page.keyboard.press("Escape");
  await expect
    .poll(() => page.evaluate(() => window.__shotshelf__.callsTo("hide_shelf").length))
    .toBe(1);
});

test("a recording has no preview to show", async ({ page }) => {
  await bootShelf(page);
  await page.evaluate(() => {
    window.__shotshelf__.respond("video_details", { poster: null, durationMs: 1, bytes: 1 });
    window.__shotshelf__.respond("preview_shelf", [800, 450]);
  });
  await land(page, "/clips/a.mp4", { kind: "video" });
  await openBrowse(page);

  await page.keyboard.press("ArrowDown");
  await page.keyboard.press(" ");

  // A still frame blown up is not a preview of a video, and playing one is a
  // media player rather than a shelf.
  await expect(page.locator(".preview")).toHaveCount(0);
  expect(await page.evaluate(() => window.__shotshelf__.callsTo("preview_shelf").length)).toBe(0);
});

test("enter copies the picked capture", async ({ page }) => {
  await threeOpen(page);
  await page.keyboard.press("ArrowDown");
  await page.evaluate(() => window.__shotshelf__.clearCalls());

  await page.keyboard.press("Enter");

  await expect
    .poll(() => page.evaluate(() => window.__shotshelf__.callsTo("copy_capture").length))
    .toBe(1);
});

test("delete takes it off the shelf without touching the file", async ({ page }) => {
  await threeOpen(page);
  await page.keyboard.press("ArrowDown");
  await page.evaluate(() => window.__shotshelf__.clearCalls());

  await page.keyboard.press("Delete");

  await expect(page.locator(".tile")).toHaveCount(2);
  const allowed = new Set(["set_pinned", "set_capture_count", "forget_video", "describe_capture"]);
  const commands = await page.evaluate(() => window.__shotshelf__.calls().map((call) => call.cmd));
  expect([...new Set(commands)].filter((cmd) => !allowed.has(cmd))).toEqual([]);
});

test("the shelf keys do not fire while the settings panel is open", async ({ page }) => {
  await threeOpen(page);

  // Something has to be picked for Delete to have anything to remove.
  // Without this the test passed with the settings guard deleted, because
  // Delete on an empty selection removes nothing either way — it asserted a
  // property of the fixture rather than of the code.
  await page.keyboard.press("ArrowDown");
  await expect(page.locator(".tile--picked")).toHaveCount(1);

  await page.locator("#shelf-settings").click();
  await expect(page.locator("#settings-panel")).toBeVisible();

  // Typing a hotkey into the settings panel is not a shelf command.
  await page.keyboard.press("Delete");
  await expect(page.locator(".tile")).toHaveCount(3);

  // And it is genuinely only the panel holding it back: closing it lets the
  // same keystroke through. Closed with the button rather than Escape, which
  // is bound to backing out of the shelf itself.
  await page.locator("#shelf-settings").click();
  await expect(page.locator("#settings-panel")).toBeHidden();
  await page.keyboard.press("Delete");
  await expect(page.locator(".tile")).toHaveCount(2);
});
