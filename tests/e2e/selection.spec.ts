/**
 * Picking several captures out and dragging them together.
 *
 * The reason this exists at all: a before and an after are two captures, and
 * so is a sequence of steps. Dragging them one at a time into a conversation
 * loses the ordering that made them worth sending together.
 */

import { bootShelf, expect, FIXTURE, land, openBrowse, test } from "../harness/app.ts";
import captureMissing from "../fixtures/capture-missing.json" with { type: "json" };

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
  modifiers: { shift?: boolean; ctrl?: boolean; meta?: boolean } = {},
): Promise<void> {
  const card = page.locator(".tile").nth(index);
  await card.scrollIntoViewIfNeeded();
  const box = await card.boundingBox();
  expect(box).not.toBeNull();

  // `Meta` separately from `Control`, not through Playwright's `ControlOrMeta`,
  // which resolves by *host* — so on every runner this project uses it is
  // Control, and the `event.metaKey` half of `#pick` had never been pressed.
  // Dropping it left the suite green while ⌘-click, the only multi-select
  // gesture a Mac user has, stopped working.
  const keys: ("Shift" | "Control" | "Meta")[] = [];
  if (modifiers.shift) keys.push("Shift");
  if (modifiers.ctrl) keys.push("Control");
  if (modifiers.meta) keys.push("Meta");

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

test("a drag hands the OS a copy, never a move", async ({ page }) => {
  // The invariant the whole product rests on, and it was enforced by a single
  // string literal with nothing asserting it. `tauri-plugin-drag` maps
  // `Move` to DROPEFFECT_MOVE on Windows, so the wrong value here relocates
  // the user's original capture off their disk. Three docstrings promise this;
  // now something checks it.
  await bootShelf(page);
  await land(page, FIXTURE.wide);
  await openBrowse(page);
  await page.evaluate(() => {
    window.__shotshelf__.respondWith("prepare_drag", (args) => ({
      path: args["path"],
      icon: args["path"],
    }));
    window.__shotshelf__.hang("plugin:drag|start_drag");
  });

  const card = page.locator(".tile").first();
  const box = await card.boundingBox();
  await page.mouse.move(box!.x + 20, box!.y + 25);
  await page.mouse.down();
  await page.mouse.move(box!.x + 60, box!.y + 70, { steps: 6 });

  await expect
    .poll(() => page.evaluate(() => window.__shotshelf__.callsTo("plugin:drag|start_drag").length))
    .toBeGreaterThan(0);

  const call = await page.evaluate(
    () => window.__shotshelf__.callsTo("plugin:drag|start_drag").at(-1)?.args,
  );
  // The plugin sends the drag options under `options`, alongside the file
  // list and the cursor image.
  const options = call?.["options"] as Record<string, unknown> | undefined;
  expect(options?.["mode"]).toBe("copy");

  await page.mouse.up();
});

test("a drag that cannot start says so instead of doing nothing", async ({ page }) => {
  // Dragging out is what this app is for, and it was the only failure path
  // with no report anywhere the user could see. The common real cause is a
  // capture deleted after its tile was built: the thumbnail is already loaded,
  // so no `error` event fires and the card shows no warning either. Press,
  // drag, drop — and nothing happens, with the reason only in the console.
  //
  // Left in the peeked column deliberately — no `openBrowse`. This test used to
  // open the browse view first, which proved the report only in the mode where
  // a drag is least likely; the column shape was hiding the strip outright, so
  // the fix it was written to prove did not work where it mattered. And it
  // asserted `toContainText`, which passes on a `display: none` element, so it
  // stayed green throughout.
  await bootShelf(page);
  await land(page, FIXTURE.wide);
  // The sentence read from the fixture Rust asserts against, rather than a
  // third hand-written copy of it.
  await page.evaluate(
    (message) => window.__shotshelf__.reject("prepare_drag", message),
    `that capture ${captureMissing.missing}`,
  );

  const tile = page.locator(".tile");
  await tile.hover();
  await page.mouse.down();
  await page.mouse.move(140, 240, { steps: 4 });
  await page.mouse.up();

  await expect(page.locator("#shelf-alert")).toBeVisible();
  await expect(page.locator("#shelf-alert")).toContainText(/could not be dragged out/i);
});

test("command-click adds a second, the same as ctrl-click", async ({ page }) => {
  // `#pick` accepts `event.ctrlKey || event.metaKey`, and every spec pressed
  // Control: dropping `|| event.metaKey` left the whole suite green while
  // ⌘-click — the gesture docs/USAGE.md documents for Mac, and the only
  // multi-select a Mac user has — silently became a plain click that dropped
  // the rest of the selection.
  //
  // Playwright's `ControlOrMeta` would not have caught it either: it resolves
  // against the *host*, so on every runner this project uses it is Control.
  await threeCaptures(page);
  await pressCard(page, 0);
  await pressCard(page, 2, { meta: true });

  await expect(page.locator(".tile--picked")).toHaveCount(2);
});

test("a capture leaving the shelf takes its quick look with it", async ({ page }) => {
  // `#release`'s preview close, which nothing reached.
  //
  // Every spec that opens a quick look closes it deliberately — Space, Escape —
  // so none of them has the capture pulled out from under it. The three routes
  // that do that are the ×, the item cap and the retention sweep, and the sweep
  // is not vetoed by `overlayOpen` the way `#ageColumn` is. Without this, the
  // quick look stays up showing a full-size picture of a capture the shelf no
  // longer holds, dismissable only with Escape.
  await bootShelf(page, { settings: { maxItems: 1 } });
  // The quick look asks Rust to reshape the window; the stub has to answer or
  // the open never completes.
  await page.evaluate(() => window.__shotshelf__.respond("preview_shelf", [220, 124]));
  await land(page, FIXTURE.wide);
  await openBrowse(page);

  await page.keyboard.press("ArrowDown");
  await page.keyboard.press(" ");
  await expect(page.locator(".preview")).toHaveCount(1);

  // A second capture evicts the first, which is the one on screen.
  await land(page, FIXTURE.tall);

  await expect(page.locator(".preview")).toHaveCount(0);
});
