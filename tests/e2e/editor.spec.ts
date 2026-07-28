/**
 * Marking up a capture.
 *
 * The tools exist for one job — telling someone else, or a model, where to
 * look — and the one property that must never quietly stop holding is that a
 * redaction destroys what it covers rather than drawing over it.
 */

import { bootShelf, expect, FIXTURE, land, openBrowse, test } from "../harness/app.ts";

async function openEditor(
  page: import("@playwright/test").Page,
  file: string = FIXTURE.wide,
): Promise<void> {
  await bootShelf(page);
  await page.evaluate(() => {
    // `preview_shelf` reports nothing back: in the app Rust really does resize
    // the window, and the canvas is fitted to the stage it ends up with rather
    // than to any number crossing IPC. In the browser the window cannot resize
    // at all, which is exactly why the fit assertions below are written
    // against the stage — they hold at whatever size the stage happens to be.
    window.__shotshelf__.respond("preview_shelf", null);
    window.__shotshelf__.respond("save_edit", "/edits/wide (edited).png");
  });
  await land(page, file);
  await openBrowse(page);

  await page.keyboard.press("ArrowDown");
  await expect(page.locator("#shelf-edit")).toBeVisible();
  await page.locator("#shelf-edit").click();
  await expect(page.locator(".editor__canvas")).toBeVisible();
}

/**
 * How far the canvas spills out of what it must fit inside — measured twice,
 * because the two halves of the fix mask each other.
 *
 * `rendered*` is the canvas's box against the **editor frame**, which is the
 * fixed one: `.editor` is `position:absolute; inset:0`, so it cannot grow to
 * accommodate its contents. That catches the CSS half.
 *
 * `buffer*` is the canvas's own pixel buffer against the stage. That catches
 * the `fit()` half, which CSS would otherwise hide by scaling an oversized
 * buffer down to something that looks correct.
 *
 * The earlier version measured only the canvas against the stage, and passed
 * with either half reverted — the stage is content-sized under the CSS
 * regression, so the difference was zero in exactly the failure mode the test
 * existed to catch. It only failed with both halves broken at once, which is
 * not what its name claimed.
 */
async function overflow(page: import("@playwright/test").Page): Promise<{
  renderedBelow: number;
  renderedRight: number;
  bufferTaller: number;
  bufferWider: number;
}> {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>(".editor__canvas");
    const stage = document.querySelector(".editor__stage");
    const frame = document.querySelector(".editor");
    if (!canvas || !stage || !frame) throw new Error("the editor is not on screen");

    const shown = canvas.getBoundingClientRect();
    const outer = frame.getBoundingClientRect();
    return {
      renderedBelow: shown.bottom - outer.bottom,
      renderedRight: shown.right - outer.right,
      bufferTaller: canvas.height - stage.clientHeight,
      bufferWider: canvas.width - stage.clientWidth,
    };
  });
}

/**
 * The canvas pixel under a rendered coordinate.
 *
 * The honest way to ask whether a mark is still there. Counting editors or
 * save calls answers a different question — a *replaced* editor is still one
 * editor — which is how two tests here passed with the fix they guarded
 * reverted.
 */
async function inkAt(
  page: import("@playwright/test").Page,
  x: number,
  y: number,
): Promise<(number | undefined)[]> {
  return page.evaluate(
    ({ x, y }) => {
      const canvas = document.querySelector<HTMLCanvasElement>(".editor__canvas");
      const context = canvas?.getContext("2d");
      if (!canvas || !context) throw new Error("no canvas");
      const box = canvas.getBoundingClientRect();
      // Rendered coordinates to backing-store pixels.
      const data = context.getImageData(
        Math.round((x / box.width) * canvas.width),
        Math.round((y / box.height) * canvas.height),
        1,
        1,
      ).data;
      return [data[0], data[1], data[2], data[3]];
    },
    { x, y },
  );
}

/** What the user's pointer would actually reach at the centre of `selector`. */
async function hitTest(
  page: import("@playwright/test").Page,
  selector: string,
): Promise<boolean> {
  return page.evaluate((target) => {
    const box = document.querySelector(target)?.getBoundingClientRect();
    if (!box) throw new Error(`${target} is not on screen`);
    const at = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return at?.closest(target) !== null && at !== null;
  }, selector);
}

/**
 * Wait for the save to actually land.
 *
 * Saving is asynchronous — the canvas is composited, `toBlob` encodes it, and
 * the bytes are read — so reading the call straight after clicking races it.
 * On a loaded runner that race is a coin flip: one of these tests passed on
 * retry and the other failed with "the source image could not be decoded",
 * which is what reading `undefined` bytes looks like from inside the page.
 */
async function savedPng(page: import("@playwright/test").Page): Promise<number[]> {
  await expect
    .poll(() => page.evaluate(() => window.__shotshelf__.callsTo("save_edit").length))
    .toBeGreaterThan(0);

  // The PNG travels as the request body, not as a JSON array of integers.
  return page.evaluate(() => [
    ...(window.__shotshelf__.callsTo("save_edit").at(-1)?.body ?? []),
  ]);
}

/** Drag on the canvas, in canvas coordinates. */
async function drag(
  page: import("@playwright/test").Page,
  from: [number, number],
  to: [number, number],
): Promise<void> {
  const box = await page.locator(".editor__canvas").boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + from[0], box!.y + from[1]);
  await page.mouse.down();
  await page.mouse.move(box!.x + to[0], box!.y + to[1], { steps: 4 });
  await page.mouse.up();
}

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
  // gesture this used to use could not reach two captures at all — and the
  // half of the test that mattered had no assertion after it either way.
  const cards = page.locator(".tile");
  await cards.nth(0).click();
  await cards.nth(1).click({ modifiers: ["ControlOrMeta"] });
  await expect(page.locator("#shelf-edit")).toBeHidden();
  // Two is the number that offers a comparison instead.
  await expect(page.locator("#shelf-compare")).toBeVisible();
});

test("the editor offers exactly the five tools", async ({ page }) => {
  await openEditor(page);

  // Deliberately few. Text, colours, layers and freehand are a different
  // product, and each one added makes the thirty-second path slower.
  await expect(page.locator(".editor__tool")).toHaveText([
    "Crop",
    "Box",
    "Arrow",
    "Number",
    "Redact",
  ]);
});

test("a mark is saved as a new capture, leaving the original alone", async ({ page }) => {
  await openEditor(page);
  await page.evaluate(() => window.__shotshelf__.clearCalls());

  await drag(page, [30, 25], [170, 95]);
  await page.locator("#editor-save").click();

  const png = await savedPng(page);
  // The source rides in a header now, percent-encoded because a header is
  // ASCII and a capture path is not.
  const headers = await page.evaluate(
    () => window.__shotshelf__.callsTo("save_edit").at(-1)?.headers,
  );
  expect(decodeURIComponent(headers?.["x-shotshelf-source"] ?? "")).toBe(FIXTURE.wide);
  // Real PNG bytes, composited in the page rather than re-rendered in Rust.
  expect(png.length).toBeGreaterThan(100);
  expect(png.slice(0, 4)).toEqual([0x89, 0x50, 0x4e, 0x47]);

  // The edit joins the shelf; the capture it came from is still there.
  await expect(page.locator(".tile")).toHaveCount(2);
});

test("a redaction destroys the pixels rather than drawing over them", async ({ page }) => {
  await openEditor(page);
  await page.locator('.editor__tool[data-tool="redact"]').click();
  await drag(page, [20, 20], [190, 105]);

  // Measured before saving: Save closes the editor, taking the canvas with it.
  const shown = await page.locator(".editor__canvas").boundingBox();
  expect(shown).not.toBeNull();

  await page.locator("#editor-save").click();
  await expect
    .poll(() => page.evaluate(() => window.__shotshelf__.callsTo("save_edit").length))
    .toBeGreaterThan(0);

  // Decode what was actually saved and read the pixels back. An overlay drawn
  // on an intact image would be separable from what it covers; this asserts
  // the covered pixels are simply not in the file.
  //
  // Decoded *inside* the page, reading the recorded call there. The bytes are
  // a whole PNG — tens of thousands of array elements — and shipping them out
  // to the test process and back in as an argument arrived undecodable on
  // every CI runner while working locally. They have no reason to cross the
  // boundary: the assertion is about what is in the file, and the file is
  // already in the page.
  //
  // The sample point is derived from the canvas the drag actually happened on,
  // rather than from an assumed size — the window is sized by Rust, so the
  // canvas is whatever fits, and a hard-coded width samples the wrong pixel.
  const covered = await page.evaluate(
    async ({ width, height }: { width: number; height: number }) => {
      const bytes = window.__shotshelf__.callsTo("save_edit").at(-1)?.body;
      if (!bytes?.length) throw new Error("nothing was saved");

      const blob = new Blob([new Uint8Array(bytes).slice()], { type: "image/png" });
      const bitmap = await createImageBitmap(blob);
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("no 2d context");
      context.drawImage(bitmap, 0, 0);

      // Middle of the drag, converted from rendered pixels to image pixels.
      // Each axis uses its own ratio: the element can be letterboxed by
      // `max-height`, so the two are not the same number.
      const data = context.getImageData(
        Math.round((105 / width) * bitmap.width),
        Math.round((62 / height) * bitmap.height),
        1,
        1,
      ).data;
      return [data[0], data[1], data[2], data[3]];
    },
    { width: shown!.width, height: shown!.height },
  );

  // Opaque and near-black: the fill, not the fixture's blue gradient.
  expect(covered[3]).toBe(255);
  expect(covered[0]).toBeLessThan(40);
  expect(covered[1]).toBeLessThan(40);
  expect(covered[2]).toBeLessThan(40);
});

test("undo takes back the last mark", async ({ page }) => {
  await openEditor(page);

  // Read straight off the canvas rather than by saving and counting calls.
  // Counting saves asserted only that *a* save happened — it passed with undo
  // doing nothing at all — and the round trip through `toBlob` made it flaky
  // under a loaded runner. This looks at the pixels the mark is made of.
  const clean = await inkAt(page, 25, 25);
  await drag(page, [25, 25], [150, 90]);
  const marked = await inkAt(page, 25, 25);
  expect(marked).not.toEqual(clean);

  await page.locator("#editor-undo").click();
  const undone = await inkAt(page, 25, 25);
  expect(undone).toEqual(clean);
});

test("escape backs out of the editor before it backs out of the shelf", async ({ page }) => {
  await openEditor(page);
  await page.evaluate(() => window.__shotshelf__.clearCalls());

  await page.keyboard.press("Escape");
  await expect(page.locator(".editor")).toHaveCount(0);
  expect(await page.evaluate(() => window.__shotshelf__.callsTo("hide_shelf").length)).toBe(0);

  await page.keyboard.press("Escape");
  await expect
    .poll(() => page.evaluate(() => window.__shotshelf__.callsTo("hide_shelf").length))
    .toBe(1);
});

test("the shelf keys do not reach the list while the editor is open", async ({ page }) => {
  await openEditor(page);

  // Delete belongs to the editor's surface here, not to the shelf underneath.
  await page.keyboard.press("Delete");
  await page.keyboard.press("Escape");

  await expect(page.locator(".tile")).toHaveCount(1);
});

test("a capture landing mid-annotation does not destroy the editor", async ({ page }) => {
  // The editor used to be a child of the card list, which the view rebuilds
  // wholesale on every render — so any capture arriving while you were marking
  // one up removed the editor from under you, silently, leaving the module
  // pointing at a detached node and the keyboard stuck in editor mode.
  await openEditor(page);
  await drag(page, [30, 25], [170, 95]);

  await land(page, FIXTURE.tall, { ts: 99 });

  await expect(page.locator(".editor__canvas")).toBeVisible();
  // And it is still the editor: Escape closes it rather than the shelf.
  await page.evaluate(() => window.__shotshelf__.clearCalls());
  await page.keyboard.press("Escape");
  await expect(page.locator(".editor")).toHaveCount(0);
  expect(await page.evaluate(() => window.__shotshelf__.callsTo("hide_shelf").length)).toBe(0);
});

test("holding the edit key does not stack editors", async ({ page }) => {
  await bootShelf(page);
  await page.evaluate(() => window.__shotshelf__.respond("preview_shelf", [220, 124]));
  await land(page, FIXTURE.wide);
  await openBrowse(page);
  await page.keyboard.press("ArrowDown");

  // Key auto-repeat puts a keydown inside every await of the open sequence,
  // and `live` is undefined for all of them.
  for (let press = 0; press < 5; press += 1) await page.keyboard.press("e");

  await expect(page.locator(".editor")).toHaveCount(1);
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

test("closing the editor gives the window back", async ({ page }) => {
  // The editor grows the window to show one capture large. Nothing put it
  // back: after every annotation the always-on-top shelf sat centred at 72% of
  // the screen showing a 225px column of cards until it was hidden and
  // reopened. The quick look next door always restored it, which is what made
  // the gap invisible — the behaviour existed, just not on this path.
  await openEditor(page);
  await page.evaluate(() => window.__shotshelf__.clearCalls());

  await page.keyboard.press("Escape");
  await expect(page.locator(".editor")).toHaveCount(0);

  const restored = await page.evaluate(() =>
    window.__shotshelf__.callsTo("show_shelf").map((call) => call.args["focus"]),
  );
  expect(restored).toEqual([true]);
});

test("saving gives the window back too", async ({ page }) => {
  await openEditor(page);
  await drag(page, [30, 25], [170, 95]);
  await page.evaluate(() => window.__shotshelf__.clearCalls());

  await page.locator("#editor-save").click();
  await expect(page.locator(".editor")).toHaveCount(0);

  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__shotshelf__.callsTo("show_shelf").filter((call) => call.args["focus"] === true)
            .length,
      ),
    )
    .toBe(1);
});

test("hiding the shelf takes the editor with it", async ({ page }) => {
  // The overlay was given a lifetime of its own so the list could rebuild
  // underneath it, and then nothing ended that lifetime. An editor survived
  // the hide, and the next capture popped a column with a stale canvas painted
  // across it — untouchable, because a popped column never takes focus, so
  // Escape could not reach the thing covering it either.
  await openEditor(page);
  await page.evaluate(() => window.__shotshelf__.clearCalls());

  await page.evaluate(() => window.__shotshelf__.emit("shelf://hidden", null));
  await expect(page.locator(".editor")).toHaveCount(0);

  // And it must not ask for the window back on the way out — the user just
  // put it away.
  expect(await page.evaluate(() => window.__shotshelf__.callsTo("show_shelf").length)).toBe(0);

  // The next capture pops a column showing just that capture — and the card
  // is actually reachable, which is the part that broke: a hit test at the
  // centre of the card used to land on the stale `.editor__canvas` over it.
  await land(page, FIXTURE.tall, { ts: 99 });
  await expect(page.locator(".tile")).toHaveCount(1);
  await expect(page.locator(".editor")).toHaveCount(0);
  expect(await hitTest(page, ".tile")).toBe(true);
});

test("hiding the shelf takes the quick look with it", async ({ page }) => {
  await bootShelf(page);
  await page.evaluate(() => window.__shotshelf__.respond("preview_shelf", null));
  await land(page, FIXTURE.wide);
  await openBrowse(page);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press(" ");
  await expect(page.locator(".preview")).toHaveCount(1);

  await page.evaluate(() => window.__shotshelf__.emit("shelf://hidden", null));
  await expect(page.locator(".preview")).toHaveCount(0);
});

test("the title strip stays usable while the editor is up", async ({ page }) => {
  // The overlay is absolutely positioned, and it was stretched across the
  // whole panel rather than across the list. On a frameless window that strip
  // is the only drag handle there is, and Hide and Settings live in it — so
  // opening the editor made the window unmovable and both buttons dead.
  await openEditor(page);
  await expect(page.locator(".editor")).toHaveCount(1);

  expect(await hitTest(page, "#shelf-hide")).toBe(true);
  expect(await hitTest(page, "#shelf-settings")).toBe(true);
  expect(await hitTest(page, ".shelf__bar")).toBe(true);
});

test("a save that fails says so where the user can see it", async ({ page }) => {
  // The editor's redact tool destroys pixels and the docs sell it as
  // permanent, so a failed save is the one failure here that must never be
  // quiet. The message was being written correctly and then painted over by
  // the overlay that had just been stretched across the panel.
  await openEditor(page);
  await drag(page, [30, 25], [170, 95]);
  const marked = await inkAt(page, 30, 25);
  await page.evaluate(() => window.__shotshelf__.reject("save_edit", "the disk is full"));

  await page.locator("#editor-save").click();

  // The message itself, not merely that the strip is showing something. The
  // harness boots with no watch folders, so start-up writes "No capture
  // folders found" to this strip — which made `toBeVisible()` true for the
  // whole session and this test pass with the save's failure report deleted.
  const alert = page.locator("#shelf-alert");
  await expect(alert).toHaveText(/could not be saved/);
  // `toHaveText` reads textContent and says nothing about visibility — a
  // `display: none` strip with the right words in it satisfies it. Both halves
  // are needed: the text catches a missing report, the visibility catches one
  // that is painted out of existence.
  await expect(alert).toBeVisible();
  expect(await hitTest(page, "#shelf-alert")).toBe(true);
  // And the *marks* are still there to try again with, which is what the
  // message promises. Asserting the frame count alone would pass with the
  // session cleared out from under it.
  await expect(page.locator(".editor")).toHaveCount(1);
  expect(await inkAt(page, 30, 25)).toEqual(marked);
});

test("the canvas fits the stage it is given, on both axes", async ({ page }) => {
  // `resize` fitted width only and leaned on a CSS `max-height: 100%` that
  // could not apply — the stage was a content-sized grid row, so the
  // percentage resolved against the canvas's own height and did nothing. The
  // stage does not scroll, so the bottom of a tall capture was simply cut off,
  // and after a crop to a tall region the user could see under half of what
  // they had just cropped to.
  await openEditor(page, FIXTURE.tall);

  const opened = await overflow(page);
  expect(opened.renderedBelow).toBeLessThanOrEqual(1);
  expect(opened.renderedRight).toBeLessThanOrEqual(1);
  expect(opened.bufferTaller).toBeLessThanOrEqual(1);
  expect(opened.bufferWider).toBeLessThanOrEqual(1);

  // Crop to a tall sliver, which is the shape that was worst.
  await page.locator('.editor__tool[data-tool="crop"]').click();
  const box = await page.locator(".editor__canvas").boundingBox();
  expect(box).not.toBeNull();
  await drag(
    page,
    [box!.width * 0.3, box!.height * 0.05],
    [box!.width * 0.5, box!.height * 0.95],
  );

  const cropped = await overflow(page);
  expect(cropped.renderedBelow).toBeLessThanOrEqual(1);
  expect(cropped.renderedRight).toBeLessThanOrEqual(1);
  expect(cropped.bufferTaller).toBeLessThanOrEqual(1);
  expect(cropped.bufferWider).toBeLessThanOrEqual(1);
});

test("escape during a slow open cancels it instead of dismissing the shelf", async ({ page }) => {
  // `editorIsOpen()` goes true the instant an open begins, but the close paths
  // bailed on "nothing is live yet" — so Escape fell straight through to
  // dismissing the popover, and the editor then mounted itself into a window
  // that was no longer on screen.
  await bootShelf(page);
  await page.evaluate(() => window.__shotshelf__.hang("preview_shelf"));
  await land(page, FIXTURE.wide);
  await openBrowse(page);
  await page.keyboard.press("ArrowDown");

  await page.keyboard.press("e");
  await page.keyboard.press("Escape");

  expect(await page.evaluate(() => window.__shotshelf__.callsTo("hide_shelf").length)).toBe(0);
  await expect(page.locator(".editor")).toHaveCount(0);
});

test("a capture whose file has gone reports rather than doing nothing", async ({ page }) => {
  // The Edit control is offered for any single picked capture, including one
  // whose file has since been emptied out of the Recycle Bin. The open failed
  // and returned in silence, so the button simply looked broken.
  await bootShelf(page);
  await page.evaluate(() => window.__shotshelf__.respond("preview_shelf", null));
  await land(page, FIXTURE.missing);
  await openBrowse(page);
  await page.keyboard.press("ArrowDown");

  await page.locator("#shelf-edit").click();

  // Asserted on the text for the same reason as above: the boot message made
  // "the strip is visible" true before this test did anything at all.
  await expect(page.locator("#shelf-alert")).toHaveText(/its file is gone/);
  await expect(page.locator("#shelf-alert")).toBeVisible();
  await expect(page.locator(".editor")).toHaveCount(0);
});

test("a double click on save writes one file", async ({ page }) => {
  await openEditor(page);
  await drag(page, [30, 25], [170, 95]);
  await page.evaluate(() => window.__shotshelf__.hang("save_edit"));

  await page.locator("#editor-save").click();
  await page.locator("#editor-save").click({ force: true });

  // Waited for rather than read straight away. A save composites the canvas
  // and encodes it before the call is made, so the count is legitimately 0 for
  // a moment — reading it immediately asserted that the click had done nothing
  // yet, which is a race the macOS runner lost.
  await expect
    .poll(() => page.evaluate(() => window.__shotshelf__.callsTo("save_edit").length))
    .toBe(1);

  // And it stays one. This half is a negative — the guard is what stops the
  // second click starting a second save — so it needs the second click to have
  // had its chance before the count means anything.
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => window.__shotshelf__.callsTo("save_edit").length)).toBe(1);
});

// ── The popped column ─────────────────────────────────────────────────────
//
// Every test above reaches the editor through `openBrowse`. None of them did
// before either, which is how two blockers lived here: the column shape hides
// the alert strip, and the column's expiry timer dismisses the window. Both
// are reachable by an ordinary sequence — a capture lands, you click the card,
// you press `e`.

/** Open the editor the way a user does when a capture has just landed. */
async function openEditorFromColumn(
  page: import("@playwright/test").Page,
  options: { fakeClock?: boolean } = {},
): Promise<void> {
  // Installed before `bootShelf`, which is the only order that works: the app
  // captures `setTimeout` at module evaluation.
  if (options.fakeClock) await page.clock.install();
  await bootShelf(page);
  await page.evaluate(() => {
    window.__shotshelf__.respond("preview_shelf", null);
    window.__shotshelf__.respond("save_edit", "/edits/wide (edited).png");
  });
  // No `openBrowse`: this is the auto-popup column.
  await land(page, FIXTURE.wide);
  await expect(page.locator(".shelf")).toHaveAttribute("data-mode", "column");

  await page.locator(".tile").first().click();
  await page.keyboard.press("e");
  await expect(page.locator(".editor__canvas")).toBeVisible();
}

test("opening the editor from the column puts the shelf into the browse shape", async ({
  page,
}) => {
  // `window::preview` sets Rust's "opened" flag; this event is the only thing
  // that tells the front-end. Without it the shelf kept rendering its column
  // shape around a full-size editor — which is what made both blockers below
  // reachable at all.
  await openEditorFromColumn(page);
  await expect(page.locator(".shelf")).toHaveAttribute("data-mode", "browse");
});

test("a failed save is visible when the editor was opened from the column", async ({ page }) => {
  await openEditorFromColumn(page);
  await drag(page, [30, 25], [170, 95]);
  await page.evaluate(() => window.__shotshelf__.reject("save_edit", "the disk is full"));

  await page.locator("#editor-save").click();

  // The redact tool destroys pixels and the docs sell it as permanent. This
  // message was being written correctly and painted out of existence by
  // `.shelf[data-mode="column"] .shelf__alert { display: none }`.
  await expect(page.locator("#shelf-alert")).toHaveText(/could not be saved/);
  await expect(page.locator("#shelf-alert")).toBeVisible();
  await expect(page.locator(".editor")).toHaveCount(1);
});

test("the column's timer does not tear down an open editor", async ({ page }) => {
  // `#ageColumn` vetoed on a drag in flight but not on an open overlay. When
  // the last card aged out it dismissed the window, which discarded the editor
  // and every unsaved mark in it — on a timer, with no message.
  await openEditorFromColumn(page, { fakeClock: true });
  await drag(page, [30, 25], [170, 95]);
  await page.evaluate(() => window.__shotshelf__.clearCalls());

  // Well past the card's minute, with the pointer off the window so no hold
  // is keeping the column alive. The clock is a real installed fake — without
  // `clock.install()` before boot, `runFor` advances nothing and the test
  // asserts that 0 ms of ageing changed nothing.
  await page.mouse.move(0, 0);
  await page.clock.runFor(70_000);

  await expect(page.locator(".editor__canvas")).toBeVisible();
  expect(await page.evaluate(() => window.__shotshelf__.callsTo("hide_shelf").length)).toBe(0);
});

test("the edit control is out of reach while the editor is open", async ({ page }) => {
  // The overlay deliberately does not cover the title strip — that is the
  // window's only drag handle — so Edit and Compare stayed live and clickable
  // behind an open editor. One click discarded every unsaved mark, silently:
  // `openEditor` treated "already open" as "replace me", and the `editing`
  // guard existed twice on the keyboard path and on neither click path.
  await openEditor(page);
  await drag(page, [30, 25], [170, 95]);

  await expect(page.locator("#shelf-edit")).toBeHidden();
  await expect(page.locator("#shelf-compare")).toBeHidden();

  // And even reached directly — the handler, not the button — it refuses
  // rather than replacing. Dispatched programmatically because Playwright
  // will not click a hidden element even with `force`, which is itself the
  // first lock working.
  //
  // Asserted on the *mark*, not on the editor count. An earlier version
  // checked that one editor existed with Undo visible — which a replacement
  // editor satisfies exactly, so it passed with the refuse-guard reverted.
  // That guard is the half of the fix which does not depend on remembering to
  // hide the button, and it was the half nothing checked.
  const marked = await inkAt(page, 30, 25);
  await page.evaluate(() => document.querySelector<HTMLButtonElement>("#shelf-edit")?.click());
  await expect(page.locator(".editor")).toHaveCount(1);
  expect(await inkAt(page, 30, 25)).toEqual(marked);

  // And the refused open left no trace on the editor that survived. Keying
  // the post-mount work off "is anything live" rather than "did *this* call
  // mount" bound a second set of pointer handlers to the same canvas, after
  // which one drag committed two marks and one undo took back half of it.
  const clean = await inkAt(page, 55, 55);
  await drag(page, [55, 55], [120, 85]);
  expect(await inkAt(page, 55, 55)).not.toEqual(clean);
  await page.locator("#editor-undo").click();
  expect(await inkAt(page, 55, 55)).toEqual(clean);
});

test("a save still in flight cannot tear down a later editor", async ({ page }) => {
  // `saveEditedCapture` composites, encodes and writes across three awaits and
  // then called the module-global close. Backing out mid-save and opening
  // something else meant the first save tore the *second* editor down and took
  // its marks with it.
  await openEditor(page);
  await drag(page, [30, 25], [170, 95]);

  // A save that is slow but *does* finish. `hang` would not do: it returns a
  // promise that never settles, and re-stubbing afterwards cannot resolve the
  // one already handed out — so the save would never land and the test would
  // pass with the bug present.
  await page.evaluate(() =>
    window.__shotshelf__.respondWith(
      "save_edit",
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve("/edits/wide (edited).png"), 900);
        }),
    ),
  );
  await page.locator("#editor-save").click();

  // Back out while that save is still outstanding, then open another.
  await page.keyboard.press("Escape");
  await expect(page.locator(".editor")).toHaveCount(0);
  await page.keyboard.press("e");
  await expect(page.locator(".editor__canvas")).toBeVisible();
  await drag(page, [40, 30], [120, 80]);

  // Let the first save land on top of the second editor.
  await expect
    .poll(() => page.evaluate(() => window.__shotshelf__.callsTo("save_edit").length), {
      timeout: 5000,
    })
    .toBeGreaterThan(0);
  await page.waitForTimeout(1200);

  await expect(page.locator(".editor")).toHaveCount(1);
});

test("backing out of a slow open leaves the keyboard working", async ({ page }) => {
  // `editorIsOpen()` reports `opening`, and the keydown handler routes on it,
  // so a cancelled open that stayed "opening" until its 15-second deadline
  // left the whole shelf keyboard dead — with Escape itself swallowed.
  await bootShelf(page);
  await page.evaluate(() => window.__shotshelf__.hang("preview_shelf"));
  await land(page, FIXTURE.wide);
  await openBrowse(page);
  await page.keyboard.press("ArrowDown");

  await page.keyboard.press("e");
  await page.keyboard.press("Escape");
  await page.evaluate(() => window.__shotshelf__.clearCalls());

  // Enter copies the picked capture. If the keyboard is dead this does nothing.
  await page.keyboard.press("Enter");
  await expect
    .poll(() => page.evaluate(() => window.__shotshelf__.callsTo("copy_capture").length))
    .toBe(1);
});

test("a quick look then an editor that will not open gives the window back", async ({ page }) => {
  // `editPicked` tears the quick look down with `discardPreview`, which owes no
  // restore by contract — so when the editor then refused, the always-on-top
  // window was left at 72% of the screen with a 225px list inside it.
  await bootShelf(page);
  await page.evaluate(() => window.__shotshelf__.respond("preview_shelf", null));
  await land(page, FIXTURE.missing);
  await openBrowse(page);
  await page.keyboard.press("ArrowDown");

  await page.keyboard.press(" ");
  await expect(page.locator(".preview")).toHaveCount(1);
  await page.evaluate(() => window.__shotshelf__.clearCalls());

  // The file is gone, so the editor reports and never grows the window.
  await page.keyboard.press("e");

  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__shotshelf__.callsTo("show_shelf").filter((c) => c.args["focus"] === true).length,
      ),
    )
    .toBeGreaterThan(0);
  await expect(page.locator(".editor")).toHaveCount(0);
});
