/**
 * When the popover is up, and what puts it away.
 *
 * This file exists because of two bugs that were expensive to find and are
 * invisible to every other kind of test.
 *
 * The first was a feedback loop: Rust's `open()` emits `shelf://opened`, the
 * front-end answered by asking Rust to show the window, which re-entered
 * `open()` and emitted again. The window re-opened itself forever, so Esc, the
 * hide button and click-away all *looked* broken while each was working. The
 * guard is that an adopt* handler must not call back into Rust — asserted here
 * by counting calls, because there is nothing to see on screen.
 *
 * The second was the mirror of it: closing from the tray hid the window in
 * Rust without telling the front-end, which went on believing it was open and
 * silently filed every later capture away instead of popping the column. The
 * shelf simply stopped popping up, for the rest of the session.
 */

import { bootShelf, expect, FIXTURE, land, openBrowse, test } from "../harness/app.ts";

test("adopting an open does not ask Rust to open again", async ({ page }) => {
  await bootShelf(page);
  await page.evaluate(() => window.__shotshelf__.clearCalls());

  await openBrowse(page);
  await page.waitForTimeout(250);

  // The loop this guards against was unbounded: any number above zero here
  // means the front-end is answering an event by re-triggering it.
  expect(await page.evaluate(() => window.__shotshelf__.callsTo("show_shelf").length)).toBe(0);
  await expect(page.locator(".shelf")).toHaveAttribute("data-mode", "browse");
});

test("adopting a hide does not ask Rust to hide again", async ({ page }) => {
  await bootShelf(page);
  await page.evaluate(() => window.__shotshelf__.clearCalls());

  await page.evaluate(() => window.__shotshelf__.emit("shelf://hidden", null));
  await page.waitForTimeout(250);

  expect(await page.evaluate(() => window.__shotshelf__.callsTo("hide_shelf").length)).toBe(0);
});

test("closing from the tray leaves the shelf ready to pop again", async ({ page }) => {
  await bootShelf(page);

  // Open it deliberately, then close it the way the tray icon does — a route
  // that never passes through the front-end.
  await openBrowse(page);
  await page.evaluate(() => window.__shotshelf__.emit("shelf://hidden", null));
  await page.evaluate(() => window.__shotshelf__.clearCalls());

  await land(page, FIXTURE.wide);

  // Before the fix this capture was filed away in silence and nothing popped.
  await expect(page.locator(".shelf")).toHaveAttribute("data-mode", "column");
  await expect(page.locator(".tile")).toHaveCount(1);
  expect(await page.evaluate(() => window.__shotshelf__.callsTo("show_shelf").length)).toBe(1);
});

test("a capture arriving while you are browsing does not reshape the window", async ({ page }) => {
  await bootShelf(page);
  await openBrowse(page);
  await page.evaluate(() => window.__shotshelf__.clearCalls());

  await land(page, FIXTURE.wide);

  await expect(page.locator(".tile")).toHaveCount(1);
  await expect(page.locator(".shelf")).toHaveAttribute("data-mode", "browse");
  // Reshaping the window out from under someone reading it is the complaint
  // people have about shelves that do this.
  expect(await page.evaluate(() => window.__shotshelf__.callsTo("show_shelf").length)).toBe(0);
});

test("Escape puts the popover away", async ({ page }) => {
  await bootShelf(page);
  await openBrowse(page);
  await page.evaluate(() => window.__shotshelf__.clearCalls());

  await page.keyboard.press("Escape");

  await expect
    .poll(() => page.evaluate(() => window.__shotshelf__.callsTo("hide_shelf").length))
    .toBe(1);
});

test("the hide button puts the popover away", async ({ page }) => {
  await bootShelf(page);
  await openBrowse(page);
  await page.evaluate(() => window.__shotshelf__.clearCalls());

  await page.locator("#shelf-hide").click();

  await expect
    .poll(() => page.evaluate(() => window.__shotshelf__.callsTo("hide_shelf").length))
    .toBe(1);
});

test("an opened popover is sticky: losing focus does not dismiss it", async ({ page }) => {
  await bootShelf(page);
  await openBrowse(page);
  await page.evaluate(() => window.__shotshelf__.clearCalls());

  // Tauri reports focus loss as a window event, not a DOM blur.
  await page.evaluate(() => window.__shotshelf__.emit("tauri://blur", null));
  await page.waitForTimeout(250);

  expect(await page.evaluate(() => window.__shotshelf__.callsTo("hide_shelf").length)).toBe(0);
  await expect(page.locator(".shelf")).toHaveAttribute("data-mode", "browse");
});

test("the launch appearance puts itself away", async ({ page }) => {
  await page.clock.install();
  await bootShelf(page);

  await page.clock.runFor(5_000);

  await expect
    .poll(() => page.evaluate(() => window.__shotshelf__.callsTo("hide_shelf").length))
    .toBeGreaterThan(0);
});

test("a shelf you opened on purpose survives the launch window", async ({ page }) => {
  // The launch timer was cleared by `adoptHidden` and by focus arriving, but
  // not by `adoptBrowse` — the one route that knows the user asked for this.
  //
  // Focus normally covers it, because `window::open` focuses as well as
  // emitting. It does not when focus never *changes*: a window manager that
  // refuses focus-stealing, or a window that already had focus. So this drives
  // the open without any focus event at all, which is the state the fix is for.
  //
  // What made it worse than a stray hide: `dismiss` runs `setMode("column")`,
  // and `setMode("browse")` has already emptied the column queue — so every
  // tile vanished a moment before the window did.
  await page.clock.install();
  await bootShelf(page);
  await land(page, FIXTURE.wide, { ts: 1 });
  await land(page, FIXTURE.tall, { ts: 2 });

  await openBrowse(page);
  await expect(page.locator(".tile")).toHaveCount(2);
  await page.evaluate(() => window.__shotshelf__.clearCalls());

  await page.clock.runFor(10_000);

  expect(await page.evaluate(() => window.__shotshelf__.callsTo("hide_shelf").length)).toBe(0);
  await expect(page.locator(".shelf")).toHaveAttribute("data-mode", "browse");
  await expect(page.locator(".tile")).toHaveCount(2);
});

test("the launch appearance stays put while a drag is in flight", async ({ page }) => {
  await page.clock.install();
  await bootShelf(page);
  await page.evaluate(() => {
    window.__shotshelf__.respond("prepare_drag", { path: "/x", icon: "" });
    // The OS owns the drag until the user drops it, so the call stays in
    // flight. Letting it resolve would end the drag before the assertion.
    window.__shotshelf__.hang("plugin:drag|start_drag");
  });
  await land(page, FIXTURE.wide);

  // Press and travel far enough to arm the drag.
  const tile = page.locator(".tile");
  await tile.hover();
  await page.mouse.down();
  await page.mouse.move(120, 220);

  await page.evaluate(() => window.__shotshelf__.clearCalls());
  await page.clock.runFor(10_000);

  // Yanking the shelf away mid-drag loses the drag.
  expect(await page.evaluate(() => window.__shotshelf__.callsTo("hide_shelf").length)).toBe(0);
  await page.mouse.up();
});
