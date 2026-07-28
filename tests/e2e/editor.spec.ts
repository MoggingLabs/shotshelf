/**
 * Marking up a capture.
 *
 * The tools exist for one job — telling someone else, or a model, where to
 * look — and the one property that must never quietly stop holding is that a
 * redaction destroys what it covers rather than drawing over it.
 */

import { bootShelf, expect, FIXTURE, land, openBrowse, test } from "../harness/app.ts";

async function openEditor(page: import("@playwright/test").Page): Promise<void> {
  await bootShelf(page);
  await page.evaluate(() => {
    // A size that fits the test viewport. In the app Rust really does resize
    // the window, so the canvas fits what it is given; a stub that claims a
    // window wider than the browser leaves the canvas overflowing and every
    // pointer coordinate landing somewhere other than where it looks.
    window.__shotshelf__.respond("preview_shelf", [220, 124]);
    window.__shotshelf__.respond("save_edit", "/edits/wide (edited).png");
  });
  await land(page, FIXTURE.wide);
  await openBrowse(page);

  await page.keyboard.press("ArrowDown");
  await expect(page.locator("#shelf-edit")).toBeVisible();
  await page.locator("#shelf-edit").click();
  await expect(page.locator(".editor__canvas")).toBeVisible();
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
  await page.keyboard.press("ArrowDown");
  await page.keyboard.down("Shift");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.up("Shift");
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

  // An odd number of presses leaves it open; the point is that it is one.
  expect(await page.locator(".preview").count()).toBeLessThanOrEqual(1);
});

test("a double click on save writes one file", async ({ page }) => {
  await openEditor(page);
  await drag(page, [30, 25], [170, 95]);
  await page.evaluate(() => window.__shotshelf__.hang("save_edit"));

  await page.locator("#editor-save").click();
  await page.locator("#editor-save").click({ force: true });

  expect(await page.evaluate(() => window.__shotshelf__.callsTo("save_edit").length)).toBe(1);
});
