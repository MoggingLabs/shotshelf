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

import { CARD_GAP, CARD_HEIGHT, COLUMN_PADDING } from "../../src/shelf/geometry.ts";
import {
  bootShelf,
  expect,
  FIXTURE,
  HIDDEN_EVENT,
  land,
  launchAppearance,
  openBrowse,
  test,
} from "../harness/app.ts";

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

  await page.evaluate((event) => window.__shotshelf__.emit(event, null), HIDDEN_EVENT);
  await page.waitForTimeout(250);

  expect(await page.evaluate(() => window.__shotshelf__.callsTo("hide_shelf").length)).toBe(0);
});

test("closing from the tray leaves the shelf ready to pop again", async ({ page }) => {
  await bootShelf(page);

  // Open it deliberately, then close it the way the tray icon does — a route
  // that never passes through the front-end.
  await openBrowse(page);
  await page.evaluate((event) => window.__shotshelf__.emit(event, null), HIDDEN_EVENT);
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

test("the launch appearance is not cancelled by its own open", async ({ page }) => {
  // `window::open` emits `shelf://opened` *and* takes focus, and it is the same
  // function for the tray, the hotkey and the launch. The front end read either
  // of those as "the user asked for this", so the four-second launch appearance
  // stood its own timer down and remained on screen — an always-on-top window
  // nobody had summoned, until dismissed by hand.
  // The clock has to be installed *before* boot, or the launch timer runs on
  // wall time and has already fired by the time this test acts.
  await page.clock.install();
  await bootShelf(page);

  // Exactly what Rust does at launch: the open event with `deliberate: false`,
  // followed by the focus it takes on its way up.
  await launchAppearance(page);
  await page.evaluate(() => window.__shotshelf__.emit("tauri://focus", null));

  await page.clock.runFor(5_000);
  expect(await page.evaluate(() => window.__shotshelf__.callsTo("hide_shelf").length)).toBe(1);
});

test("a deliberate open during those four seconds keeps the shelf up", async ({ page }) => {
  // The other half: a tray click two seconds after launch must not be dismissed
  // by a timer armed before it.
  await page.clock.install();
  await bootShelf(page);
  await launchAppearance(page);
  await page.clock.runFor(2_000);
  await page.evaluate(() => window.__shotshelf__.clearCalls());

  await openBrowse(page);
  await page.clock.runFor(5_000);

  expect(await page.evaluate(() => window.__shotshelf__.callsTo("hide_shelf").length)).toBe(0);
});

test("a capture arriving during the launch appearance still pops the column", async ({ page }) => {
  // `#opened` means "up because you asked for it", and the launch appearance is
  // the one nobody asked for. Setting it unconditionally on `shelf://opened`
  // meant `catch()` took its early return and filed the capture into the browse
  // list instead — so the very first capture never popped, and the launch timer
  // then dismissed the window with an empty column behind it, so nothing popped
  // afterwards either.
  //
  // Exactly what `lib.rs` does at launch: open with `deliberate: false`.
  await page.clock.install();
  await bootShelf(page);
  await launchAppearance(page);
  await expect(page.locator(".shelf")).toHaveAttribute("data-mode", "browse");

  await land(page, FIXTURE.wide);

  await expect(page.locator(".shelf")).toHaveAttribute("data-mode", "column");
  await expect(page.locator(".tile")).toHaveCount(1);
});

test("a capture arriving in a shelf you opened does not reshape it", async ({ page }) => {
  // The other half of the same rule: a deliberate open must keep the browse
  // shape, or a capture landing while you are browsing yanks the window out
  // from under you.
  await page.clock.install();
  await bootShelf(page);
  await openBrowse(page);
  await expect(page.locator(".shelf")).toHaveAttribute("data-mode", "browse");

  await land(page, FIXTURE.wide);

  await expect(page.locator(".shelf")).toHaveAttribute("data-mode", "browse");
  await expect(page.locator(".tile")).toHaveCount(1);
});

test("a window the user restored does not put itself away", async ({ page }) => {
  // The harness used to emit `shelf://opened` with `null` where Rust emits a
  // boolean, so every browser test modelled a deliberate open as the launch
  // appearance: the front end kept its four-second dismissal armed and a window
  // the user had just opened dismissed itself. Nothing pinned the payload, so
  // the harness's model of this contract was unconstrained and wrong.
  //
  // Driven through the command the editor uses to restore its window, so this
  // fails if the payload regresses on either side.
  await page.clock.install();
  await bootShelf(page);
  await page.evaluate(() => window.__shotshelf__.clearCalls());

  // Through the stubbed Tauri entry point the app itself uses, so the mock's
  // emit runs — emitting the event directly would bypass the very code under
  // test.
  await page.evaluate(
    () => void window.__TAURI_INTERNALS__.invoke("show_shelf", { focus: true }),
  );
  await page.clock.runFor(5_000);

  expect(await page.evaluate(() => window.__shotshelf__.callsTo("hide_shelf").length)).toBe(0);
});

test("removing the last card of a peeked column puts the window away", async ({ page }) => {
  // `onColumnChange` had one call site, inside the expiry tick, behind
  // `if (!expire()) return;` — and `expire` on an empty queue returns false. So
  // the × emptied the column and told nobody, and `dismiss` was never reached.
  //
  // In the peeked shape that is unrecoverable: the window is never focused so
  // Escape cannot reach it, and the title strip with the hide button is
  // `display: none` there. What is left is a frameless always-on-top blank
  // panel the front end cannot take down.
  await page.clock.install();
  await bootShelf(page);
  await land(page, FIXTURE.wide);
  await expect(page.locator(".shelf")).toHaveAttribute("data-mode", "column");
  await page.evaluate(() => window.__shotshelf__.clearCalls());

  await page.locator(".tile").hover();
  await page.locator(".tile__action--remove").click();

  await expect(page.locator(".tile")).toHaveCount(0);
  // Immediately, not polled. The launch dismissal fires four seconds in, and a
  // poll waits long enough to catch it — so a polled assertion passed with this
  // fix reverted and was measuring the wrong timer entirely.
  expect(await page.evaluate(() => window.__shotshelf__.callsTo("hide_shelf").length)).toBe(1);
});

test("a capture leaving during the launch appearance does not hide the window", async ({ page }) => {
  // The launch appearance is the browse shape with an empty column and
  // `#opened === false` — nobody asked for it. `onColumnChange` read
  // `columnIsEmpty` and dismissed, so anything that took a capture off the
  // shelf in those four seconds put the window away: a × on a backfilled card,
  // or choosing a retention window, whose sweep drops cards while the user is
  // looking at the settings panel.
  //
  // No browser test emitted the launch payload before this one — the harness
  // and `openBrowse` both send `true` — so the whole suite ran in a state a
  // real launch never produces.
  await page.clock.install();
  await bootShelf(page);
  await land(page, FIXTURE.wide);
  await launchAppearance(page);
  await expect(page.locator(".shelf")).toHaveAttribute("data-mode", "browse");
  await page.evaluate(() => window.__shotshelf__.clearCalls());

  await page.locator(".tile").hover();
  await page.locator(".tile__action--remove").click();
  await expect(page.locator(".tile")).toHaveCount(0);

  expect(await page.evaluate(() => window.__shotshelf__.callsTo("hide_shelf").length)).toBe(0);
});

test("removing one card of several shrinks the peeked column", async ({ page }) => {
  // `#dropFromColumn` only reported when the column *emptied*, so the branch
  // that asks Rust for a new height was unreachable from the ×, the item cap
  // and the retention sweep. Removing one of three left an always-on-top panel
  // a card too tall — opaque, and swallowing clicks.
  await page.clock.install();
  await bootShelf(page);
  await land(page, FIXTURE.wide, { ts: 1 });
  await land(page, FIXTURE.tall, { ts: 2 });
  await land(page, FIXTURE.square, { ts: 3 });
  await expect(page.locator(".tile")).toHaveCount(3);
  await page.evaluate(() => window.__shotshelf__.clearCalls());

  await page.locator(".tile").first().hover();
  await page.locator(".tile").first().locator(".tile__action--remove").click();
  await expect(page.locator(".tile")).toHaveCount(2);

  // Two cards' worth, plus whatever the alert strip is taking.
  const asked = await page.evaluate(() => {
    const calls = window.__shotshelf__.callsTo("show_shelf");
    return calls.at(-1)?.args["height"] as number | undefined;
  });
  const strip = await page
    .locator("#shelf-alert")
    .evaluate((el: HTMLElement) => (el.hasAttribute("hidden") ? 0 : el.offsetHeight));
  expect(asked).toBe(2 * CARD_HEIGHT + CARD_GAP + COLUMN_PADDING + strip);
});

test("the front end adopts hidden from the event Rust really emits", async ({ page }) => {
  // The `hidden` half of the events fixture was a half-join.
  //
  // Five specs emitted `"shelf://hidden"` as a literal, and every assertion
  // about hiding counted `callsTo("hide_shelf")` — so nothing observed the
  // event itself. Renaming `window::HIDDEN_EVENT` *and* the fixture together,
  // leaving `main.ts` listening for the old name, passed 142 Rust tests, 126
  // browser tests and all three script gates. `lib.rs` spells out the cost: the
  // front end goes on believing the shelf is open, so every later capture is
  // filed away silently instead of popping the column.
  //
  // This drives the round trip instead — a real `hide_shelf`, which the mock
  // answers by emitting `EVENTS.hidden` from the fixture, exactly as Rust does
  // — and then asserts on the consequence a user would notice: the next capture
  // pops the column again.
  await bootShelf(page);
  await openBrowse(page);
  await expect(page.locator(".shelf")).toHaveAttribute("data-mode", "browse");

  await page.keyboard.press("Escape");
  await expect
    .poll(() => page.evaluate(() => window.__shotshelf__.callsTo("hide_shelf").length))
    .toBe(1);

  // Adopted: the shelf is no longer browsing, so a capture pops the column.
  await land(page, FIXTURE.wide);
  await expect(page.locator(".shelf")).toHaveAttribute("data-mode", "column");
});

test("a capture landing inside the launch appearance keeps its full minute", async ({ page }) => {
  // `Popover.catch` never stood the launch timer down, and a peeked column is
  // created without focus on purpose — so `onFocusChanged` could not stand it
  // down either. A capture landing at t = 3.9 s popped the column and the
  // four-second launch dismissal put it away a tenth of a second later, against
  // the minute README.md and docs/USAGE.md both promise.
  await page.clock.install();
  await bootShelf(page);
  await launchAppearance(page);

  // Just inside the launch window.
  await page.clock.runFor(3_900);
  await land(page, FIXTURE.wide);
  await expect(page.locator(".tile")).toHaveCount(1);
  await page.evaluate(() => window.__shotshelf__.clearCalls());

  // Past what would have been the launch dismissal.
  await page.clock.runFor(2_000);

  await expect(page.locator(".shelf")).toHaveAttribute("data-mode", "column");
  expect(await page.evaluate(() => window.__shotshelf__.callsTo("hide_shelf").length)).toBe(0);

  // And it still ages out on its own minute rather than living for ever.
  await page.clock.runFor(60_000);
  await expect
    .poll(() => page.evaluate(() => window.__shotshelf__.callsTo("hide_shelf").length))
    .toBeGreaterThan(0);
});
