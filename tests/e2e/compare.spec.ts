/**
 * Putting a before and an after side by side.
 *
 * Shotshelf is the only thing in the loop that sees both captures — the OS
 * hands over one file at a time and the chat receives one image at a time —
 * so this is the one place the pair can become a single thing to drag.
 */

import { bootShelf, expect, FIXTURE, land, openBrowse, test } from "../harness/app.ts";

async function pickTwo(page: import("@playwright/test").Page): Promise<void> {
  await bootShelf(page);
  await land(page, FIXTURE.wide, { ts: 1 });
  await land(page, FIXTURE.tall, { ts: 2 });
  await openBrowse(page);

  for (const index of [0, 1]) {
    const card = page.locator(".tile").nth(index);
    await card.scrollIntoViewIfNeeded();
    const box = await card.boundingBox();
    if (index === 1) await page.keyboard.down("Control");
    await page.mouse.move(box!.x + 20, box!.y + 25);
    await page.mouse.down();
    await page.mouse.up();
    if (index === 1) await page.keyboard.up("Control");
  }
}

test("the compare control appears only for exactly two captures", async ({ page }) => {
  await bootShelf(page);
  await land(page, FIXTURE.wide, { ts: 1 });
  await land(page, FIXTURE.tall, { ts: 2 });
  await land(page, FIXTURE.square, { ts: 3 });
  await openBrowse(page);

  const compare = page.locator("#shelf-compare");
  await expect(compare).toBeHidden();

  const press = async (index: number, ctrl: boolean): Promise<void> => {
    const card = page.locator(".tile").nth(index);
    await card.scrollIntoViewIfNeeded();
    const box = await card.boundingBox();
    if (ctrl) await page.keyboard.down("Control");
    await page.mouse.move(box!.x + 20, box!.y + 25);
    await page.mouse.down();
    await page.mouse.up();
    if (ctrl) await page.keyboard.up("Control");
  };

  await press(0, false);
  await expect(compare).toBeHidden();

  await press(1, true);
  await expect(compare).toBeVisible();

  // A comparison of three is not a thing.
  await press(2, true);
  await expect(compare).toBeHidden();
});

test("comparing sends the before first and puts the result on the shelf", async ({ page }) => {
  await pickTwo(page);
  await page.evaluate(() =>
    window.__shotshelf__.respond("compare_captures", "/edits/wide (compared).png"),
  );

  await page.locator("#shelf-compare").click();

  const call = await page.evaluate(
    () => window.__shotshelf__.callsTo("compare_captures").at(-1)?.args,
  );
  // Cards render newest-added first, so index 0 is `tall` and it was picked
  // first. Order comes from the selection, not from the shelf: comparing an
  // after against a before reads as every change reversed.
  expect(call).toEqual({ before: FIXTURE.tall, after: FIXTURE.wide });

  // The result joins the shelf as a capture of its own; neither input moved.
  await expect(page.locator(".tile")).toHaveCount(3);
  await expect(page.locator("#shelf-count")).toHaveText("3 captures");
});

test("comparing clears the selection so the control does not linger", async ({ page }) => {
  await pickTwo(page);
  await page.evaluate(() =>
    window.__shotshelf__.respond("compare_captures", "/edits/wide (compared).png"),
  );

  await page.locator("#shelf-compare").click();

  await expect(page.locator("#shelf-compare")).toBeHidden();
  await expect(page.locator(".tile--picked")).toHaveCount(0);
});

test("a comparison that fails says so and keeps both captures", async ({ page }) => {
  await pickTwo(page);
  await page.evaluate(() =>
    window.__shotshelf__.reject("compare_captures", "could not decode"),
  );

  await page.locator("#shelf-compare").click();

  await expect(page.locator("#shelf-alert")).toBeVisible();
  await expect(page.locator(".tile")).toHaveCount(2);
});
