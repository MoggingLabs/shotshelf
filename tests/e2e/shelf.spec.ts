/**
 * What the shelf keeps, shows and lets go of.
 *
 * These are the behaviours a user would notice breaking, exercised through the
 * real app in a real browser rather than through its internals. Where a rule
 * is already covered by a unit test on the store, the test here is that the
 * rule is actually *wired up* — the two failures look identical to a user and
 * only one of them is caught by testing the rule alone.
 */

import {
  bootShelf,
  DEFAULT_SETTINGS,
  expect,
  FIXTURE,
  land,
  openBrowse,
  test,
  CAPTURE_EVENT,
  UPDATE_EVENT,
} from "../harness/app.ts";
import engineStarting from "../fixtures/engine-starting.json" with { type: "json" };

/**
 * The sentinel Rust sends while the catch engine comes up — read, not restated.
 *
 * It lived in three hand-maintained copies: `catch::STARTING`, `main.ts`'s
 * `includes("still starting")`, and this spec's own literal. Rewording the Rust
 * constant left every gate green while, in the real app, both catch commands
 * would fail on their first reply and every launch would report "Shotshelf
 * could not reach its catch engine" on a healthy machine.
 */
const ENGINE_STARTING = engineStarting.starting;

test("an empty shelf says so rather than showing a blank panel", async ({ page }) => {
  await bootShelf(page);
  await openBrowse(page);

  await expect(page.locator(".empty__title")).toHaveText("Nothing on the shelf");
  await expect(page.locator("#shelf-count")).toHaveText("Shelf");
  await expect(page.locator("#shelf-items")).toHaveAttribute("data-empty", "true");
});

test("a capture that lands pops the column with one card", async ({ page }) => {
  await bootShelf(page);
  await land(page, FIXTURE.wide);

  await expect(page.locator(".tile")).toHaveCount(1);
  await expect(page.locator("#shelf-items")).toHaveAttribute("data-view", "column");
  await expect(page.locator(".shelf")).toHaveAttribute("data-mode", "column");
});

test("the column is sized to exactly the cards it holds", async ({ page }) => {
  await bootShelf(page);

  await land(page, FIXTURE.wide, { ts: 1 });
  await expect(page.locator(".tile")).toHaveCount(1);
  // 112 for the card + 24 of padding and border. Measured against the shipping app.
  expect(await cardHeight(page)).toBe(136);

  await land(page, FIXTURE.tall, { ts: 2 });
  await expect(page.locator(".tile")).toHaveCount(2);
  expect(await cardHeight(page)).toBe(257);

  await land(page, FIXTURE.square, { ts: 3 });
  await expect(page.locator(".tile")).toHaveCount(3);
  expect(await cardHeight(page)).toBe(378);
});

test("the column never grows past what fits on screen", async ({ page }) => {
  await bootShelf(page);
  for (let index = 0; index < 9; index += 1) await land(page, FIXTURE.wide, { ts: index });

  // Five cards' worth, and it scrolls beyond that rather than growing off the top.
  expect(await cardHeight(page)).toBe(5 * 112 + 4 * 9 + 24);
});

test("a card leaves the column after its minute but stays on the shelf", async ({ page }) => {
  await page.clock.install();
  await bootShelf(page);
  await settleLaunch(page);
  await land(page, FIXTURE.wide);
  await expect(page.locator(".tile")).toHaveCount(1);

  // Pointer is not over the popover, so nothing is holding the card open.
  await page.clock.runFor(61_000);

  // The popover puts itself away...
  await expect
    .poll(() => page.evaluate(() => window.__shotshelf__.callsTo("hide_shelf").length))
    .toBeGreaterThan(0);

  // ...and the capture is still there when you next open the shelf.
  await openBrowse(page);
  await expect(page.locator(".tile")).toHaveCount(1);
});

test("hovering the column stops its cards ageing out under the pointer", async ({ page }) => {
  await page.clock.install();
  await bootShelf(page);
  await settleLaunch(page);
  await land(page, FIXTURE.wide);

  await page.locator(".shelf").hover();
  await page.evaluate(() => window.__shotshelf__.clearCalls());
  await page.clock.runFor(120_000);

  await expect(page.locator(".tile")).toHaveCount(1);
  expect(await page.evaluate(() => window.__shotshelf__.callsTo("hide_shelf").length)).toBe(0);
});

test("captures are grouped by day, newest day first", async ({ page }) => {
  await bootShelf(page);
  await land(page, FIXTURE.wide, { ts: Date.UTC(2026, 4, 9, 12) });
  await land(page, FIXTURE.tall, { ts: Date.UTC(2026, 10, 5, 12) });
  await openBrowse(page);

  // Zero-padded keys, so lexical order is chronological. Unpadded ones once
  // sorted "2026-11-5" before "2026-5-9" and put December above June.
  await expect(page.locator(".group")).toHaveCount(2);
  await expect(page.locator(".group").first()).toHaveAttribute("data-day", "2026-11-05");
  await expect(page.locator(".group").last()).toHaveAttribute("data-day", "2026-05-09");
});

test("the shelf count and the tray count agree", async ({ page }) => {
  await bootShelf(page);
  await land(page, FIXTURE.wide, { ts: 1 });
  await expect(page.locator("#shelf-count")).toHaveText("1 capture");

  await land(page, FIXTURE.tall, { ts: 2 });
  await expect(page.locator("#shelf-count")).toHaveText("2 captures");

  await expect
    .poll(async () => {
      const calls = await page.evaluate(() => window.__shotshelf__.callsTo("set_capture_count"));
      return calls.at(-1)?.args["count"];
    })
    .toBe(2);
});

test("removing a capture takes it off the shelf and never touches the file", async ({ page }) => {
  await bootShelf(page);
  await land(page, FIXTURE.wide);
  await openBrowse(page);
  await page.evaluate(() => window.__shotshelf__.clearCalls());

  await page.locator(".tile").hover();
  await page.locator(".tile__action--remove").click();

  await expect(page.locator(".tile")).toHaveCount(0);
  await expect(page.locator(".empty__title")).toBeVisible();

  // The shelf is a view of your captures, not their owner, so nothing it does
  // on removal may reach the file.
  //
  // Asserted as an allowlist rather than by naming commands that must not
  // appear: the previous version listed two names that have never existed in
  // this codebase, so it could not have failed. This one fails the moment
  // removal invokes anything new, whatever it is called.
  const allowed = new Set(["set_pinned", "set_capture_count", "forget_video", "describe_capture"]);
  const commands = await page.evaluate(() => window.__shotshelf__.calls().map((call) => call.cmd));
  expect([...new Set(commands)].filter((cmd) => !allowed.has(cmd))).toEqual([]);
});

test("pinning is persisted so it survives a restart", async ({ page }) => {
  await bootShelf(page);
  await land(page, FIXTURE.wide);
  await openBrowse(page);

  await page.locator(".tile").hover();
  await page.locator(".tile__action--pin").click();

  await expect(page.locator(".tile")).toHaveClass(/tile--pinned/);
  await expect
    .poll(async () => {
      const calls = await page.evaluate(() => window.__shotshelf__.callsTo("set_pinned"));
      return (calls.at(-1)?.args["pinned"] as unknown[] | undefined)?.length;
    })
    .toBe(1);
});

test("the pin control shows its own state, not whichever button came first", async ({ page }) => {
  // Live pin reflection had no test at all. `reflectPin` found its button with
  // `querySelector(".tile__action")` — the first of three controls that all
  // carry that class — so it was the pin button only because `actions()`
  // appends it first. Reordering them, an ordinary edit, would have left the
  // star dark when you pinned and relabelled the *copy* button "Pinned".
  //
  // Asserted by name and against the other two, which is what a positional
  // bug looks like from outside: the right control changes and the others do
  // not.
  await bootShelf(page);
  await land(page, FIXTURE.wide);
  await openBrowse(page);

  const pin = page.locator(".tile__action--pin");
  const others = page.locator(".tile__action:not(.tile__action--pin)");
  await expect(pin).toHaveCount(1);
  await expect(others).toHaveCount(2);
  await expect(pin).not.toHaveClass(/tile__action--on/);

  await page.locator(".tile").hover();
  await pin.click();

  await expect(pin).toHaveClass(/tile__action--on/);
  await expect(pin).toHaveAttribute("title", /unpin/i);
  // And nothing else was relabelled or lit.
  await expect(others.filter({ has: page.locator(".tile__action--on") })).toHaveCount(0);
  const labels = await others.evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute("title") ?? ""),
  );
  for (const label of labels) {
    expect(label).not.toMatch(/pinned/i);
  }

  // Unpinning goes back, on the same control.
  await pin.click();
  await expect(pin).not.toHaveClass(/tile__action--on/);
  await expect(pin).toHaveAttribute("title", /pin/i);
});

test("copying a capture asks Rust for the clipboard, not the DOM", async ({ page }) => {
  await bootShelf(page);
  await land(page, FIXTURE.wide);
  await openBrowse(page);

  await page.locator(".tile").hover();
  await page.locator(".tile__action--copy").click();

  await expect
    .poll(() => page.evaluate(() => window.__shotshelf__.callsTo("copy_capture").length))
    .toBe(1);
});

test("the item cap drops the oldest unpinned capture", async ({ page }) => {
  await bootShelf(page, { settings: { maxItems: 2 } });

  for (const [index, file] of [FIXTURE.wide, FIXTURE.tall, FIXTURE.square].entries()) {
    await land(page, file, { ts: index + 1 });
  }
  await openBrowse(page);

  await expect(page.locator(".tile")).toHaveCount(2);
  await expect(page.locator("#shelf-count")).toHaveText("2 captures");
});

/**
 * Let the launch appearance put itself away.
 *
 * The shelf shows itself for four seconds at start-up so a running app looks
 * like one, and that dismissal is a real `hide_shelf`. Any test that
 * fast-forwards the clock has to get past it first, or it reads the launch
 * dismissal as the column giving up.
 */
async function settleLaunch(page: import("@playwright/test").Page): Promise<void> {
  await page.clock.runFor(5_000);
  await page.evaluate(() => window.__shotshelf__.clearCalls());
}

/** The height the app last asked the window to be. */
async function lastShowHeight(page: import("@playwright/test").Page): Promise<number | undefined> {
  const calls = await page.evaluate(() => window.__shotshelf__.callsTo("show_shelf"));
  return calls.at(-1)?.args["height"] as number | undefined;
}

/**
 * The card part of the requested height, with the alert strip's share removed.
 *
 * The column is sized for everything in it, and since the strip stopped being
 * hidden by shape that includes the strip — a boot with no watched folders says
 * so, and that message is genuinely on screen. These tests are about the *card*
 * arithmetic, so the measured strip comes back off rather than being baked into
 * three magic numbers that would then drift with the stylesheet.
 *
 * `tests/visual/layout.spec.ts` is what asserts the strip's share is added.
 */
async function cardHeight(page: import("@playwright/test").Page): Promise<number | undefined> {
  const asked = await lastShowHeight(page);
  const strip = await page
    .locator("#shelf-alert")
    .evaluate((el: HTMLElement) => (el.hasAttribute("hidden") ? 0 : el.offsetHeight));
  return asked === undefined ? undefined : asked - strip;
}

test("a card is labelled with what was in front when it was taken", async ({ page }) => {
  await bootShelf(page);
  await page.evaluate((event) =>
    window.__shotshelf__.emit(event, {
      path: "/captures/wide.png",
      kind: "image",
      ts: 1,
      context: { app: "Code", title: "auth.ts", label: "Code — auth.ts" },
    }),
    CAPTURE_EVENT,
  );

  // A capture is named after the clock, which identifies it to a filesystem
  // and to nobody else. What was in front is how a person remembers which
  // screenshot this is.
  await expect(page.locator(".tile__label")).toHaveText("Code — auth.ts");
  // The filename is still what the file is called, so it stays reachable.
  await expect(page.locator(".tile__label")).toHaveAttribute("title", /wide\.png/);
});

test("a card with no context falls back to the filename", async ({ page }) => {
  // Linux says nothing, and macOS says only the application — absence has to
  // be ordinary rather than a blank label.
  await bootShelf(page);
  await land(page, FIXTURE.wide);

  await expect(page.locator(".tile__label")).toHaveText("wide.png");
});

test("a pin is not saved when the stored settings could never be read", async ({ page }) => {
  // Tauri builds the window before Rust's setup hook finishes, so
  // `get_settings` can land before the store is managed. When it failed, the
  // front-end kept its defaults — which have no pins — `restorePinned` never
  // ran, and the first pin after that sent a one-element list to `set_pinned`,
  // which replaces the stored list outright. Every previous pin, gone, with
  // nothing said but "running on defaults".
  await page.addInitScript(() => {
    window.__shotshelfStubs__ = { get_settings: { __rejects__: "state not managed" } };
  });
  await bootShelf(page);
  await land(page, FIXTURE.wide);
  await openBrowse(page);

  // Waits out the retry deliberately. `readStored` re-asks for five seconds
  // before it gives up — a settings read can lose a start-up race, and giving
  // up in 600 ms was under the delay it exists for — so the report arrives
  // after the watch-folder message, which shares this one strip.
  await expect(page.locator("#shelf-alert")).toHaveText(/Settings could not be loaded/, {
    timeout: 15_000,
  });
  await page.evaluate(() => window.__shotshelf__.clearCalls());

  await page.locator(".tile__action--pin").click();

  // The pin is applied on screen; it is simply not written over the file we
  // could not read.
  await expect(page.locator(".tile--pinned")).toHaveCount(1);
  expect(await page.evaluate(() => window.__shotshelf__.callsTo("set_pinned").length)).toBe(0);
});

test("pins come back when the settings read loses a start-up race and wins the retry", async ({
  page,
}) => {
  // The other half of the pin-loss fix. `get_settings` can lose to Rust's
  // setup hook, and the point of retrying is that the *transient* case
  // recovers — pins restored, writes allowed. Only the permanent case was
  // covered, so shortening the retry to a single attempt changed nothing.
  // Built from the shared fixture, not written out again. This object was a
  // fourth hand-maintained copy of the settings shape and had already drifted
  // — it was missing `checkForUpdates` — so the one spec that exercises the
  // start-up read was doing it against a payload the app no longer sends.
  await page.addInitScript((stored) => {
    window.__shotshelfStubs__ = {
      get_settings: { __rejectsTimes__: 2, then: stored },
    };
  }, {
    ...DEFAULT_SETTINGS,
    pinned: [{ path: "/captures/tall.png", kind: "image", ts: 1 }],
  });
  await bootShelf(page);
  await openBrowse(page);

  // The pin that was on disk is back, which it never is when the read fails.
  await expect(page.locator(".tile")).toHaveCount(1);
  // And no settings failure was reported — the harness's own "no capture
  // folders" line is on this strip in every test, so the assertion has to be
  // about the message rather than about the strip.
  await expect(page.locator("#shelf-alert")).not.toHaveText(/Settings could not be loaded/);

  // And writing is allowed again, because the settings were genuinely read.
  await page.evaluate(() => window.__shotshelf__.clearCalls());
  await land(page, FIXTURE.wide, { ts: 2 });
  await openBrowse(page);
  await page.locator(".tile").first().locator(".tile__action--pin").click();
  await expect
    .poll(() => page.evaluate(() => window.__shotshelf__.callsTo("set_pinned").length))
    .toBeGreaterThan(0);
});

test("captures taken while the app was closed come back on the next launch", async ({ page }) => {
  // Shotshelf only hears about a capture from a watcher, and a watcher only
  // runs while the app does — so before this, every restart lost everything
  // taken since the last one, while the README promised the opposite.
  //
  // Pulled, not pushed, and that is the whole point of the test. The first
  // version emitted `capture://new` from a thread spawned during Rust's
  // `setup`, which fires while this bundle is still loading — and Tauri
  // delivers only to registered handlers and buffers nothing, so the feature
  // was a silent no-op. Asserting on tiles rather than on the call proves the
  // answer actually arrived somewhere the user can see.
  await page.addInitScript(() => {
    window.__shotshelfStubs__ = {
      catch_backfill: [
        { path: "/captures/tall.png", kind: "image", ts: 1 },
        { path: "/captures/wide.png", kind: "image", ts: 2 },
      ],
    };
  });
  await bootShelf(page);
  await openBrowse(page);

  await expect(page.locator(".tile")).toHaveCount(2);
  // Newest at the top, from the time each was *taken* — not the launch time,
  // which would put yesterday's screenshots under "Today" and restart their
  // retention clock on every launch.
  await expect(page.locator(".tile").first()).toHaveAttribute("title", /wide\.png/);
});

test("a launch with nothing missed does not pop the column", async ({ page }) => {
  // Backfilled captures are added, not `catch`ed: they are not new, so they
  // must not throw the column over whatever the user is doing at launch.
  await page.addInitScript(() => {
    window.__shotshelfStubs__ = {
      catch_backfill: [{ path: "/captures/wide.png", kind: "image", ts: 1 }],
    };
  });
  await bootShelf(page);

  await expect(page.locator(".tile")).toHaveCount(1);
  expect(await page.evaluate(() => window.__shotshelf__.callsTo("show_shelf").length)).toBe(0);
});

// The column's expiry timer reaches the same guard by a second route —
// `onColumnChange` took the `else showColumn()` branch whenever cards remained
// after a hide — and it is *not* covered here. A test for it needs a card to
// expire while the column still holds another, and `ColumnQueue.expire` refuses
// to run at all while anything holds the column; nothing reachable from the page
// clears the hold that `bootShelf` leaves armed. Rather than a test that passes
// without exercising the path, this is written down: both routes go through
// `#showing`, which the test above pins.

test("the watching indicator is not green when nothing is being watched", async ({ page }) => {
  // Rust reports the folders it is *actually* watching — `folders::start` drops
  // any the watcher refused — so an empty list means the app's one job is not
  // happening. The dot was turned green unconditionally, which undid that fix
  // one line into the front end: an exhausted inotify limit, a declined macOS
  // permission or a folder redirected to an offline share all looked healthy.
  //
  // The harness answers `catch_watch_dirs` with `[]` by default, so this was
  // the untested default rather than an exotic case.
  await bootShelf(page);

  await expect(page.locator("#shelf-mark")).not.toHaveClass(/shelf__mark--live/);
  await expect(page.locator("#shelf-alert")).toContainText(/No capture folders are being watched — only the clipboard/i);
});

test("the watching indicator is green when a folder really is watched", async ({ page }) => {
  await page.addInitScript(() => {
    window.__shotshelfStubs__ = { catch_watch_dirs: ["/home/someone/Pictures"] };
  });
  await bootShelf(page);

  await expect(page.locator("#shelf-mark")).toHaveClass(/shelf__mark--live/);
  await expect(page.locator("#shelf-mark")).toHaveAttribute("title", /Pictures/);
});

test("an unreachable catch engine is not shown as healthy either", async ({ page }) => {
  // Distinct from watching nothing: this is the app not knowing. Only the
  // `.then` set the indicator, so a rejection left the dot with no state and
  // no tooltip, and the sole signal erased itself after twelve seconds.
  await page.addInitScript(() => {
    window.__shotshelfStubs__ = { catch_watch_dirs: { __rejects__: "engine is down" } };
  });
  await bootShelf(page);

  await expect(page.locator("#shelf-mark")).not.toHaveClass(/shelf__mark--live/);
  await expect(page.locator("#shelf-mark")).toHaveAttribute("title", /could not reach/i);
});

test("a shelf that asks before the catch engine is up waits rather than reporting failure", async ({
  page,
}) => {
  // The engine starts on a worker — resolving watch folders can take SMB round
  // trips on a redirected profile — while the webview is created before Rust's
  // `setup` runs and asks within milliseconds. Both catch commands answer
  // "still starting" for that window, and the difference between retrying and
  // believing them is the difference between a working launch and being told
  // your captures are not being watched, permanently, on a healthy machine.
  //
  // The retry had no test at all: replacing it with a bare throw left every
  // spec green, because nothing anywhere rejected with that message — the
  // harness could only reject with `get_settings`'s wording.
  // The sentinel is passed *in* rather than closed over: `addInitScript` runs
  // its function in the page, where a Node-side constant is not in scope, so a
  // closure would have supplied `undefined` and the retry would never have
  // matched.
  await page.addInitScript((starting: string) => {
    window.__shotshelfStubs__ = {
      catch_watch_dirs: {
        __rejectsTimes__: 3,
        because: starting,
        then: ["/home/someone/Pictures"],
      },
      catch_backfill: {
        __rejectsTimes__: 3,
        because: starting,
        then: [{ path: "/captures/wide.png", kind: "image", ts: 1 }],
      },
    };
  }, ENGINE_STARTING);
  await bootShelf(page);
  await openBrowse(page);

  // Both waited and both got their real answer: the indicator is live and the
  // capture the launch missed is on the shelf.
  await expect(page.locator("#shelf-mark")).toHaveClass(/shelf__mark--live/);
  await expect(page.locator("#shelf-mark")).toHaveAttribute("title", /Pictures/);
  await expect(page.locator(".tile")).toHaveCount(1);
  // And nothing was reported as broken along the way.
  await expect(page.locator("#shelf-alert")).not.toContainText(/could not reach/i);
});

test("a shelf the user dismissed is not put back by an alert", async ({ page }) => {
  // The window is frameless and always-on-top. Bringing it back uninvited is
  // not a cosmetic bug.
  //
  // `resizeColumn` guarded on `columnIsEmpty`, which is not "the column is off
  // screen": `adoptHidden` calls `setMode("column")`, a no-op when the mode is
  // already "column", so the queue survives the hide. Hidden with cards in it
  // satisfied neither guard, and every `say()` — including the launch update
  // notice and its own twelve-second expiry — called through to `show_shelf`.
  await bootShelf(page);
  await land(page, FIXTURE.wide);
  await expect(page.locator(".tile")).toHaveCount(1);

  await page.evaluate(() => window.__shotshelf__.emit("shelf://hidden", null));
  await page.evaluate(() => window.__shotshelf__.clearCalls());

  // The app's own update notice, which needs no failure to reach.
  await page.evaluate((event) => window.__shotshelf__.emit(event, "0.3.0"), UPDATE_EVENT);
  await expect(page.locator("#shelf-alert")).toContainText("0.3.0");

  expect(await page.evaluate(() => window.__shotshelf__.callsTo("show_shelf").length)).toBe(0);
});

test("Escape in the settings panel closes the panel, not the shelf", async ({ page }) => {
  // Escape had no settings rung, so it fell through to `dismiss()` while
  // `settingsOpen()` stayed true — and `main.ts`'s first guard then swallowed
  // every shelf key for the rest of the session.
  await bootShelf(page);
  await land(page, FIXTURE.wide);
  await openBrowse(page);
  await page.locator("#shelf-settings").click();
  await expect(page.locator(".settings")).toBeVisible();

  await page.evaluate(() => window.__shotshelf__.clearCalls());
  await page.keyboard.press("Escape");

  await expect(page.locator(".settings")).toBeHidden();
  expect(await page.evaluate(() => window.__shotshelf__.callsTo("hide_shelf").length)).toBe(0);

  // And the keyboard is alive again: Escape now reaches the shelf.
  await page.keyboard.press("Escape");
  expect(await page.evaluate(() => window.__shotshelf__.callsTo("hide_shelf").length)).toBe(1);
});

test("a pin that could not be saved says so instead of lighting the star in silence", async ({
  page,
}) => {
  // `set_pinned` returned `()` on the Rust side, so `invoke` could never
  // reject: on a full disk or a read-only profile the star lit, the panel said
  // nothing, and the pin was gone at the next launch — against the promise that
  // pins are the one thing that survives a restart.
  await bootShelf(page);
  await land(page, FIXTURE.wide);
  await page.evaluate(() =>
    window.__shotshelf__.reject("set_pinned", "Those pins could not be saved: no space left"),
  );

  await page.locator(".tile").hover();
  await page.locator(".tile__action--pin").click();

  await expect(page.locator("#shelf-alert")).toBeVisible();
  await expect(page.locator("#shelf-alert")).toContainText(/could not be saved/i);
});
