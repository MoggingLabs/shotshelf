/**
 * The settings window: its own page, its own boot, the same wire.
 *
 * Everything here drives the real form in `settings.html` and asserts on what
 * reaches `set_settings` — the boundary a wrong reader crosses. The suite is
 * the in-shelf panel's old tests re-homed, plus the surfaces the panel never
 * had room for: sections, a theme, a hotkey recorder, the watch list, About.
 */

import {
  BOUNDS,
  DEFAULT_SETTINGS,
  SETTINGS_CHANGED_EVENT,
  bootSettings,
  expect,
  test,
} from "../harness/app.ts";

/** Echo the patch back, the way Rust does when nothing needs clamping. */
async function echoSaves(page: import("@playwright/test").Page): Promise<void> {
  await page.evaluate(() =>
    window.__shotshelf__.respondWith("set_settings", (args) => args["settings"]),
  );
}

/** The last settings object that reached Rust. */
async function saved(page: import("@playwright/test").Page): Promise<Record<string, unknown>> {
  const call = await page.evaluate(
    () => window.__shotshelf__.callsTo("set_settings").at(-1)?.args,
  );
  return (call?.["settings"] ?? {}) as Record<string, unknown>;
}

test("the sidebar shows one section at a time", async ({ page }) => {
  await bootSettings(page);

  // General is the landing section; the rest wait behind their tabs.
  await expect(page.locator('section[data-section="general"]')).toBeVisible();
  await expect(page.locator('section[data-section="about"]')).toBeHidden();

  await page.locator('button[data-section="about"]').click();

  await expect(page.locator('section[data-section="about"]')).toBeVisible();
  await expect(page.locator('section[data-section="general"]')).toBeHidden();
  await expect(page.locator('button[data-section="about"]')).toHaveAttribute(
    "aria-current",
    "page",
  );
});

test("each settings control writes the field it is labelled for", async ({ page }) => {
  // The in-shelf panel's central test, re-driven through the window. Three of
  // the original four controls once had no gate at all — a reader replaced
  // with a constant `null` kept every suite green — so every control gets
  // driven and every option the join with Rust depends on gets selected.
  await bootSettings(page);
  await echoSaves(page);

  // General is on screen at boot; the other sections come up behind their
  // tabs as the walk reaches them — a hidden control cannot be driven.
  // The dropdowns are the themed control, driven the way a user drives them;
  // the native select underneath is hidden and only carries the value.
  await page.locator("#setting-retention-button").click();
  await page.getByRole("option", { name: "8 hours" }).click();
  expect((await saved(page))["retentionHours"]).toBe(8);

  // "Forever" is the empty option, and it must reach Rust as null rather than
  // as 0 — which would expire every capture the moment it landed.
  await page.locator("#setting-retention-button").click();
  await page.getByRole("option", { name: "Forever" }).click();
  expect((await saved(page))["retentionHours"]).toBeNull();

  await page.locator("#setting-max").fill("25");
  await page.locator("#setting-max").dispatchEvent("change");
  expect((await saved(page))["maxItems"]).toBe(25);

  await page.locator("#setting-autostart").check();
  expect((await saved(page))["startAtLogin"]).toBe(true);

  await page.locator('button[data-section="capturing"]').click();
  await page.locator("#setting-downscale").check();
  expect((await saved(page))["downscaleExports"]).toBe(true);

  // Every option, because the values are the join with the Rust sweep — and
  // Forever must cross as null, not 0, for the same reason retention's does:
  // zero days would be "delete everything now".
  for (const [label, days] of [
    ["30 days", 30],
    ["90 days", 90],
    ["Forever", null],
  ] as const) {
    await page.locator("#setting-clipboard-keep-button").click();
    await page.getByRole("option", { name: label, exact: true }).click();
    expect((await saved(page))["clipboardKeepDays"]).toBe(days);
  }

  await page.locator('button[data-section="about"]').click();
  await page.locator("#setting-updates").uncheck();
  expect((await saved(page))["checkForUpdates"]).toBe(false);

  await page.locator('button[data-section="appearance"]').click();
  // Every corner, not one: the button values are the join with Rust's
  // DOCK_CORNERS, and the one most likely to drift is the one no test clicks.
  for (const corner of ["bottom-left", "top-right", "top-left", "bottom-right"]) {
    await page.locator(`[data-corner="${corner}"]`).click();
    expect((await saved(page))["dockCorner"]).toBe(corner);
    await expect(page.locator(`[data-corner="${corner}"]`)).toHaveAttribute(
      "aria-checked",
      "true",
    );
  }
  for (const [label, monitor] of [
    ["Where my cursor is", "cursor"],
    ["Primary", "primary"],
  ] as const) {
    await page.locator("#setting-monitor-button").click();
    await page.getByRole("option", { name: label }).click();
    expect((await saved(page))["dockMonitor"]).toBe(monitor);
  }
  for (const [label, theme] of [
    ["Dark", "dark"],
    ["Nord", "nord"],
    ["System", "system"],
  ] as const) {
    await page.locator("#setting-theme-button").click();
    await page.getByRole("option", { name: label, exact: true }).click();
    expect((await saved(page))["theme"]).toBe(theme);
  }
});

test("no native select is visible anywhere in the window", async ({ page }) => {
  // The owner's rule: the OS's white dropdown never appears. The native
  // elements stay in the DOM as value carriers, hidden by the enhancement.
  await bootSettings(page);
  for (const section of ["general", "capturing", "appearance", "shortcuts", "about"]) {
    await page.locator(`button[data-section="${section}"]`).click();
    await expect(page.locator("select:visible")).toHaveCount(0);
  }
});

test("the themed dropdown speaks keyboard", async ({ page }) => {
  // The select-only combobox contract: arrows open and walk, Enter chooses,
  // Escape closes without choosing — and is consumed, so the window does not
  // also act on the same press.
  await bootSettings(page);
  await echoSaves(page);

  const button = page.locator("#setting-retention-button");
  await button.focus();
  await page.keyboard.press("ArrowDown");
  await expect(button).toHaveAttribute("aria-expanded", "true");

  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");

  expect((await saved(page))["retentionHours"]).toBe(1);
  await expect(button).toHaveText("1 hour");
  await expect(button).toHaveAttribute("aria-expanded", "false");

  // Escape closes the list and nothing else changes.
  await page.keyboard.press("ArrowDown");
  await expect(button).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Escape");
  await expect(button).toHaveAttribute("aria-expanded", "false");
  expect((await saved(page))["retentionHours"]).toBe(1);
});

test("choosing a theme stamps the window at once", async ({ page }) => {
  await bootSettings(page);
  await echoSaves(page);
  await page.locator('button[data-section="appearance"]').click();

  await page.locator("#setting-theme-button").click();
  await page.getByRole("option", { name: "Dark", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("#setting-theme-button")).toHaveText("Dark");

  await page.locator("#setting-theme-button").click();
  await page.getByRole("option", { name: "Light", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});

test("every named theme changes the paint it names", async ({ page }) => {
  // The dropdown's option values, Rust's THEMES and the stylesheet's palette
  // blocks are three statements of one list. Driving each choice through the
  // real control and probing --window — the token every block overrides — is
  // what keeps the three from drifting: a block whose selector is misspelled
  // stamps the attribute and paints nothing, which a data-theme assertion
  // alone cannot see.
  const themes = [
    ["Solarized Light", "solarized-light", "#fdf6e3"],
    ["Solarized Dark", "solarized-dark", "#002b36"],
    ["Nord", "nord", "#2e3440"],
    ["Dracula", "dracula", "#282a36"],
    ["Gruvbox Dark", "gruvbox-dark", "#282828"],
    ["Catppuccin Mocha", "catppuccin-mocha", "#1e1e2e"],
  ] as const;
  await bootSettings(page);
  await echoSaves(page);
  await page.locator('button[data-section="appearance"]').click();

  for (const [label, theme, paint] of themes) {
    await page.locator("#setting-theme-button").click();
    await page.getByRole("option", { name: label, exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    const painted = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--window").trim(),
    );
    expect(painted).toBe(paint);
  }
});

test("the stored theme is stamped at boot", async ({ page }) => {
  await bootSettings(page, { settings: { theme: "dark" } });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

test("system follows the OS, live", async ({ page }) => {
  // "System" is not "whatever it was at boot": the media listener re-stamps
  // when the OS setting moves under a running app.
  await page.emulateMedia({ colorScheme: "light" });
  await bootSettings(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

test("the light palette really changes the paint", async ({ page }) => {
  // `data-theme` flipping while every token stays dark is the failure a
  // stamp-only assertion cannot see.
  await bootSettings(page, { settings: { theme: "light" } });
  const paint = await page.evaluate(
    () => getComputedStyle(document.documentElement).getPropertyValue("--window"),
  );
  expect(paint.trim()).toBe("#f4f5f8");
});

test("a clamp is applied out loud", async ({ page }) => {
  // Rust clamps and returns what it stored; the form adopts *that* answer and
  // says so — a 500 that silently became 200 reads as the app ignoring the
  // user.
  await bootSettings(page);
  await page.evaluate(() =>
    window.__shotshelf__.respondWith("set_settings", (args) => ({
      ...(args["settings"] as Record<string, unknown>),
      maxItems: 200,
    })),
  );

  await page.locator("#setting-max").fill("500");
  await page.locator("#setting-max").dispatchEvent("change");

  await expect(page.locator("#settings-note")).toContainText("limited to 200");
  await expect(page.locator("#setting-max")).toHaveValue("200");
});

test("a save that fails says so, and the control snaps back", async ({ page }) => {
  await bootSettings(page);
  await page.evaluate(() => window.__shotshelf__.reject("set_settings", "disk is full"));

  await page.locator("#setting-max").fill("12");
  await page.locator("#setting-max").dispatchEvent("change");

  await expect(page.locator("#settings-note")).not.toBeEmpty();
  // The stored value, not the failed edit: the store is the one owner of
  // control state.
  await expect(page.locator("#setting-max")).toHaveValue(
    String(DEFAULT_SETTINGS["maxItems"]),
  );
});

test("the item-cap control offers exactly the range Rust will accept", async ({ page }) => {
  // `settings.rs` clamps to `MIN_ITEMS..=MAX_ITEMS` and the input writes
  // `min`/`max` — two hand-maintained copies in two languages, joined through
  // `tests/fixtures/settings-bounds.json`, which a Rust test asserts the
  // constants against.
  await bootSettings(page);

  const input = page.locator("#setting-max");
  await expect(input).toHaveAttribute("min", String(BOUNDS.maxItems.min));
  await expect(input).toHaveAttribute("max", String(BOUNDS.maxItems.max));
});

test("the hotkey is recorded from real keys, not typed", async ({ page }) => {
  // The free-text field this replaces clipped its own value and taught its
  // syntax only through the truncation; the recorder builds the accelerator
  // from the keys themselves.
  await bootSettings(page);
  await echoSaves(page);
  await page.locator('button[data-section="shortcuts"]').click();

  await page.locator("#setting-hotkey").click();
  await expect(page.locator("#setting-hotkey")).toHaveText("Press keys…");

  // A bare modifier is not a combination; the recorder keeps waiting.
  await page.keyboard.press("Shift");
  await expect(page.locator("#setting-hotkey")).toHaveText("Press keys…");

  await page.keyboard.press("Control+Shift+KeyK");

  // The wire carries Tauri's spelling; the control shows the OS's.
  expect((await saved(page))["hotkey"]).toBe("CommandOrControl+Shift+K");
  await expect(page.locator("#setting-hotkey")).toHaveText("Ctrl+Shift+K");
});

test("escape cancels the recording without a save", async ({ page }) => {
  // Escape is the universal cancel, and in the old panel it was the one key
  // that *committed* a half-typed shortcut. The recorder must not save at all.
  await bootSettings(page);
  await page.locator('button[data-section="shortcuts"]').click();

  await page.locator("#setting-hotkey").click();
  await page.keyboard.press("Escape");

  await expect(page.locator("#setting-hotkey")).toHaveText(
    String(DEFAULT_SETTINGS["hotkey"]).replace("CommandOrControl", "Ctrl"),
  );
  expect(await page.evaluate(() => window.__shotshelf__.callsTo("set_settings").length)).toBe(0);
});

test("a save made elsewhere moves this window's controls", async ({ page }) => {
  // `settings://changed` is what keeps two windows honest about one store.
  await bootSettings(page);

  const stored = { ...DEFAULT_SETTINGS, maxItems: 7, theme: "dark" };
  await page.evaluate(
    ([event, settings]) => window.__shotshelf__.emit(event, settings),
    [SETTINGS_CHANGED_EVENT, stored] as const,
  );

  await expect(page.locator("#setting-max")).toHaveValue("7");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

test("adding a folder asks first, and closing the picker is a no", async ({ page }) => {
  // The picker hands back what the user clicked; nothing is saved or watched
  // until the inline question is answered. The default mock answers the
  // picker with null — the user closing it — and that must save nothing.
  await bootSettings(page);
  await echoSaves(page);
  await page.locator('button[data-section="capturing"]').click();

  await page.locator("#watch-add").click();
  expect(await page.evaluate(() => window.__shotshelf__.callsTo("set_settings").length)).toBe(0);

  await page.evaluate(() =>
    window.__shotshelf__.respond("choose_watch_folder", "C:\\Somewhere\\Else"),
  );
  await page.locator("#watch-add").click();

  // Picked is not yet chosen: the row asks, and Cancel leaves no trace.
  await expect(page.locator(".stg__watchitem--asking")).toContainText("C:\\Somewhere\\Else");
  await page.getByRole("button", { name: "Cancel" }).click();
  expect(await page.evaluate(() => window.__shotshelf__.callsTo("set_settings").length)).toBe(0);

  await page.locator("#watch-add").click();
  await page.getByRole("button", { name: "Watch", exact: true }).click();

  const call = await page.evaluate(() => window.__shotshelf__.callsTo("set_settings").at(-1)?.args);
  expect((call?.["settings"] as Record<string, unknown>)["watchAdded"]).toEqual([
    "C:\\Somewhere\\Else",
  ]);
});

test("stopping a watch asks first and sorts default from added", async ({ page }) => {
  await page.addInitScript(() => {
    const existing = window.__shotshelfStubs__ ?? {};
    window.__shotshelfStubs__ = {
      catch_watch_dirs: { dirs: ["C:\\Stock\\Screenshots", "C:\\Mine\\Grabs"], clipboard: true },
      ...existing,
    };
  });
  await bootSettings(page, { settings: { watchAdded: ["C:\\Mine\\Grabs"] } });
  await echoSaves(page);
  await page.locator('button[data-section="capturing"]').click();

  const rows = page.locator("#watch-list .stg__watchitem");
  await expect(rows).toHaveCount(3); // two folders + the clipboard, which has no ×

  // A stock folder goes on the removed list — the list Restore defaults
  // clears — and only after the row's question is answered.
  await rows.nth(0).locator(".stg__watchremove").click();
  await expect(page.locator(".stg__watchitem--asking")).toContainText("Files are never touched");
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  let call = await page.evaluate(() => window.__shotshelf__.callsTo("set_settings").at(-1)?.args);
  expect((call?.["settings"] as Record<string, unknown>)["watchRemoved"]).toEqual([
    "C:\\Stock\\Screenshots",
  ]);

  // An added folder is simply un-added; the removed list stays clean.
  await rows.nth(1).locator(".stg__watchremove").click();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  call = await page.evaluate(() => window.__shotshelf__.callsTo("set_settings").at(-1)?.args);
  expect((call?.["settings"] as Record<string, unknown>)["watchAdded"]).toEqual([]);
  expect((call?.["settings"] as Record<string, unknown>)["watchRemoved"]).toEqual([
    "C:\\Stock\\Screenshots",
  ]);
});

test("restore defaults brings the stock folders back and keeps yours", async ({ page }) => {
  await bootSettings(page, {
    settings: { watchAdded: ["C:\\Mine\\Grabs"], watchRemoved: ["C:\\Stock\\Screenshots"] },
  });
  await echoSaves(page);
  await page.locator('button[data-section="capturing"]').click();

  await page.locator("#watch-restore").click();
  await expect(page.locator(".stg__watchitem--asking")).toContainText(
    "Folders you added stay",
  );
  await page.getByRole("button", { name: "Restore", exact: true }).click();

  const call = await page.evaluate(() => window.__shotshelf__.callsTo("set_settings").at(-1)?.args);
  const saved = call?.["settings"] as Record<string, unknown>;
  expect(saved["watchRemoved"]).toEqual([]);
  expect(saved["watchAdded"]).toEqual(["C:\\Mine\\Grabs"]);
});

test("with nothing removed there is nothing to restore", async ({ page }) => {
  await bootSettings(page);
  await page.locator('button[data-section="capturing"]').click();
  await expect(page.locator("#watch-restore")).toBeDisabled();
});

test("capturing shows what is really being watched", async ({ page }) => {
  // The watch dot's diagnostic, finally somewhere findable — and it must be
  // the engine's answer, not the config's intent.
  await page.addInitScript(() => {
    const existing = window.__shotshelfStubs__ ?? {};
    window.__shotshelfStubs__ = {
      catch_watch_dirs: { dirs: ["C:\\Users\\me\\Pictures\\Screenshots"], clipboard: true },
      ...existing,
    };
  });
  await bootSettings(page);

  await page.locator('button[data-section="capturing"]').click();

  await expect(page.locator("#watch-list li")).toHaveCount(2);
  await expect(page.locator("#watch-list")).toContainText("Screenshots");
  await expect(page.locator("#watch-list")).toContainText("clipboard");
});

test("about carries the version and answers a check in place", async ({ page }) => {
  await bootSettings(page);
  await page.locator('button[data-section="about"]').click();

  // Baked at build time from package.json — the one version string the page
  // can show without a Tauri permission.
  await expect(page.locator("#about-version")).toHaveText(/^v\d+\.\d+\.\d+/);

  await page.locator("#about-check").click();
  await expect(page.locator("#update-answer")).toHaveText("You are on the newest version.");
  expect(await page.evaluate(() => window.__shotshelf__.callsTo("check_for_updates").length)).toBe(
    1,
  );
});

test("links leave through the named allowlist, never as raw URLs", async ({ page }) => {
  // `open_link` takes a name and matches it against Rust's allowlist — a
  // webview that can hand any URL to the OS browser is a phishing primitive.
  await bootSettings(page);
  await page.locator('button[data-section="about"]').click();

  await page.locator('a[href*="USAGE"]').click();

  const call = await page.evaluate(() => window.__shotshelf__.callsTo("open_link").at(-1)?.args);
  expect(call?.["which"]).toBe("usage");
});
