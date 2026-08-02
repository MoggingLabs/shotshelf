/**
 * The themed tooltip, which replaced every native `title` in the app.
 *
 * The OS tooltip could not be themed and routinely surfaced behind the
 * always-on-top popover; `src/ui/tooltip.ts` answers `data-tip` instead.
 * What these tests pin: the hover delay proves intent, focus answers
 * immediately (a Tab press needs no proving), and Escape takes the bubble
 * away without being consumed — the shelf's own ladder still runs.
 */

import { bootShelf, expect, FIXTURE, land, openBrowse, test } from "../harness/app.ts";

test("a hover answers after the delay, not before", async ({ page }) => {
  await page.clock.install();
  await bootShelf(page);
  await openBrowse(page);

  await page.locator("#shelf-settings").hover();
  // Half the delay: still nothing — a pointer passing through is not a
  // question.
  await page.clock.runFor(250);
  await expect(page.locator(".tip")).toBeHidden();

  await page.clock.runFor(400);
  await expect(page.locator(".tip")).toBeVisible();
  await expect(page.locator(".tip")).toHaveText("Settings");
});

test("focus answers immediately and escape takes it away", async ({ page }) => {
  await bootShelf(page);
  await land(page, FIXTURE.wide);
  await openBrowse(page);

  await page.locator("#shelf-hide").focus();
  await expect(page.locator(".tip")).toBeVisible();
  await expect(page.locator(".tip")).toContainText("Hide the shelf");

  await page.keyboard.press("Escape");
  await expect(page.locator(".tip")).toBeHidden();
  // And the press was not consumed: the shelf's Escape ladder still ran.
  await expect
    .poll(() => page.evaluate(() => window.__shotshelf__.callsTo("hide_shelf").length))
    .toBe(1);
});

test("the tip carries the pin's whole explanation, themed", async ({ page }) => {
  // The pin tooltip is the one that teaches what pinning does; it must
  // survive the migration word for word, multi-line and all.
  await page.clock.install();
  await bootShelf(page);
  await land(page, FIXTURE.wide);
  await openBrowse(page);

  await page.locator(".tile").hover();
  await page.locator(".tile__action--pin").hover();
  await page.clock.runFor(600);

  await expect(page.locator(".tip")).toBeVisible();
  await expect(page.locator(".tip")).toContainText(/Pin to keep this capture/);
});

test("no native title survives anywhere on the shelf", async ({ page }) => {
  // One stray `title=` brings the OS tooltip back beside the themed one —
  // two bubbles, two styles. The census is the guard.
  await bootShelf(page);
  await land(page, FIXTURE.wide);
  await openBrowse(page);
  await page.locator(".tile").hover();

  expect(await page.locator("[title]").count()).toBe(0);
});
