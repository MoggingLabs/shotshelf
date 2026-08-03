/**
 * Marking up a capture, in the editor's own window.
 *
 * The tools exist for one job — telling someone else, or a model, where to
 * look — and the one property that must never quietly stop holding is that a
 * redaction destroys what it covers rather than drawing over it.
 *
 * Everything here drives `/editor.html`. How the *shelf* asks for that window,
 * and what happens to the shelf when it does, is `editor-open.spec.ts` — the
 * two used to be one file because the editor was an overlay inside the shelf's
 * window, and about a third of that file tested the seam between them rather
 * than the editor. That seam is now one command, so those tests are gone
 * rather than ported: an assertion about a coupling that no longer exists is
 * worse than no assertion at all.
 */

import {
  bootEditor,
  EDITOR_CLOSE_EVENT,
  EDITOR_OPEN_EVENT,
  expect,
  FIXTURE,
  test,
} from "../harness/app.ts";

/**
 * The editor, open on a capture, with a save that will succeed.
 *
 * `save_edit` is stubbed after the boot rather than seeded before it because
 * nothing reads it during module evaluation — unlike `edit_target`, which
 * `bootEditor` seeds for exactly that reason.
 */
async function openEditor(
  page: import("@playwright/test").Page,
  file: string = FIXTURE.wide,
): Promise<void> {
  await bootEditor(page, { target: file });
  await page.evaluate(() => {
    window.__shotshelf__.respond("save_edit", "/edits/wide (edited).png");
  });
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
      const frame = document.querySelector<HTMLElement>(".editor");
      const context = canvas?.getContext("2d");
      if (!canvas || !frame || !context) throw new Error("no canvas");
      const box = canvas.getBoundingClientRect();
      // Image coordinates, like `drag` — through the view, then CSS pixels to
      // backing-store pixels, which differ by `devicePixelRatio`.
      const scale = Number(frame.dataset["scale"]);
      const ratio = canvas.width / box.width;
      const data = context.getImageData(
        Math.round((x - Number(frame.dataset["originX"])) * scale * ratio),
        Math.round((y - Number(frame.dataset["originY"])) * scale * ratio),
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

/**
 * Where an image coordinate is on screen right now, in client pixels.
 *
 * For the specs that hold a drag open across several assertions and so cannot
 * use `drag`. The same conversion, exposed once rather than copied.
 */
async function imagePoint(
  page: import("@playwright/test").Page,
  point: [number, number],
): Promise<[number, number]> {
  return page.evaluate((at) => {
    const canvas = document.querySelector(".editor__canvas");
    const frame = document.querySelector<HTMLElement>(".editor");
    if (!canvas || !frame) throw new Error("the editor is not on screen");
    const box = canvas.getBoundingClientRect();
    const scale = Number(frame.dataset["scale"]);
    return [
      box.x + (at[0] - Number(frame.dataset["originX"])) * scale,
      box.y + (at[1] - Number(frame.dataset["originY"])) * scale,
    ] as [number, number];
  }, point);
}

/**
 * The part of the capture being edited: the whole picture until a crop, and
 * the crop afterwards. In image pixels, like every coordinate here.
 *
 * Read from the frame rather than measured off the canvas. The canvas is a
 * *viewport* — it is the stage's size and shows whatever the view is over — so
 * measuring it answers "how much could I see", which is a different question
 * and a bigger number whenever the capture is smaller than the window.
 */
async function region(page: import("@playwright/test").Page): Promise<{
  x: number;
  y: number;
  width: number;
  height: number;
}> {
  return page.evaluate(() => {
    const frame = document.querySelector<HTMLElement>(".editor");
    if (!frame) throw new Error("the editor is not on screen");
    return {
      x: Number(frame.dataset["regionX"]),
      y: Number(frame.dataset["regionY"]),
      width: Number(frame.dataset["regionWidth"]),
      height: Number(frame.dataset["regionHeight"]),
    };
  });
}

/**
 * Drag on the canvas, in **image** coordinates.
 *
 * Image pixels rather than stage pixels, because that is the space a mark is
 * stored in and the only one that means the same thing at every zoom. The
 * conversion reads the view off `.editor`'s dataset — the inverse of the
 * transform `render` draws under.
 *
 * These were stage coordinates once, which worked only because Fit used to
 * enlarge a small capture until it filled the window: the fixtures are 320×180
 * and smaller, so a point 30px from the canvas's corner happened to land on
 * the picture. Capping Fit at actual size — which is what every image viewer
 * does, and what the live run showed this one should — put the picture in the
 * middle with letterbox around it, and five drags started landing on nothing
 * at all.
 */
async function drag(
  page: import("@playwright/test").Page,
  from: [number, number],
  to: [number, number],
): Promise<void> {
  const at = await page.evaluate(
    ({ from, to }) => {
      const canvas = document.querySelector(".editor__canvas");
      const frame = document.querySelector<HTMLElement>(".editor");
      if (!canvas || !frame) throw new Error("the editor is not on screen");
      const box = canvas.getBoundingClientRect();
      const scale = Number(frame.dataset["scale"]);
      const originX = Number(frame.dataset["originX"]);
      const originY = Number(frame.dataset["originY"]);
      const stage = (point: [number, number]): [number, number] => [
        box.x + (point[0] - originX) * scale,
        box.y + (point[1] - originY) * scale,
      ];
      return { from: stage(from), to: stage(to) };
    },
    { from, to },
  );

  await page.mouse.move(at.from[0], at.from[1]);
  await page.mouse.down();
  await page.mouse.move(at.to[0], at.to[1], { steps: 4 });
  await page.mouse.up();
}
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

  // The saved edit joining the shelf is the shelf's half of this, asserted in
  // `editor-open.spec.ts` against `capture://edited` — this window holds no
  // list of captures to check. Here the window closes itself instead, which is
  // the editor's whole part in finishing.
  await expect
    .poll(() => page.evaluate(() => window.__shotshelf__.callsTo("hide_editor").length))
    .toBe(1);
});

test("a redaction destroys the pixels rather than drawing over them", async ({ page }) => {
  await openEditor(page);
  await page.locator('.editor__tool[data-tool="redact"]').click();

  // A rectangle around the middle of the capture — `wide.png` is 320×180 —
  // and sampled out of the *saved file* by fraction rather than by mapping
  // canvas coordinates into it. That mapping is what this test used to do, and
  // it stopped being true when the canvas became a viewport: it is the stage's
  // size now, with the picture placed inside it by the view.
  await drag(page, [90, 50], [230, 130]);

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
  const covered = await page.evaluate(async () => {
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

    /** A pixel of the saved image, by fraction of its own dimensions. */
    const at = (fx: number, fy: number): [number, number, number, number] => {
      const data = context.getImageData(
        Math.min(bitmap.width - 1, Math.round(fx * bitmap.width)),
        Math.min(bitmap.height - 1, Math.round(fy * bitmap.height)),
        1,
        1,
      ).data;
      return [data[0] ?? 0, data[1] ?? 0, data[2] ?? 0, data[3] ?? 0];
    };

    // The centre of the drag, and the four edges well outside it.
    return {
      inside: at(0.5, 0.5),
      above: at(0.5, 0.02),
      below: at(0.5, 0.98),
      left: at(0.02, 0.5),
      right: at(0.98, 0.5),
    };
  });

  // Opaque and near-black: the fill, not the fixture's blue gradient.
  expect(covered.inside[3]).toBe(255);
  expect(covered.inside[0]).toBeLessThan(40);
  expect(covered.inside[1]).toBeLessThan(40);
  expect(covered.inside[2]).toBeLessThan(40);

  // And *only* inside.
  //
  // One sample proved a redaction happened and said nothing about where. A
  // `fillRect(0, 0, 100000, 100000)` — every save destroying the whole capture
  // instead of the dragged rectangle — passed this test, which is the only test
  // of the app's one irreversible operation. Over-redaction is the direction
  // that loses data, and it was the direction with no assertion at all.
  // The predicate is "this is not the fill", not "this is bright": the
  // fixture's gradient is genuinely dark down its right edge, so a brightness
  // threshold fails on intact pixels. Near-black on *every* channel is what the
  // fill looks like, and it is the same test the inside sample passes.
  const isFill = (pixel: readonly number[]) =>
    pixel[3] === 255 && pixel[0]! < 40 && pixel[1]! < 40 && pixel[2]! < 40;

  for (const [side, pixel] of Object.entries(covered)) {
    if (side === "inside") continue;
    expect(isFill(pixel), `the capture was destroyed ${side} the redaction as well`).toBe(false);
  }
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

  // This window's own strip, not the shelf's. The report used to travel back
  // to `#shelf-alert` through a callback, which is exactly what the editor
  // having its own window makes impossible — and it is a plain improvement:
  // the message now appears on the surface the user is looking at rather than
  // on a 225px popover behind it.
  const alert = page.locator("#editor-note");
  await expect(alert).toHaveText(/could not be saved/);
  // `toHaveText` reads textContent and says nothing about visibility — a
  // `display: none` strip with the right words in it satisfies it. Both halves
  // are needed: the text catches a missing report, the visibility catches one
  // that is painted out of existence. The hit test is the third: `.editor` is
  // `position: absolute; inset: 0` over this whole page, so a strip *under* it
  // would satisfy both of the above and be unreadable.
  await expect(alert).toBeVisible();
  expect(await hitTest(page, "#editor-note")).toBe(true);
  // The window stays up, and the *marks* are still there to try again with,
  // which is what the message promises. Asserting the frame count alone would
  // pass with the session cleared out from under it.
  await expect(page.locator(".editor")).toHaveCount(1);
  expect(await page.evaluate(() => window.__shotshelf__.callsTo("hide_editor").length)).toBe(0);
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

  // Switch to another capture while that save is still outstanding. The window
  // stays up now — it is the same window showing something else — so this is
  // the *ordinary* way to reach the race rather than the exotic one it used to
  // be, and the ticket that guards it matters more, not less.
  await page.evaluate(
    ([event, path]) => window.__shotshelf__.emit(event, path),
    [EDITOR_OPEN_EVENT, FIXTURE.tall] as const,
  );
  // It asks first, because the marks are still unsaved until that slow save
  // lands — which is exactly the window this race lives in. Discarding is the
  // answer that reproduces it: it tears the first session down while its save
  // is still in the air.
  await page.locator(".editor__ask button", { hasText: "Discard and open" }).click();
  await expect(page.locator(".editor")).toHaveAttribute("data-capture", FIXTURE.tall);
  await drag(page, [40, 30], [120, 80]);
  const marked = await inkAt(page, 45, 35);

  // Let the first save land on top of the second capture.
  await expect
    .poll(() => page.evaluate(() => window.__shotshelf__.callsTo("save_edit").length), {
      timeout: 5000,
    })
    .toBeGreaterThan(0);
  await page.waitForTimeout(1200);

  // Still showing the second capture, still holding its mark, and the window
  // was never hidden out from under it.
  await expect(page.locator(".editor")).toHaveAttribute("data-capture", FIXTURE.tall);
  expect(await inkAt(page, 45, 35)).toEqual(marked);
  expect(await page.evaluate(() => window.__shotshelf__.callsTo("hide_editor").length)).toBe(0);
});
test("the crop guide dims around the selection without erasing it", async ({ page }) => {
  // `clearRect` on the selection made those pixels transparent, and there is
  // no layer underneath — the capture was painted onto this same canvas, and
  // the element's CSS background is near-black. So the region being framed
  // rendered as a solid dark rectangle: the crop tool hid the thing you were
  // using it to frame.
  await openEditor(page);
  await page.locator('.editor__tool[data-tool="crop"]').click();

  // Image coordinates throughout, so the samples mean the same thing at any
  // zoom and whatever the window's shape.
  const span = await region(page);
  const inside: [number, number] = [span.x + span.width * 0.5, span.y + span.height * 0.5];

  // Outside the selection, which is the half this test is named for and did
  // not check. Both samples are taken before and during the drag.
  const outside: [number, number] = [span.x + span.width * 0.08, span.y + span.height * 0.5];

  const before = await inkAt(page, ...inside);
  const beforeOutside = await inkAt(page, ...outside);

  // Hold a crop drag open across the middle of the capture.
  const from = await imagePoint(page, [span.x + span.width * 0.25, span.y + span.height * 0.25]);
  const to = await imagePoint(page, [span.x + span.width * 0.75, span.y + span.height * 0.75]);
  await page.mouse.move(from[0], from[1]);
  await page.mouse.down();
  await page.mouse.move(to[0], to[1], { steps: 6 });

  const guided = await inkAt(page, ...inside);
  const guidedOutside = await inkAt(page, ...outside);
  await page.mouse.up();

  // The capture is still there, at full opacity, inside the selection.
  expect(guided[3]).toBe(255);
  expect(guided).toEqual(before);

  // And it *is* dimmed outside it.
  //
  // `paintCropGuide` draws its bands strictly outside the selection, so a
  // sample taken only at the centre could never observe them: setting the dim
  // fill fully transparent — no dimming anywhere — left this test passing under
  // a name that promises the opposite. The two historical bugs in the comment
  // above are caught by the inside sample; the dimming itself was unguarded.
  expect(guidedOutside).not.toEqual(beforeOutside);
});

test("the crop guide still frames the selection on a second crop", async ({ page }) => {
  // The fix above corrected the *painting* and left the *coordinates*: `at()`
  // returns capture-absolute image pixels, canvas-x 0 is image-x `region.x`,
  // and this one call site scaled without subtracting the origin. With a crop
  // in effect the dim band was computed off-canvas, so it covered everything
  // and the selection hole landed outside the picture entirely — the same
  // symptom as before, reintroduced in offset form.
  //
  // Two details decide whether this spec can see that, and both are why the
  // first attempt at it could not:
  //
  //   1. **The first crop must be away from the origin.** With the crop at
  //      0,0 `region.x` is zero, the broken and the corrected expressions
  //      produce the same number, and the spec passes either way.
  //   2. **The second drag must enclose the sampled point.** Sampling
  //      somewhere the selection does not cover asserts that dimming happens,
  //      which is true in both versions.
  await openEditor(page);
  await page.locator('.editor__tool[data-tool="crop"]').click();

  const whole = await region(page);
  await drag(
    page,
    [whole.width * 0.5, whole.height * 0.5],
    [whole.width * 0.98, whole.height * 0.98],
  );

  // The view is refitted to the crop, so everything below re-measures — and
  // the crop's own origin is *not* zero, which is the whole point of this
  // spec. Image coordinates are capture-absolute, so the samples below are
  // offset by that origin rather than starting from it.
  // The crop's own origin is *not* zero, which is the whole point of this
  // spec: image coordinates are capture-absolute, so everything below is
  // offset by `span.x`/`span.y` rather than starting from them.
  const span = await region(page);
  expect(span.x).toBeGreaterThan(0);
  const inside: [number, number] = [span.x + span.width * 0.5, span.y + span.height * 0.5];

  const before = await inkAt(page, ...inside);

  const from = await imagePoint(page, [span.x + span.width * 0.2, span.y + span.height * 0.2]);
  const to = await imagePoint(page, [span.x + span.width * 0.8, span.y + span.height * 0.8]);
  await page.mouse.move(from[0], from[1]);
  await page.mouse.down();
  await page.mouse.move(to[0], to[1], { steps: 6 });

  const guided = await inkAt(page, ...inside);
  await page.mouse.up();

  expect(guided[3]).toBe(255);
  expect(guided).toEqual(before);
});

test("the mark under the pointer looks like the mark that lands", async ({ page }) => {
  // The live preview set its own `strokeStyle` and `lineWidth` and neither
  // `lineJoin` nor `lineCap`, because the constants were module-private to
  // `draw.ts`. So the rectangle you dragged had square corners and the one that
  // landed a millisecond later had round ones, and recolouring a mark would
  // have changed only half of it.
  //
  // Sampled on the stroke itself, mid-drag and after release, at a point on the
  // top edge away from any corner — the two must be the same ink.
  await openEditor(page);
  await page.locator('.editor__tool[data-tool="box"]').click();

  const span = await region(page);
  const from: [number, number] = [span.x + span.width * 0.25, span.y + span.height * 0.3];
  const to: [number, number] = [span.x + span.width * 0.75, span.y + span.height * 0.7];
  // Sampled one pixel outside the rectangle's starting corner.
  //
  // What this can and cannot see, stated because it was measured.
  //
  // It catches the divergence that matters — the two using different **ink**,
  // so recolouring a mark changes only the half you are not looking at.
  // Verified by giving the preview its own colour: the test fails.
  //
  // It does *not* catch the `lineJoin`/`lineCap` half of the same divergence.
  // At a 3px stroke a round join and a miter join at 90° differ by less than a
  // pixel after antialiasing, and neither an edge nor a corner sample can tell
  // them apart. That is worth knowing rather than papering over: the sharing
  // is still right, and this test guards the part of it that is observable.
  const atCorner: [number, number] = [from[0] - 1, from[1] - 1];

  const start = await imagePoint(page, from);
  const end = await imagePoint(page, to);
  await page.mouse.move(start[0], start[1]);
  await page.mouse.down();
  await page.mouse.move(end[0], end[1], { steps: 6 });
  const previewed = await inkAt(page, ...atCorner);
  await page.mouse.up();
  const committed = await inkAt(page, ...atCorner);

  expect(previewed).toEqual(committed);
});
test("a redaction previews as what it will do, not as a box around it", async ({ page }) => {
  // Every tool drew the same hollow amber rectangle while dragging, so the one
  // irreversible operation in the app looked exactly like Box until release —
  // against `draw.ts`'s own promise that what you see is a faithful preview of
  // the exported file. The gating spec used Box, the one tool where the preview
  // and the result agree.
  await openEditor(page);
  await page.locator('.editor__tool[data-tool="redact"]').click();

  const span = await region(page);
  const middle: [number, number] = [span.x + span.width * 0.5, span.y + span.height * 0.5];

  // Held open mid-drag, which is the whole point: this is about what is on
  // screen while the pointer is still down.
  const start = await imagePoint(page, [span.x + span.width * 0.25, span.y + span.height * 0.25]);
  const end = await imagePoint(page, [span.x + span.width * 0.75, span.y + span.height * 0.75]);
  await page.mouse.move(start[0], start[1]);
  await page.mouse.down();
  await page.mouse.move(end[0], end[1], { steps: 6 });

  const midDrag = await inkAt(page, ...middle);
  await page.mouse.up();

  // Opaque and near-black — the redaction fill, not a stroke over the capture.
  expect(midDrag[3]).toBe(255);
  expect(midDrag[0]).toBeLessThan(40);
  expect(midDrag[1]).toBeLessThan(40);
  expect(midDrag[2]).toBeLessThan(40);
});
test("ctrl+z takes back the last mark", async ({ page }) => {
  // The shortcut had no test at all — the undo test above clicks the button.
  //
  // A census of every key any spec pressed turned up no `z` anywhere, so
  // deleting `shelf.undoEdit()` from the `case "z"` branch left the whole gate
  // green, while docs/USAGE.md promises Ctrl+Z undoes the last mark including a
  // crop. The editor's marks are destructive and there is no redo, so the
  // shortcut not working is work permanently lost.
  await openEditor(page);

  const clean = await inkAt(page, 25, 25);
  await drag(page, [25, 25], [150, 90]);
  expect(await inkAt(page, 25, 25)).not.toEqual(clean);

  await page.keyboard.press("ControlOrMeta+z");
  expect(await inkAt(page, 25, 25)).toEqual(clean);
});

test("capslock does not put undo out of reach", async ({ page }) => {
  // `event.key` reports the character produced, so with CapsLock on it is "Z",
  // not "z" — which fell through every branch of the switch and left undo
  // unreachable. That bug shipped once on the shelf's own keymap, and this
  // window has a *new* keydown handler with its own case fold, so it is a
  // fresh chance to ship the same thing again.
  //
  // Shift is how Playwright produces a capital; the app cannot tell the two
  // apart, which is the whole point of folding the case rather than reading
  // modifiers. (The `e` half of this lives in `editor-open.spec.ts` — it is
  // the shelf's key, not the editor's.)
  await openEditor(page);

  const clean = await inkAt(page, 25, 25);
  await drag(page, [25, 25], [150, 90]);
  expect(await inkAt(page, 25, 25)).not.toEqual(clean);

  await page.keyboard.press("ControlOrMeta+Shift+Z");
  expect(await inkAt(page, 25, 25)).toEqual(clean);
});

test("the whole capture fits at Fit, and overflows on purpose at 100%", async ({ page }) => {
  // A tall capture in a wide window, so Fit is height-bound and 100% is not.
  await openEditor(page, FIXTURE.tall);

  await page.locator("#editor-fit").click();
  const fitted = await overflow(page);
  expect(fitted.bufferTaller).toBeLessThanOrEqual(1);
  expect(fitted.bufferWider).toBeLessThanOrEqual(1);

  // At 100% the canvas element still fills the stage — it is a viewport now,
  // not a picture — and what changes is how much of the capture is inside it.
  // This is the invariant that replaced "the canvas never exceeds the stage":
  // zoom makes that one false on purpose, and the canvas being *scaled down by
  // CSS* instead would have made zooming in produce a blurrier picture at the
  // same size, which is the failure this asserts against.
  await page.locator("#editor-zoom").click();
  await expect(page.locator("#editor-zoom")).toHaveText("100%");
  const full = await overflow(page);
  expect(full.bufferTaller).toBeLessThanOrEqual(1);
  expect(full.bufferWider).toBeLessThanOrEqual(1);
});

test("zoom changes what is on screen and never what is saved", async ({ page }) => {
  // The standing constraint with teeth: a saved edit is the *capture's* own
  // resolution, whatever the window was showing. `saveEditedCapture` composites
  // offscreen at scale 1 with no origin, so neither the zoom nor
  // `devicePixelRatio` can reach the file — and this is what proves it rather
  // than the comment saying so.
  await openEditor(page);
  await page.evaluate(() => window.__shotshelf__.clearCalls());

  await drag(page, [30, 25], [170, 95]);
  await page.locator("#editor-save").click();
  const atFit = await savedPng(page);

  // Same capture, same mark, wildly different view.
  await openEditor(page);
  await page.evaluate(() => window.__shotshelf__.clearCalls());
  await page.locator("#editor-zoom-in").click();
  await page.locator("#editor-zoom-in").click();
  await expect(page.locator("#editor-zoom")).not.toHaveText("100%");
  await page.locator("#editor-save").click();
  const zoomed = await savedPng(page);

  // The dimensions live in the IHDR chunk, bytes 16..24 of a PNG. Comparing
  // those rather than the whole file: the mark lands in different image pixels
  // because the drag is in *stage* coordinates and the view moved, which is
  // correct. What must not move is the size of the thing written.
  expect(zoomed.slice(16, 24)).toEqual(atFit.slice(16, 24));
});

test("a zoom is kept when the window is resized, and a fit is recomputed", async ({ page }) => {
  // The ResizeObserver re-fits, which is right in Fit mode and wrong at 100%:
  // it would undo the user's zoom every time they dragged a window edge, and
  // this window is maximizable. `layout()` branches on `view.fitted` for
  // exactly this, and nothing else would catch it.
  await openEditor(page);

  await page.locator("#editor-zoom").click();
  await expect(page.locator("#editor-zoom")).toHaveText("100%");

  await page.setViewportSize({ width: 700, height: 500 });
  await expect(page.locator("#editor-zoom")).toHaveText("100%");

  // In Fit mode the readout tracks the window instead. The window has to
  // become *smaller than the capture* for that to show: Fit never enlarges, so
  // a 320x180 fixture reads 100% at every size big enough to hold it, and an
  // assertion that the number merely "changes" would be asserting the bug this
  // cap exists to fix.
  await page.locator("#editor-fit").click();
  await expect(page.locator("#editor-zoom")).toHaveText("100%");

  await page.setViewportSize({ width: 260, height: 300 });
  await expect(page.locator("#editor-zoom")).not.toHaveText("100%");

  // …and back, without the user having touched the zoom.
  await page.setViewportSize({ width: 900, height: 700 });
  await expect(page.locator("#editor-zoom")).toHaveText("100%");
});

test("the close request asks before it discards, and goes quietly when clean", async ({
  page,
}) => {
  await openEditor(page);

  // Nothing drawn: the X is instant, and the window hides.
  await page.evaluate((event) => window.__shotshelf__.emit(event, null), EDITOR_CLOSE_EVENT);
  await expect
    .poll(() => page.evaluate(() => window.__shotshelf__.callsTo("hide_editor").length))
    .toBe(1);

  // With marks, the same request asks instead — and asks with three answers,
  // because a two-button question about unsaved work has no safe one.
  await openEditor(page);
  await drag(page, [30, 25], [170, 95]);
  await page.evaluate(() => window.__shotshelf__.clearCalls());
  await page.evaluate((event) => window.__shotshelf__.emit(event, null), EDITOR_CLOSE_EVENT);

  await expect(page.locator(".editor__ask")).toBeVisible();
  await expect(page.locator(".editor__ask button")).toHaveText(["Save", "Discard", "Cancel"]);
  expect(await page.evaluate(() => window.__shotshelf__.callsTo("hide_editor").length)).toBe(0);

  // Cancel leaves the marks alone and the window up.
  await page.locator(".editor__ask button", { hasText: "Cancel" }).click();
  await expect(page.locator(".editor__ask")).toHaveCount(0);
  await expect(page.locator(".editor")).toBeVisible();
  expect(await page.evaluate(() => window.__shotshelf__.callsTo("hide_editor").length)).toBe(0);
});

test("asking for another capture resumes the same one and asks about a different one", async ({
  page,
}) => {
  await openEditor(page);
  await drag(page, [30, 25], [170, 95]);
  const marked = await inkAt(page, 35, 30);

  // The same capture again — Rust shows and focuses the window before this
  // arrives, so a stray second press must cost nothing. Reloading would throw
  // the marks away without asking.
  await page.evaluate(
    ([event, path]) => window.__shotshelf__.emit(event, path),
    [EDITOR_OPEN_EVENT, FIXTURE.wide] as const,
  );
  await expect(page.locator(".editor")).toHaveAttribute("data-capture", FIXTURE.wide);
  expect(await inkAt(page, 35, 30)).toEqual(marked);

  // A *different* capture over unsaved marks asks first, and keeps showing the
  // one being asked about until it is answered.
  await page.evaluate(
    ([event, path]) => window.__shotshelf__.emit(event, path),
    [EDITOR_OPEN_EVENT, FIXTURE.tall] as const,
  );
  await expect(page.locator(".editor__ask")).toBeVisible();
  await expect(page.locator(".editor")).toHaveAttribute("data-capture", FIXTURE.wide);

  await page.locator(".editor__ask button", { hasText: "Discard and open" }).click();
  await expect(page.locator(".editor")).toHaveAttribute("data-capture", FIXTURE.tall);
});

test("a second open for the same capture does not bind a second set of handlers", async ({
  page,
}) => {
  // The nugget worth keeping from the old "the edit control is out of reach
  // while the editor is open": a repeated open used to leave a second listener
  // on the same canvas, so one drag committed two marks and one undo took back
  // half of it. The refusal left no other trace, which is why this is asserted
  // through the pixels rather than by counting anything.
  await openEditor(page);
  await page.evaluate(
    ([event, path]) => window.__shotshelf__.emit(event, path),
    [EDITOR_OPEN_EVENT, FIXTURE.wide] as const,
  );
  await expect(page.locator(".editor")).toHaveAttribute("data-capture", FIXTURE.wide);

  const clean = await inkAt(page, 25, 25);
  await drag(page, [25, 25], [150, 90]);
  expect(await inkAt(page, 25, 25)).not.toEqual(clean);

  // One undo, one mark gone. Two bindings would leave half of it behind.
  await page.keyboard.press("ControlOrMeta+z");
  expect(await inkAt(page, 25, 25)).toEqual(clean);
});
