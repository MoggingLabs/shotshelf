/**
 * The seam between the shelf and the editor's window.
 *
 * Everything the *shelf* owns about marking up: when the control is offered,
 * what the key does, what reaches Rust, and what happens to the quick look on
 * the way. The editor itself is `editor.spec.ts`, which boots `/editor.html`
 * and never touches a shelf.
 *
 * This file is smaller than the seam it replaced by design. The editor used to
 * be an overlay inside the shelf's own window, so fourteen tests here asserted
 * that one surface did not break the other — the Escape ladder, the title
 * strip clickable through the overlay, a capture landing mid-annotation, the
 * window handed back after a refused open. None of those couplings exist now,
 * and a test that still asserted them would be describing an app that is not
 * the one shipping.
 */

import {
  bootShelf,
  EDITED_EVENT,
  expect,
  FIXTURE,
  HIDDEN_EVENT,
  land,
  openBrowse,
  test,
} from "../harness/app.ts";

test("the edit control appears for exactly one picked capture", async ({ page }) => {
  await bootShelf(page);
  await land(page, FIXTURE.wide, { ts: 1 });
  await land(page, FIXTURE.tall, { ts: 2 });
  await openBrowse(page);

  await expect(page.locator("#shelf-edit")).toBeHidden();
  await page.keyboard.press("ArrowDown");
  await expect(page.locator("#shelf-edit")).toBeVisible();

  // There is no such thing as marking up two captures at once.
  //
  // Picked by ctrl-clicking rather than with Shift+Arrow: the arrows ignore
  // the shift key and every move ends in a selection of exactly one, so the
  // gesture this used to use could not reach two captures at all.
  const cards = page.locator(".tile");
  await cards.nth(0).click();
  await cards.nth(1).click({ modifiers: ["ControlOrMeta"] });
  await expect(page.locator("#shelf-edit")).toBeHidden();
  // Two is the number that offers a comparison instead.
  await expect(page.locator("#shelf-compare")).toBeVisible();
});

test("the edit control and the key both ask Rust for the picked capture", async ({ page }) => {
  await bootShelf(page);
  await land(page, FIXTURE.wide);
  await openBrowse(page);
  await page.keyboard.press("ArrowDown");

  await page.locator("#shelf-edit").click();
  await expect
    .poll(() => page.evaluate(() => window.__shotshelf__.callsTo("open_editor").length))
    .toBe(1);
  expect(
    await page.evaluate(() => window.__shotshelf__.callsTo("open_editor").at(-1)?.args),
  ).toEqual({ path: FIXTURE.wide });

  // And `e`, folded for case: with CapsLock on `event.key` is "E", which fell
  // through every branch of the switch once and left the editor unreachable.
  // Shift is how Playwright produces a capital; the app cannot tell the two
  // apart, which is the point of folding rather than reading modifiers.
  await page.keyboard.press("Shift+E");
  await expect
    .poll(() => page.evaluate(() => window.__shotshelf__.callsTo("open_editor").length))
    .toBe(2);
});

test("a capture that will not open reports rather than doing nothing", async ({ page }) => {
  // Rust checks the path before any window appears, so a capture whose file
  // has gone is refused here rather than opening an empty editor to say so.
  // The Edit control is still offered for it — the shelf does not stat a file
  // to decide whether to draw a button — so this path is ordinary, not exotic.
  await bootShelf(page);
  await page.evaluate(() =>
    window.__shotshelf__.reject("open_editor", "that capture is not there any more"),
  );
  await land(page, FIXTURE.missing);
  await openBrowse(page);
  await page.keyboard.press("ArrowDown");

  await page.locator("#shelf-edit").click();

  // Asserted on the text, not on the strip being visible: the boot message
  // makes "the strip is visible" true before this test does anything.
  await expect(page.locator("#shelf-alert")).toHaveText(/not there any more/);
  await expect(page.locator("#shelf-alert")).toBeVisible();
});

test("a recording says so instead of opening anything", async ({ page }) => {
  await bootShelf(page);
  await land(page, "/captures/clip.mp4", { kind: "video" });
  await openBrowse(page);
  await page.keyboard.press("ArrowDown");

  // The control hides itself for a recording, so this is the keyboard path —
  // `e` reaches whatever happens to be picked.
  await page.keyboard.press("e");

  await expect(page.locator("#shelf-alert")).toHaveText(/cannot be marked up/);
  expect(await page.evaluate(() => window.__shotshelf__.callsTo("open_editor").length)).toBe(0);
});

test("a saved edit reaches the shelf as a capture of its own", async ({ page }) => {
  // The save happens in the other window, so the shelf learns of it the only
  // way it can: Rust emits `capture://edited` from `edit.rs` the moment the
  // file is written. This is the shelf's half of that join — the editor's half
  // is `editor.spec.ts` asserting what reaches `save_edit`. Playwright cannot
  // run one Tauri event bus across two pages, and pretending otherwise would
  // be a join the harness cannot honestly make; the name is pinned on both
  // sides by `tests/fixtures/window-events.json` instead.
  await bootShelf(page);
  await land(page, FIXTURE.wide);
  await openBrowse(page);
  await expect(page.locator(".tile")).toHaveCount(1);

  await page.evaluate(
    ([event, path]) => window.__shotshelf__.emit(event, path),
    [EDITED_EVENT, "/edits/wide (edited).png"] as const,
  );

  await expect(page.locator(".tile")).toHaveCount(2);
});

test("opening the editor closes the quick look", async ({ page }) => {
  // The quick look grows *this* window; the editor is a different one. Leaving
  // the preview up would leave the shelf at preview size behind a window the
  // user is now working in — and `closePreview` is what hands it back.
  await bootShelf(page);
  await page.evaluate(() => window.__shotshelf__.respond("preview_shelf", null));
  await land(page, FIXTURE.wide);
  await openBrowse(page);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press(" ");
  await expect(page.locator(".preview")).toHaveCount(1);

  await page.keyboard.press("e");

  await expect(page.locator(".preview")).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => window.__shotshelf__.callsTo("open_editor").length))
    .toBe(1);
});

test("holding space does not stack previews", async ({ page }) => {
  await bootShelf(page);
  await page.evaluate(() => window.__shotshelf__.respond("preview_shelf", [220, 124]));
  await land(page, FIXTURE.wide);
  await openBrowse(page);
  await page.keyboard.press("ArrowDown");

  for (let press = 0; press < 5; press += 1) await page.keyboard.press(" ");

  // An odd number of presses leaves it open, so this is exactly one. It used
  // to allow "one or fewer", which passes at zero — i.e. it would have passed
  // with the quick look deleted outright, and it is the regression test for
  // the guard that stops presses stacking.
  await expect(page.locator(".preview")).toHaveCount(1);
});

test("hiding the shelf takes the quick look with it", async ({ page }) => {
  await bootShelf(page);
  await page.evaluate(() => window.__shotshelf__.respond("preview_shelf", null));
  await land(page, FIXTURE.wide);
  await openBrowse(page);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press(" ");
  await expect(page.locator(".preview")).toHaveCount(1);

  await page.evaluate((event) => window.__shotshelf__.emit(event, null), HIDDEN_EVENT);
  await expect(page.locator(".preview")).toHaveCount(0);
});

test("the column's timer does not dismiss a quick look that is still opening", async ({ page }) => {
  // Re-homed from the editor's suite, which held the only coverage of
  // `Overlay.isOpen`'s "opening" veto — the term that counts a surface as up
  // while it is still awaiting its picture. The editor was one of that class's
  // two consumers and has left; the quick look is the other, and deleting the
  // test with the consumer would have deleted the coverage of a guard that is
  // still live.
  await page.clock.install();
  await bootShelf(page);
  await page.evaluate(() => window.__shotshelf__.hang("preview_shelf"));
  await land(page, FIXTURE.wide);
  await expect(page.locator(".shelf")).toHaveAttribute("data-mode", "column");

  await page.locator(".tile").first().click();
  await page.keyboard.press(" ");

  // Well past the column's own expiry, with the open still in flight.
  await page.clock.runFor(70_000);
  expect(await page.evaluate(() => window.__shotshelf__.callsTo("hide_shelf").length)).toBe(0);
});
