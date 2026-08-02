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

import {
  bootShelf,
  DEFAULT_SETTINGS,
  expect,
  FIXTURE,
  HIDDEN_EVENT,
  land,
  openBrowse,
  SETTINGS_CHANGED_EVENT,
  test,
} from "../harness/app.ts";

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
  // Said, not silent: `e` and `t` both answer for a recording, and Space was
  // the one silent no-op of the three — a spec asserted the silence as
  // correct, which is how a gap survives review.
  await expect(page.locator("#shelf-alert")).toHaveText("A recording has no preview.");
});

test("enter copies the picked capture, and says so", async ({ page }) => {
  await threeOpen(page);
  await page.keyboard.press("ArrowDown");
  await page.evaluate(() => window.__shotshelf__.clearCalls());

  await page.keyboard.press("Enter");

  await expect
    .poll(() => page.evaluate(() => window.__shotshelf__.callsTo("copy_capture").length))
    .toBe(1);
  // The same receipt reasoning `t` wrote down, applied to the key beside it:
  // the keyboard has no button to flash, so a silent success was
  // indistinguishable from a dead key.
  await expect(page.locator("#shelf-alert")).toHaveText("Copied to the clipboard.");
});

test("the keys that need a pick say so when nothing is picked", async ({ page }) => {
  await threeOpen(page);
  // No arrow, no click: the state every open starts in.
  await page.keyboard.press("t");

  await expect(page.locator("#shelf-alert")).toHaveText(/Pick a capture first/);
  expect(await page.evaluate(() => window.__shotshelf__.callsTo("copy_capture_text").length)).toBe(
    0,
  );
});

test("t copies the recognised text of the picked capture, and says so", async ({ page }) => {
  await threeOpen(page);
  await page.keyboard.press("ArrowDown");
  await page.evaluate(() => window.__shotshelf__.clearCalls());

  await page.keyboard.press("t");

  await expect
    .poll(() => page.evaluate(() => window.__shotshelf__.callsTo("copy_capture_text").length))
    .toBe(1);
  // The keyboard has no button to flash, so the strip is the receipt.
  await expect(page.locator("#shelf-alert")).toBeVisible();
  await expect(page.locator("#shelf-alert")).toContainText("copied");
});

test("a capture with no text in it is answered, not apologised for", async ({ page }) => {
  await threeOpen(page);
  await page.evaluate(() => window.__shotshelf__.respond("copy_capture_text", false));
  await page.keyboard.press("ArrowDown");

  await page.keyboard.press("t");

  await expect(page.locator("#shelf-alert")).toBeVisible();
  await expect(page.locator("#shelf-alert")).toContainText("No text");
});

test("p pins the picked capture from the keyboard", async ({ page }) => {
  await threeOpen(page);
  await page.keyboard.press("ArrowDown");

  await page.keyboard.press("p");
  await expect(page.locator(".tile--pinned")).toHaveCount(1);

  // A toggle, both ways — half a toggle is a one-way door.
  await page.keyboard.press("p");
  await expect(page.locator(".tile--pinned")).toHaveCount(0);
});

test("o shows the picked capture in its folder from the keyboard", async ({ page }) => {
  await threeOpen(page);
  await page.keyboard.press("ArrowDown");
  await page.evaluate(() => window.__shotshelf__.clearCalls());

  await page.keyboard.press("o");

  await expect
    .poll(() => page.evaluate(() => window.__shotshelf__.callsTo("reveal_capture").length))
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

test("a save in the settings window reaches the shelf through the changed event", async ({
  page,
}) => {
  // The form lives in its own window now, so the shelf's half of a save is
  // the `settings://changed` broadcast: adopt what Rust stored and apply it
  // immediately, not at next launch. The panel-era version of this test drove
  // the form directly; the form's own writes are gated in
  // `settings-window.spec.ts`, and this is the seam between the two.
  await bootShelf(page, { settings: { maxItems: 50 } });
  await land(page, FIXTURE.wide, { ts: 1 });
  await land(page, FIXTURE.tall, { ts: 2 });
  await land(page, FIXTURE.square, { ts: 3 });
  await openBrowse(page);
  await expect(page.locator(".tile")).toHaveCount(3);

  const stored = { ...DEFAULT_SETTINGS, maxItems: 1 };
  await page.evaluate(
    ([event, settings]) => window.__shotshelf__.emit(event, settings),
    [SETTINGS_CHANGED_EVENT, stored] as const,
  );

  // One tile rather than three: the shelf honoured the 1 the event carried.
  await expect(page.locator(".tile")).toHaveCount(1);
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

  // The first card on screen is today's. Identified by its label's tooltip —
  // the card itself no longer carries one; it held the full absolute path,
  // which is more than the app exposes anywhere else.
  const first = page.locator(".tile").first();
  await expect(first.locator(".tile__label")).toHaveAttribute("title", /wide\.png/);

  await page.keyboard.press("ArrowDown");

  // ...and the first press must pick it, not the one the store happens to
  // hold first.
  await expect(first).toHaveClass(/tile--picked/);
  await expect(page.locator(".tile--picked")).toHaveCount(1);

  // Walking on stays in screen order.
  await page.keyboard.press("ArrowDown");
  await expect(page.locator(".tile").nth(1)).toHaveClass(/tile--picked/);
});

test("backspace takes it off the shelf, the same as delete", async ({ page }) => {
  // `docs/USAGE.md` promises "Delete or Backspace", and a census of every key
  // any spec presses turned up no Backspace anywhere: dropping the
  // `case "Backspace"` label left the whole gate green while half the
  // documented gesture stopped working. On a Mac keyboard with no Delete key
  // it is the *only* half.
  await threeOpen(page);
  await page.keyboard.press("ArrowDown");
  await expect(page.locator(".tile--picked")).toHaveCount(1);

  await page.keyboard.press("Backspace");

  await expect(page.locator(".tile")).toHaveCount(2);
});

test("the pick does not survive the shelf hiding", async ({ page }) => {
  // `Selection.clear` had exactly one caller — `compare` — so a pick made in
  // an earlier appearance held its ring across every hide, walked down the
  // list as newer captures landed on top of it, and kept Edit lit for a card
  // nobody remembered choosing. The live session that found this showed the
  // ring on the second tile with no click in the whole appearance.
  await threeOpen(page);
  await page.keyboard.press("ArrowDown");
  await expect(page.locator(".tile--picked")).toHaveCount(1);

  await page.evaluate(
    ([event]) => window.__shotshelf__.emit(event, null),
    [HIDDEN_EVENT] as const,
  );
  await openBrowse(page);

  await expect(page.locator(".tile--picked")).toHaveCount(0);
  await expect(page.locator("#shelf-edit")).toBeHidden();
});

test("enter on a focused control activates the control, not the shelf gesture", async ({
  page,
}) => {
  // The document-level keydown `preventDefault`ed Enter and Space wholesale,
  // so Tab to Hide and Enter *copied the picked capture* instead of hiding —
  // every icon button in the app was keyboard-unusable.
  await threeOpen(page);
  await page.keyboard.press("ArrowDown");
  await page.evaluate(() => window.__shotshelf__.clearCalls());

  await page.locator("#shelf-hide").focus();
  await page.keyboard.press("Enter");

  await expect
    .poll(() => page.evaluate(() => window.__shotshelf__.callsTo("hide_shelf").length))
    .toBe(1);
  expect(await page.evaluate(() => window.__shotshelf__.callsTo("copy_capture").length)).toBe(0);
});

test("delete announces the removal and ctrl+z brings the batch back", async ({ page }) => {
  await threeOpen(page);
  // Pick all three: arrow to the top, then shift-extend to the bottom.
  await page.keyboard.press("ArrowDown");
  await page.locator(".tile").last().click({ modifiers: ["Shift"] });
  await expect(page.locator(".tile--picked")).toHaveCount(3);

  await page.keyboard.press("Delete");
  await expect(page.locator(".tile")).toHaveCount(0);
  // The receipt names the two things that matter: the files are safe, and
  // the act is reversible.
  await expect(page.locator("#shelf-alert")).toHaveText(/3 captures taken off .* Ctrl\+Z/);

  await page.keyboard.press("Control+z");
  await expect(page.locator(".tile")).toHaveCount(3);
  await expect(page.locator("#shelf-alert")).toHaveText(/3 captures back on the shelf/);

  // The stack is one level deep per batch, not bottomless.
  await page.keyboard.press("Control+z");
  await expect(page.locator("#shelf-alert")).toHaveText("Nothing to bring back.");
});

test("a plain release on a multi-pick collapses to the pressed card", async ({ page }) => {
  // Picking happens on press so a drag can carry the set — but the platform
  // convention completes on release: a click without a drag collapses to the
  // clicked card. There used to be no gesture at all from "three picked" to
  // "just this one".
  await threeOpen(page);
  await page.keyboard.press("ArrowDown");
  await page.locator(".tile").last().click({ modifiers: ["Shift"] });
  await expect(page.locator(".tile--picked")).toHaveCount(3);

  await page.locator(".tile").nth(1).click();
  await expect(page.locator(".tile--picked")).toHaveCount(1);
  await expect(page.locator(".tile").nth(1)).toHaveClass(/tile--picked/);
});

test("a press on the space between cards clears the pick", async ({ page }) => {
  await threeOpen(page);
  await page.keyboard.press("ArrowDown");
  await expect(page.locator(".tile--picked")).toHaveCount(1);

  // The day heading is outside every card.
  await page.locator(".group__label").first().click();
  await expect(page.locator(".tile--picked")).toHaveCount(0);
});

test("the title strip counts the pick while one exists", async ({ page }) => {
  // At three or more picked, Edit and Compare both vanish and nothing said a
  // selection was live — right before Delete acted on all of it.
  await threeOpen(page);
  await expect(page.locator("#shelf-count")).toHaveText("3 captures");

  await page.keyboard.press("ArrowDown");
  await expect(page.locator("#shelf-count")).toHaveText("1 of 3 picked");

  await page.locator(".tile").last().click({ modifiers: ["Shift"] });
  await expect(page.locator("#shelf-count")).toHaveText("3 of 3 picked");

  await page.locator(".group__label").first().click();
  await expect(page.locator("#shelf-count")).toHaveText("3 captures");
});

test("the cursor card is marked when more than one is picked", async ({ page }) => {
  await threeOpen(page);
  await page.keyboard.press("ArrowDown");
  // One picked: the pick is the cursor, and a second treatment would be noise.
  await expect(page.locator(".tile--cursor")).toHaveCount(0);

  await page.locator(".tile").last().click({ modifiers: ["Shift"] });
  // The cursor is the card the user last touched — the shift-clicked one.
  await expect(page.locator(".tile--cursor")).toHaveCount(1);
  await expect(page.locator(".tile").last()).toHaveClass(/tile--cursor/);
});

