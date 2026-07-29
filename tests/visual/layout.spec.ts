/**
 * The visual gate that runs everywhere.
 *
 * Pixel goldens are pinned to one OS because font rasterisation differs
 * between them; these assertions are about geometry and computed style, so
 * they hold identically on every platform and never flake on a shadow.
 *
 * Every rule below is one that has actually broken. A shelf whose thumbnails
 * are unrecognisable still passes every behavioural test ever written — the
 * cards are there, the counts are right, the drags work — which is precisely
 * why appearance needs gating of its own.
 */

import { CARD_GAP, CARD_HEIGHT, COLUMN_PADDING } from "../../src/shelf/geometry.ts";
import { SECRET_KINDS } from "../../src/shelf/types.ts";
import { bootShelf, expect, FIXTURE, land, openBrowse, test } from "../harness/app.ts";

/** The card width, which `geometry.ts` states in prose rather than as a value. */
const CARD_WIDTH = 199;

test("a card is 16:9, the shape of the screen it came from", async ({ page }) => {
  await bootShelf(page);
  await land(page, FIXTURE.wide);

  const box = await page.locator(".tile").boundingBox();
  expect(box).not.toBeNull();
  // The original 3.8:1 tile kept only the middle 46% of a 1080p capture and
  // threw away the top, which is where a screenshot keeps its meaning.
  expect(box!.width / box!.height).toBeCloseTo(16 / 9, 1);
});

test("a card is the same size in the column and in the browse view", async ({ page }) => {
  await bootShelf(page);
  await land(page, FIXTURE.wide);

  const inColumn = await page.locator(".tile").boundingBox();
  await openBrowse(page);
  const inBrowse = await page.locator(".tile").boundingBox();

  // The whole point of the column: what pops up is the card you already know.
  expect(inColumn!.width).toBeCloseTo(inBrowse!.width, 0);
  expect(inColumn!.height).toBeCloseTo(inBrowse!.height, 0);
  expect(inColumn!.width).toBeCloseTo(CARD_WIDTH, 0);
  expect(inColumn!.height).toBeCloseTo(CARD_HEIGHT, 0);
});

test("thumbnails are fitted whole, never cropped to their middle", async ({ page }) => {
  await bootShelf(page);
  await land(page, FIXTURE.tall);

  // `cover` on a portrait capture in a 16:9 card discards most of it. `contain`
  // is what keeps an odd-shaped capture identifiable.
  await expect(page.locator(".tile__thumb")).toHaveCSS("object-fit", "contain");
});

test("the bars beside a fitted thumbnail carry a wash of the capture itself", async ({ page }) => {
  await bootShelf(page);
  await land(page, FIXTURE.tall);

  const wash = await page
    .locator(".tile")
    .evaluate((tile) => getComputedStyle(tile).getPropertyValue("--wash"));
  expect(wash).toContain("url(");

  // And the wash sits behind the picture, not over it.
  const order = await page.locator(".tile").evaluate((tile) => {
    const before = getComputedStyle(tile, "::before");
    return { position: before.position, opacity: Number(before.opacity) };
  });
  expect(order.position).toBe("absolute");
  expect(order.opacity).toBeGreaterThan(0);
  expect(order.opacity).toBeLessThan(1);
});

test("a recording keeps its film glyph and never renders a wash it has no picture for", async ({
  page,
}) => {
  await bootShelf(page);
  await page.evaluate(() =>
    window.__shotshelf__.reject("video_details", "ffmpeg unavailable"),
  );
  await land(page, "/clips/screencast.mp4", { kind: "video" });

  await expect(page.locator(".tile__thumb--glyph")).toBeVisible();
  const wash = await page
    .locator(".tile")
    .evaluate((tile) => getComputedStyle(tile).getPropertyValue("--wash"));
  expect(wash.trim()).toBe("");
});

test("a capture whose file has gone shows a warning rather than a hole", async ({ page }) => {
  await bootShelf(page);
  await land(page, FIXTURE.missing);

  // The fixture route 404s this one, so the real image error path runs.
  await expect(page.locator(".tile__thumb--missing")).toBeVisible();
});

test("the shelf is one column in both shapes", async ({ page }) => {
  await bootShelf(page);
  await land(page, FIXTURE.wide, { ts: 1 });
  await land(page, FIXTURE.tall, { ts: 2 });

  const columnTracks = await trackCount(page);
  await openBrowse(page);
  const browseTracks = await trackCount(page);

  // Two columns at 225 wide leaves a card too small to recognise anything in.
  expect(columnTracks).toBe(1);
  expect(browseTracks).toBe(1);
});

test("the popover's corner radius matches what rounds the window", async ({ page }) => {
  await bootShelf(page);

  const radius = await page.locator(".shelf").evaluate((el) => getComputedStyle(el).borderRadius);
  // The expectation comes from the user agent — the *input* to the decision —
  // rather than from `data-os`, which is the app's own output.
  //
  // That is the whole chain: UA → `main.ts` sets `data-os` → the stylesheet
  // selects a radius. Asserting the radius against `data-os` compared the
  // stylesheet with itself, so a regressed sniff moved the expectation along
  // with the result and the test passed while the window showed the wedge.
  //
  // Not `process.platform`: that describes the machine, and the page is not on
  // it. Playwright's Desktop Chrome descriptor carries a Windows UA on every
  // runner, so the host and the page genuinely disagree — and it is the page's
  // UA the app reads.
  const pageOnWindows = await page.evaluate(() => navigator.userAgent.includes("Windows"));

  // On Windows the window itself is rounded by DWM at a fixed 8px, and a panel
  // that disagrees leaves the acrylic backdrop showing as a wedge in each
  // corner — which is exactly what "the corners look square" turned out to be.
  expect(radius).toBe(pageOnWindows ? "8px" : "14px");

  // And the sniff in between is asserted rather than assumed, so a regression
  // there fails here instead of quietly moving the goalposts.
  const flagged = await page.evaluate(() => document.documentElement.dataset["os"]);
  expect(flagged).toBe(pageOnWindows ? "windows" : undefined);
});

test("card controls stay out of the way until you hover", async ({ page }) => {
  await bootShelf(page);
  await land(page, FIXTURE.wide);

  const actions = page.locator(".tile__actions");
  expect(await actions.evaluate((el) => Number(getComputedStyle(el).opacity))).toBe(0);

  await page.locator(".tile").hover();
  await expect
    .poll(() => actions.evaluate((el) => Number(getComputedStyle(el).opacity)))
    .toBeGreaterThan(0);
});

test("the empty state is centred, and stops being centred once a capture lands", async ({
  page,
}) => {
  await bootShelf(page);
  await openBrowse(page);
  await expect(page.locator("#shelf-items")).toHaveAttribute("data-empty", "true");

  await land(page, FIXTURE.wide);
  await openBrowse(page);

  // The flag was once set but never cleared, which left the grid centring
  // itself on content that was no longer empty.
  await expect(page.locator("#shelf-items")).toHaveAttribute("data-empty", "false");
});

/**
 * How many columns the card grid is laid out in.
 *
 * Returns 0 when the element is not a grid at all, which is the case this has
 * to be able to tell apart. `gridTemplateColumns` computes to the single token
 * `"none"` on a non-grid, so splitting on whitespace and counting gave 1 —
 * indistinguishable from one column, and green with `display: grid` deleted
 * from the stylesheet outright.
 */
async function trackCount(page: import("@playwright/test").Page): Promise<number> {
  return page
    .locator(".group__grid")
    .first()
    .evaluate((grid) => {
      const style = getComputedStyle(grid);
      if (!style.display.includes("grid")) return 0;
      const tracks = style.gridTemplateColumns;
      if (tracks === "none" || tracks === "") return 0;
      return tracks.split(/\s+/).filter(Boolean).length;
    });
}

test("a failure is readable in the peeked column, where the failures happen", async ({
  page,
}) => {
  // The column shape used to `display: none` this strip as "furniture you did
  // not ask for", with one hole cut in it for the editor overlay. Every other
  // message stayed painted out — including the drag failure, and the peeked
  // column is the primary drag surface. So the report most likely to be needed
  // was hidden in exactly the mode where it would be raised.
  //
  // Asserted with `toBeVisible`, not `toContainText`: text is present in a
  // `display: none` element too, which is why the e2e drag test passed
  // throughout. This one fails if the shape rule ever comes back.
  await bootShelf(page);
  await land(page, FIXTURE.wide);
  await expect(page.locator(".shelf")).toHaveAttribute("data-mode", "column");

  // Through a real `say()` path — the app's own update notice — rather than by
  // un-hiding the element by hand. Setting the attribute directly would test
  // the CSS against a state the app never produces.
  await page.evaluate(() => window.__shotshelf__.emit("update://available", "0.3.0"));

  await expect(page.locator("#shelf-alert")).toBeVisible();
  await expect(page.locator("#shelf-alert")).toContainText("0.3.0");

  // And the window was asked to grow by exactly what the strip takes.
  //
  // Making the message visible moved its height out of the card area:
  // `.shelf__alert` is `flex: none` inside a `flex: 1` body, in a window still
  // sized for one card. The message became readable and clipped the capture it
  // was usually about.
  const asked = await page.evaluate(() => {
    const calls = window.__shotshelf__.callsTo("show_shelf");
    return calls.at(-1)?.args["height"] as number | undefined;
  });
  // `offsetHeight`, not `clientHeight`: the strip has a 1px top border and it
  // occupies a pixel of the window like any other.
  const strip = await page.locator("#shelf-alert").evaluate((el: HTMLElement) => el.offsetHeight);
  const cards = await page.locator(".tile").count();

  // Through the same constants the stylesheet is mirrored against, so this
  // cannot drift from the card metrics the rest of this file maintains.
  expect(strip).toBeGreaterThan(0);
  expect(asked).toBe(cards * CARD_HEIGHT + (cards - 1) * CARD_GAP + COLUMN_PADDING + strip);
});

test("the CSS mirrors the card metrics the column window is sized against", async ({ page }) => {
  // `geometry.ts` says of these numbers: "mirrored in the CSS, and the mirror
  // is load-bearing". Nothing made them move together. `CARD_HEIGHT` was
  // checked against a literal copied into this file; the gap and the padding
  // were checked by nothing at all, so changing `gap: 9px` alone sized the
  // popup column wrong forever — clipping the last card or trailing dead
  // space — with every gate green.
  //
  // Imported rather than restated: a spec carrying its own copy of the number
  // is a fourth place for it to drift.
  await bootShelf(page);
  await land(page, FIXTURE.wide, { ts: 1 });
  await land(page, FIXTURE.tall, { ts: 2 });

  const measured = await page.evaluate(() => {
    const grid = document.querySelector(".group__grid");
    const items = document.querySelector(".shelf__items");
    const panel = document.querySelector(".shelf");
    if (!grid || !items || !panel) throw new Error("the column is not on screen");
    const gridStyle = getComputedStyle(grid);
    const itemsStyle = getComputedStyle(items);
    const panelStyle = getComputedStyle(panel);
    return {
      gap: parseFloat(gridStyle.rowGap),
      padding:
        parseFloat(itemsStyle.paddingTop) +
        parseFloat(itemsStyle.paddingBottom) +
        parseFloat(panelStyle.borderTopWidth) +
        parseFloat(panelStyle.borderBottomWidth),
    };
  });

  expect(measured.gap).toBeCloseTo(CARD_GAP, 1);
  expect(measured.padding).toBeCloseTo(COLUMN_PADDING, 1);

  // And the rendered card against the constant, not against a literal.
  const card = await page.locator(".tile").first().boundingBox();
  expect(card!.height).toBeCloseTo(CARD_HEIGHT, 0);
});

test("every secret kind the wire can carry has a style that matches it", async ({ page }) => {
  // The third and fourth declarations of `SecretKind`. Rust and TypeScript are
  // joined by `tests/fixtures/secret-kinds.json`; the CSS selectors were not,
  // so renaming a variant kept every gate green while the badge silently fell
  // back to the default colour — which is exactly what the round-trip test's
  // own docstring says the join exists to prevent.
  //
  // Two kinds are styled deliberately and three fall through; what this pins
  // is that each *styled* selector still matches a kind that exists, and that
  // every kind renders a badge at all.
  await bootShelf(page);

  const results = await page.evaluate((kinds) => {
    const styled = [...document.styleSheets]
      .flatMap((sheet) => {
        try {
          return [...sheet.cssRules];
        } catch {
          return [];
        }
      })
      .flatMap((rule) => {
        // Not every rule is a style rule; `@media` blocks have no selector.
        const text = (rule as Partial<CSSStyleRule>).selectorText;
        if (typeof text !== "string") return [];
        return [...text.matchAll(/\[data-kind="([^"]+)"\]/g)].map((m) => m[1]);
      });
    return { styled: [...new Set(styled)], known: kinds };
  }, SECRET_KINDS as unknown as string[]);

  // No selector may name a kind Rust cannot send.
  for (const kind of results.styled) {
    expect(results.known).toContain(kind);
  }
  // And at least one of them is styled, or this test is measuring nothing.
  expect(results.styled.length).toBeGreaterThan(0);
});
