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

import { bootShelf, BOUNDS, expect, FIXTURE, land, openBrowse, test } from "../harness/app.ts";

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

test("changing a setting saves it and applies it to the shelf", async ({ page }) => {
  // The settings panel's write path had no test of any kind: not the save, not
  // the clamp coming back from Rust, not the error surface, and not the
  // `loaded` guard that stops an empty pinned list overwriting the user's
  // pins. Its twin in `persistPinned` was covered, which made the gap look
  // deliberate.
  await bootShelf(page, { settings: { maxItems: 50 } });
  await land(page, FIXTURE.wide, { ts: 1 });
  await land(page, FIXTURE.tall, { ts: 2 });
  await land(page, FIXTURE.square, { ts: 3 });
  await openBrowse(page);
  await expect(page.locator(".tile")).toHaveCount(3);

  // Rust clamps and returns what it stored; the front end adopts **that**
  // answer, not the value it sent.
  //
  // The stub answers with something different from the request on purpose.
  // It used to echo `args["settings"]` straight back, which made request and
  // response identical — so a `save()` that ignored the result entirely and
  // kept `{...current, ...patch}` passed a test named for adopting the answer.
  await page.evaluate(() =>
    window.__shotshelf__.respondWith("set_settings", (args) => ({
      ...(args["settings"] as Record<string, unknown>),
      maxItems: 1,
    })),
  );
  await page.locator("#shelf-settings").click();
  await page.locator("#setting-max").fill("25");
  await page.locator("#setting-max").dispatchEvent("change");

  const saved = await page.evaluate(
    () => window.__shotshelf__.callsTo("set_settings").at(-1)?.args,
  );
  expect((saved?.["settings"] as Record<string, unknown>)["maxItems"]).toBe(25);

  // One tile rather than three: the shelf honoured the 1 that came back, not
  // the 25 it asked for, and did it immediately rather than at next launch.
  await expect(page.locator(".tile")).toHaveCount(1);
});

test("a settings save that fails says so in the panel", async ({ page }) => {
  await bootShelf(page);
  await page.evaluate(() => window.__shotshelf__.reject("set_settings", "disk is full"));

  await page.locator("#shelf-settings").click();
  await page.locator("#setting-max").fill("12");
  await page.locator("#setting-max").dispatchEvent("change");

  await expect(page.locator("#settings-note")).not.toBeEmpty();
});

test("the item-cap control offers exactly the range Rust will accept", async ({ page }) => {
  // The fifth and sixth declarations of the same rule: `settings.rs` clamps to
  // `MIN_ITEMS..=MAX_ITEMS`, and `index.html` writes `min`/`max` on the number
  // input. Two hand-maintained copies in two languages with nothing checking
  // they agreed — raise the clamp and the control still refuses the new
  // values; lower it and it offers values that are silently clamped with no
  // explanation.
  //
  // Joined through `tests/fixtures/settings-bounds.json`, which a Rust test
  // asserts the constants against. The pattern is already used for the default
  // settings and the secret kinds; it just had not been extended here.
  await bootShelf(page);
  await page.locator("#shelf-settings").click();

  const input = page.locator("#setting-max");
  await expect(input).toHaveAttribute("min", String(BOUNDS.maxItems.min));
  await expect(input).toHaveAttribute("max", String(BOUNDS.maxItems.max));
});

test("the arrows walk the order on screen, not the order captures arrived", async ({ page }) => {
  // Browse mode renders day groups, newest day first; the arrows walked the
  // raw store order instead, and the two agree only when captures happen to be
  // added in the same order they were taken.
  //
  // They routinely are not — `groupByDay`'s own docstring says a pin restored
  // at startup can be a week older than the capture after it, and that restore
  // races the backfill at launch. So this lands a capture from *today* and then
  // one from *yesterday*, which is the shape a restored pin produces: the store
  // holds [yesterday, today] and the screen shows today's group first.
  await bootShelf(page);
  await land(page, FIXTURE.wide, { ts: Date.UTC(2026, 6, 28, 12) });
  await land(page, FIXTURE.tall, { ts: Date.UTC(2026, 6, 27, 12) });
  await openBrowse(page);
  await expect(page.locator(".group")).toHaveCount(2);

  // The first card on screen is today's.
  const first = page.locator(".tile").first();
  await expect(first).toHaveAttribute("title", /wide\.png/);

  await page.keyboard.press("ArrowDown");

  // ...and the first press must pick it, not the one the store happens to
  // hold first.
  await expect(first).toHaveClass(/tile--picked/);
  await expect(page.locator(".tile--picked")).toHaveCount(1);

  // Walking on stays in screen order.
  await page.keyboard.press("ArrowDown");
  await expect(page.locator(".tile").nth(1)).toHaveClass(/tile--picked/);
});
