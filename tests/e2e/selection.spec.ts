/**
 * Picking several captures out and dragging them together.
 *
 * The reason this exists at all: a before and an after are two captures, and
 * so is a sequence of steps. Dragging them one at a time into a conversation
 * loses the ordering that made them worth sending together.
 */

import { bootShelf, expect, FIXTURE, land, openBrowse, test } from "../harness/app.ts";

/**
 * Press a card on its picture.
 *
 * Upper-left of the card, deliberately. The action buttons sit top-right and
 * are excluded from picking, the filename label covers the bottom, and the
 * alert strip overlays the foot of the panel — a press at the card's bottom
 * edge lands on the strip rather than the card, which is how this helper
 * silently did nothing at all on the third card.
 */
async function pressCard(
  page: import("@playwright/test").Page,
  index: number,
  modifiers: { shift?: boolean; ctrl?: boolean } = {},
): Promise<void> {
  const card = page.locator(".tile").nth(index);
  await card.scrollIntoViewIfNeeded();
  const box = await card.boundingBox();
  expect(box).not.toBeNull();

  const keys: ("Shift" | "Control")[] = [];
  if (modifiers.shift) keys.push("Shift");
  if (modifiers.ctrl) keys.push("Control");

  for (const key of keys) await page.keyboard.down(key);
  await page.mouse.move(box!.x + 20, box!.y + 25);
  await page.mouse.down();
  await page.mouse.up();
  for (const key of keys) await page.keyboard.up(key);
}

async function threeCaptures(page: import("@playwright/test").Page): Promise<void> {
  await bootShelf(page);
  // Each capture stages as itself, so the order handed to the OS is
  // observable. A single shared stub made every ordering look identical.
  await page.evaluate(() =>
    window.__shotshelf__.respondWith("prepare_drag", (args) => ({
      path: args["path"],
      icon: args["path"],
    })),
  );
  await land(page, FIXTURE.wide, { ts: 1 });
  await land(page, FIXTURE.tall, { ts: 2 });
  await land(page, FIXTURE.square, { ts: 3 });
  await openBrowse(page);
  await expect(page.locator(".tile")).toHaveCount(3);
}

test("pressing a card picks it", async ({ page }) => {
  await threeCaptures(page);
  await pressCard(page, 0);

  await expect(page.locator(".tile--picked")).toHaveCount(1);
});

test("ctrl adds a second without dropping the first", async ({ page }) => {
  await threeCaptures(page);
  await pressCard(page, 0);
  await pressCard(page, 2, { ctrl: true });

  await expect(page.locator(".tile--picked")).toHaveCount(2);
});

test("shift takes everything between", async ({ page }) => {
  await threeCaptures(page);
  await pressCard(page, 0);
  await pressCard(page, 2, { shift: true });

  await expect(page.locator(".tile--picked")).toHaveCount(3);
});

test("a plain press on an unpicked card drops the rest", async ({ page }) => {
  await threeCaptures(page);
  await pressCard(page, 0);
  await pressCard(page, 1, { ctrl: true });
  await pressCard(page, 2);

  await expect(page.locator(".tile--picked")).toHaveCount(1);
});

test("dragging a picked card carries every picked capture", async ({ page }) => {
  await threeCaptures(page);
  await pressCard(page, 0);
  await pressCard(page, 1, { ctrl: true });
  await page.evaluate(() => {
    window.__shotshelf__.clearCalls();
    window.__shotshelf__.hang("plugin:drag|start_drag");
  });

  // Press an already-picked card and travel: the selection must survive the
  // press, or the drag begins with the wrong set.
  const card = page.locator(".tile").first();
  await card.scrollIntoViewIfNeeded();
  const box = await card.boundingBox();
  await page.mouse.move(box!.x + 20, box!.y + 25);
  await page.mouse.down();
  await page.mouse.move(150, 300);

  await expect
    .poll(() => page.evaluate(() => window.__shotshelf__.callsTo("prepare_drag").length))
    .toBe(2);

  // The order is the whole reason this feature exists: a before and an after
  // are only useful the right way round. Reversing `Selection.ids()` used to
  // pass every test in this file.
  const handed = await page.evaluate(
    () =>
      window.__shotshelf__.callsTo("plugin:drag|start_drag").at(-1)?.args["item"] as
        | string[]
        | undefined,
  );
  // Oldest first, regardless of which card was clicked first. "The order you
  // picked them" is not one order — it differs between a ctrl-click and a
  // shift-range — so capture time is the rule, and it is the same rule the
  // compare path uses.
  expect(handed).toEqual([FIXTURE.tall, FIXTURE.square]);

  await page.mouse.up();
});

test("dragging an unpicked card carries only that one", async ({ page }) => {
  await threeCaptures(page);
  await pressCard(page, 0);
  await page.evaluate(() => {
    window.__shotshelf__.clearCalls();
    window.__shotshelf__.hang("plugin:drag|start_drag");
  });

  const card = page.locator(".tile").nth(2);
  await card.scrollIntoViewIfNeeded();
  const box = await card.boundingBox();
  await page.mouse.move(box!.x + 20, box!.y + 25);
  await page.mouse.down();
  await page.mouse.move(150, 300);

  await expect
    .poll(() => page.evaluate(() => window.__shotshelf__.callsTo("prepare_drag").length))
    .toBe(1);

  await page.mouse.up();
});

test("a capture that leaves the shelf leaves the selection", async ({ page }) => {
  await threeCaptures(page);
  await pressCard(page, 0);
  await pressCard(page, 1, { ctrl: true });
  await expect(page.locator(".tile--picked")).toHaveCount(2);

  await page.locator(".tile").first().hover();
  await page.locator(".tile").first().locator(".tile__action--remove").click();

  // Two were picked and one is gone; a drag must never be handed a file that
  // is no longer on the shelf.
  await expect(page.locator(".tile")).toHaveCount(2);
  await expect(page.locator(".tile--picked")).toHaveCount(1);
});

test("a shift-selected range drags out oldest first", async ({ page }) => {
  // The same defect the compare path had, in the other consumer of a
  // selection: `extendTo` rebuilds the set in the order the shelf is showing,
  // which is newest-first, so a shift-selected before/after pair dragged out
  // backwards. Only ctrl-click was ever asserted, so the range case shipped
  // wrong while a comment above claimed order was what this file protected.
  await threeCaptures(page);
  await page.evaluate(() => {
    window.__shotshelf__.respondWith("prepare_drag", (args) => ({
      path: args["path"],
      icon: args["path"],
    }));
    window.__shotshelf__.hang("plugin:drag|start_drag");
  });

  // Index 0 is the newest; extend the range down to the oldest.
  await pressCard(page, 0);
  await pressCard(page, 2, { shift: true });

  const card = page.locator(".tile").nth(1);
  await card.scrollIntoViewIfNeeded();
  const box = await card.boundingBox();
  await page.mouse.move(box!.x + 20, box!.y + 25);
  await page.mouse.down();
  await page.mouse.move(150, 300);

  await expect
    .poll(() => page.evaluate(() => window.__shotshelf__.callsTo("prepare_drag").length))
    .toBe(3);

  const handed = await page.evaluate(
    () =>
      window.__shotshelf__.callsTo("plugin:drag|start_drag").at(-1)?.args["item"] as
        | string[]
        | undefined,
  );
  // ts 1, 2, 3 — oldest first, whichever end of the range was clicked.
  expect(handed).toEqual([FIXTURE.wide, FIXTURE.tall, FIXTURE.square]);

  await page.mouse.up();
});
