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
  preview: "ghp_A1b…",
};

async function withFindings(
  page: import("@playwright/test").Page,
  secrets: unknown[],
): Promise<void> {
  await page.evaluate(
    (findings) => window.__shotshelf__.respond("describe_capture", { text: "", secrets: findings }),
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
  await page.locator(".tile__action").nth(1).click();
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
  await withFindings(page, [{ ...TOKEN_FINDING, preview: "ghp_A1b…" }]);
  await land(page, FIXTURE.wide);
  await expect(page.locator(".tile__secret")).toBeVisible();

  const html = await page.content();
  expect(html).not.toContain("A1b2C3d4E5f6G7h8");
  // The masked preview is the most it may ever say.
  await expect(page.locator(".tile__secret")).toHaveAttribute("title", /ghp_A1b…/);
});

test("several findings are counted, worst first", async ({ page }) => {
  await bootShelf(page);
  await withFindings(page, [
    { kind: "privateKey", label: "private key", preview: "-----BE…" },
    TOKEN_FINDING,
    { kind: "personalData", label: "email address", preview: "someone…" },
  ]);
  await land(page, FIXTURE.wide);

  await expect(page.locator(".tile__secret-count")).toHaveText("3");
  await expect(page.locator(".tile__secret")).toHaveAttribute("data-kind", "privateKey");
  await expect(page.locator(".tile__secret")).toHaveAttribute("title", /private key and 2 others/);
});

test("a platform that cannot read captures marks nothing and says nothing", async ({ page }) => {
  await bootShelf(page);
  // macOS and Linux take this path today.
  await page.evaluate(() =>
    window.__shotshelf__.reject("describe_capture", "text recognition unavailable"),
  );
  await land(page, FIXTURE.wide);

  await expect(page.locator(".tile")).toBeVisible();
  await expect(page.locator(".tile__secret")).toHaveCount(0);
  // No alert strip either: the absence of a warning has never meant "safe",
  // and saying so on every capture would train people to ignore it.
  await expect(page.locator("#shelf-alert")).toBeHidden();
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
