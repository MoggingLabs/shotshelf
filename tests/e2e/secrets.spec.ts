/**
 * The credential warning.
 *
 * Two properties matter more than the marker appearing at all, and both are
 * asserted here as absences — the kind of thing that silently stops being true
 * and that nobody notices until it matters.
 *
 * It must never block: the drag, the copy and the pin keep working on a
 * flagged capture, because a tool that refuses to hand over your own
 * screenshot is a tool people turn off.
 *
 * It must never leak: the whole purpose is to stop a value spreading, so the
 * value must not reach the DOM — not as text, not as a tooltip, not as an
 * attribute.
 */

import { bootShelf, expect, FIXTURE, land, test } from "../harness/app.ts";

/** A finding as Rust reports it: already masked, never the value itself. */
const TOKEN_FINDING = {
  kind: "serviceToken",
  label: "GitHub token",
  preview: "ghp_…",
  severity: 3,
};

async function withFindings(
  page: import("@playwright/test").Page,
  secrets: unknown[],
): Promise<void> {
  // No `text` field: the recognised text deliberately does not cross into the
  // webview, so a harness that supplied one would be testing a contract the
  // app no longer has.
  await page.evaluate(
    (findings) =>
      window.__shotshelf__.respond("describe_capture", { secrets: findings, scanned: true }),
    secrets,
  );
}

test("a capture carrying a token is marked", async ({ page }) => {
  await bootShelf(page);
  await withFindings(page, [TOKEN_FINDING]);
  await land(page, FIXTURE.wide);

  await expect(page.locator(".tile__secret")).toBeVisible();
  await expect(page.locator(".tile")).toHaveClass(/tile--secret/);
  await expect(page.locator(".tile__secret")).toHaveAttribute("data-kind", "serviceToken");
});

test("a capture carrying nothing is not marked", async ({ page }) => {
  await bootShelf(page);
  await withFindings(page, []);
  await land(page, FIXTURE.wide);

  await expect(page.locator(".tile")).toBeVisible();
  await expect(page.locator(".tile__secret")).toHaveCount(0);
});

test("the warning never blocks the drag or the copy", async ({ page }) => {
  await bootShelf(page);
  await withFindings(page, [TOKEN_FINDING]);
  await page.evaluate(() =>
    window.__shotshelf__.respond("prepare_drag", { path: "/x.png", icon: "/x.png" }),
  );
  await land(page, FIXTURE.wide);
  await expect(page.locator(".tile__secret")).toBeVisible();

  // Copy still works.
  await page.locator(".tile").hover();
  await page.locator(".tile__action--copy").click();
  await expect
    .poll(() => page.evaluate(() => window.__shotshelf__.callsTo("copy_capture").length))
    .toBe(1);

  // And so does the drag. Pressed on the picture rather than where the copy
  // button is: the action buttons are deliberately excluded from arming a
  // drag, so pressing on one would prove nothing.
  const card = await page.locator(".tile").boundingBox();
  expect(card).not.toBeNull();
  await page.mouse.move(card!.x + 20, card!.y + card!.height - 12);
  await page.mouse.down();
  await page.mouse.move(140, 240);
  await expect
    .poll(() => page.evaluate(() => window.__shotshelf__.callsTo("prepare_drag").length))
    .toBe(1);
  await page.mouse.up();
});

test("the warning never puts the secret itself in the page", async ({ page }) => {
  await bootShelf(page);
  // What Rust would have masked — asserted here in case it ever stops masking.
  await withFindings(page, [TOKEN_FINDING]);
  await land(page, FIXTURE.wide);
  await expect(page.locator(".tile__secret")).toBeVisible();

  // Asserted against what the *masking rule* produces, not against a string
  // the harness never supplies. The previous version checked for a token body
  // that could not enter the system under test, so it could not fail — and its
  // fixture still carried the old leaky "ghp_A1b…" shape, which the Rust rule
  // stopped producing when the marker length became per-pattern.
  const shown = await page.locator(".tile__secret").getAttribute("title");
  expect(shown).toContain("ghp_");
  // Only the type marker survives; nothing after it.
  expect(shown).not.toMatch(/ghp_[A-Za-z0-9]/);
});

test("several findings are counted, worst first", async ({ page }) => {
  await bootShelf(page);
  // Deliberately delivered in the wrong order. The previous version of this
  // test fed an already-sorted list, so it asserted the harness's ordering
  // rather than the app's — it would have passed with the sort deleted.
  await withFindings(page, [
    { kind: "personalData", label: "email address", preview: "someone…", severity: 1 },
    TOKEN_FINDING,
    { kind: "privateKey", label: "private key", preview: "-----BE…", severity: 4 },
  ]);
  await land(page, FIXTURE.wide);

  await expect(page.locator(".tile__secret-count")).toHaveText("3");
  await expect(page.locator(".tile__secret")).toHaveAttribute("data-kind", "privateKey");
  await expect(page.locator(".tile__secret")).toHaveAttribute("title", /private key and 2 others/);
});

test("a capture that cannot be read is marked unread, not warned about", async ({ page }) => {
  await bootShelf(page);
  // A machine with no recogniser at all takes this path.
  await page.evaluate(() =>
    window.__shotshelf__.reject("describe_capture", "text recognition unavailable"),
  );
  await land(page, FIXTURE.wide);

  await expect(page.locator(".tile")).toBeVisible();
  // Not a credential warning — there is nothing to warn about — but not
  // nothing either, because a bare card claims to have been checked.
  await expect(page.locator(".tile__unscanned")).toBeVisible();
  await expect(page.locator(".tile__secret")).toHaveCount(0);
  // Nothing about *this* on the alert strip: the absence of a warning has
  // never meant "safe", and saying so on every capture would train people to
  // ignore it.
  //
  // Asserted on the text, not on the element's visibility. `toBeHidden` passed
  // for the wrong reason — the column shape used to `display: none` the strip
  // outright, so this held even while the strip carried "No capture folders
  // are being watched", which the boot genuinely says. One shared element
  // cannot answer "did *this* feature stay quiet" by being invisible.
  //
  // Matched against the words the app would actually use if it *did* report
  // this — `status.ts` and `main.ts` are the only writers, and "credential"
  // is the word they use for it. A pattern no reachable message can contain
  // would pass for the same reason `toBeHidden` did.
  await expect(page.locator("#shelf-alert")).not.toContainText(/credential|secret/i);
});

test("recordings are not scanned", async ({ page }) => {
  await bootShelf(page);
  await page.evaluate(() =>
    window.__shotshelf__.respond("video_details", { poster: null, durationMs: 1000, bytes: 100 }),
  );
  await land(page, "/clips/a.mp4", { kind: "video" });
  await expect(page.locator(".tile")).toBeVisible();

  // There is no text in a video frame worth the cost of decoding one for it.
  expect(await page.evaluate(() => window.__shotshelf__.callsTo("describe_capture").length)).toBe(0);
});

test("a failing credential probe is not reported as the catch engine failing", async ({ page }) => {
  // This shipped: the availability probe was chained inside the watch-folder
  // call's `.then`, so its rejection landed in that call's `.catch` and the
  // shelf announced "The catch engine is unavailable" while the catch engine
  // was perfectly fine. A failure attributed to the wrong subsystem is worse
  // than one reported nowhere, and only a screenshot golden caught it.
  //
  // Seeded before boot, not declared after it. `main.ts` fires both of these
  // during module evaluation and the harness answers synchronously, so a
  // `reject()` after `bootShelf` arrived after the probe had already been
  // answered `true` from the harness defaults — the rejection never happened,
  // and the assertion below held for the trivial reason that the alert strip
  // ships hidden. That version passed with the probe deleted outright, and
  // with the probe chained back into the watch-folder `.catch`, which is the
  // exact regression it exists to guard.
  await page.addInitScript(() => {
    window.__shotshelfStubs__ = {
      catch_watch_dirs: { dirs: ["/pictures/Screenshots"], clipboard: true },
      text_recognition_available: { __rejects__: "no recogniser" },
    };
  });
  await bootShelf(page);

  // The probe really ran and really failed. Without this the rest is vacuous.
  await expect
    .poll(() =>
      page.evaluate(() => window.__shotshelf__.callsTo("text_recognition_available").length),
    )
    .toBe(1);

  // The catch engine is reported as working, because it is.
  await expect(page.locator("#shelf-mark")).toHaveClass(/shelf__mark--live/);
  await expect(page.locator("#shelf-alert")).toBeHidden();
});

test("the shelf says once when captures are not being checked", async ({ page }) => {
  await page.addInitScript(() => {
    window.__shotshelfStubs__ = {
      catch_watch_dirs: { dirs: ["/pictures/Screenshots"], clipboard: true },
      // What macOS and Linux report today.
      text_recognition_available: false,
    };
  });
  await bootShelf(page);

  // In the status tooltip rather than on every card: this is a standing
  // property of the platform, and a warning on each tile is one people stop
  // reading. Saying nothing was the worse option — it made an unchecked
  // capture look identical to a checked one.
  await expect
    .poll(() => page.locator("#shelf-mark").getAttribute("title"))
    .toMatch(/not checked for credentials/);
  await expect(page.locator("#shelf-alert")).toBeHidden();
});

test("a capture that could not be read is marked as unread, not as clean", async ({ page }) => {
  await bootShelf(page);
  // Text recognition is available — this particular file would not decode.
  // The platform probe cannot express that, which is why `scanned` exists.
  await page.evaluate(() =>
    window.__shotshelf__.respond("describe_capture", { secrets: [], scanned: false }),
  );
  await land(page, FIXTURE.wide);

  // A card with no marker at all is a card claiming to have been checked.
  await expect(page.locator(".tile__unscanned")).toBeVisible();
  await expect(page.locator(".tile__secret")).toHaveCount(0);
});

test("a capture that was read and came back clean carries no marker", async ({ page }) => {
  await bootShelf(page);
  await page.evaluate(() =>
    window.__shotshelf__.respond("describe_capture", { secrets: [], scanned: true }),
  );
  await land(page, FIXTURE.wide);
  await expect(page.locator(".tile")).toBeVisible();

  await expect(page.locator(".tile__unscanned")).toHaveCount(0);
  await expect(page.locator(".tile__secret")).toHaveCount(0);
});
