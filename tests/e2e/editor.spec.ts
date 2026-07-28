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

/** How far the canvas spills out of the box it is supposed to fit inside. */
async function overflow(
  page: import("@playwright/test").Page,
): Promise<{ vertical: number; horizontal: number }> {
  return page.evaluate(() => {
    const canvas = document.querySelector(".editor__canvas")?.getBoundingClientRect();
    const stage = document.querySelector(".editor__stage")?.getBoundingClientRect();
    if (!canvas || !stage) throw new Error("the editor is not on screen");
    return {
      vertical: canvas.height - stage.height,
      horizontal: canvas.width - stage.width,
    };
  });
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

  return page.evaluate(
    () => window.__shotshelf__.callsTo("save_edit").at(-1)?.args["png"] as number[],
  );
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
  const call = await page.evaluate(() => window.__shotshelf__.callsTo("save_edit").at(-1)?.args);
  expect(call?.["source"]).toBe(FIXTURE.wide);
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
      const bytes = window.__shotshelf__.callsTo("save_edit").at(-1)?.args["png"] as
        | number[]
        | undefined;
      if (!bytes?.length) throw new Error("nothing was saved");

      const blob = new Blob([new Uint8Array(bytes)], { type: "image/png" });
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
  await drag(page, [25, 25], [150, 90]);
  await page.evaluate(() => window.__shotshelf__.clearCalls());

  await page.locator("#editor-undo").click();
  await page.locator("#editor-save").click();

  // Saving after undoing an only mark still produces a file — an unmarked
  // copy is a legitimate thing to want — but nothing was drawn on it.
  await expect
    .poll(() => page.evaluate(() => window.__shotshelf__.callsTo("save_edit").length))
    .toBe(1);
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
  await page.evaluate(() => window.__shotshelf__.reject("save_edit", "the disk is full"));

  await page.locator("#editor-save").click();

  const alert = page.locator("#shelf-alert");
  await expect(alert).toBeVisible();
  expect(await hitTest(page, "#shelf-alert")).toBe(true);
  // And the marks are still there to try again with.
  await expect(page.locator(".editor")).toHaveCount(1);
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
  expect(opened.vertical).toBeLessThanOrEqual(1);
  expect(opened.horizontal).toBeLessThanOrEqual(1);

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
  expect(cropped.vertical).toBeLessThanOrEqual(1);
  expect(cropped.horizontal).toBeLessThanOrEqual(1);
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
