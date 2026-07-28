/**
 * What the shelf keeps, shows and lets go of.
 *
 * These are the behaviours a user would notice breaking, exercised through the
 * real app in a real browser rather than through its internals. Where a rule
 * is already covered by a unit test on the store, the test here is that the
 * rule is actually *wired up* — the two failures look identical to a user and
 * only one of them is caught by testing the rule alone.
 */

import { bootShelf, expect, FIXTURE, land, openBrowse, test } from "../harness/app.ts";

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
  expect(await lastShowHeight(page)).toBe(136);

  await land(page, FIXTURE.tall, { ts: 2 });
  await expect(page.locator(".tile")).toHaveCount(2);
  expect(await lastShowHeight(page)).toBe(257);

  await land(page, FIXTURE.square, { ts: 3 });
  await expect(page.locator(".tile")).toHaveCount(3);
  expect(await lastShowHeight(page)).toBe(378);
});

test("the column never grows past what fits on screen", async ({ page }) => {
  await bootShelf(page);
  for (let index = 0; index < 9; index += 1) await land(page, FIXTURE.wide, { ts: index });

  // Five cards' worth, and it scrolls beyond that rather than growing off the top.
  expect(await lastShowHeight(page)).toBe(5 * 112 + 4 * 9 + 24);
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
  await page.locator(".tile__action").first().click();

  await expect(page.locator(".tile")).toHaveClass(/tile--pinned/);
  await expect
    .poll(async () => {
      const calls = await page.evaluate(() => window.__shotshelf__.callsTo("set_pinned"));
      return (calls.at(-1)?.args["pinned"] as unknown[] | undefined)?.length;
    })
    .toBe(1);
});

test("copying a capture asks Rust for the clipboard, not the DOM", async ({ page }) => {
  await bootShelf(page);
  await land(page, FIXTURE.wide);
  await openBrowse(page);

  await page.locator(".tile").hover();
  await page.locator(".tile__action").nth(1).click();

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

test("a card is labelled with what was in front when it was taken", async ({ page }) => {
  await bootShelf(page);
  await page.evaluate(() =>
    window.__shotshelf__.emit("capture://new", {
      path: "/captures/wide.png",
      kind: "image",
      ts: 1,
      context: { app: "Code", title: "auth.ts", label: "Code — auth.ts" },
    }),
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
