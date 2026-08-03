/**
 * The settings window: one sidebar, one pane, no Save button.
 *
 * Controls save on change through the shared client, and Rust's
 * `settings://changed` brings back what was actually stored — so a clamped
 * value snaps visibly and a save made from the shelf side moves this window
 * too. The form is the only owner of control state; `fill` writes every
 * control from the store and runs after every change, ours or not.
 */

import { el } from "../dom.ts";
import { until, type Wait } from "../retry.ts";
import { enhanceSelect, refreshSelect } from "../ui/select.ts";
import { initTooltips } from "../ui/tooltip.ts";
import {
  checkForUpdatesNow,
  chooseWatchFolder,
  currentSettings,
  loadSettings,
  onSettingsChanged,
  openLink,
  saveSettings,
  type Settings,
  watchStateNow,
} from "../settings.ts";
import { applyTheme } from "../theme.ts";

const note = () => el<HTMLElement>("#settings-note");

/**
 * The accelerator, shown the way this OS spells it. The stored string keeps
 * Tauri's `CommandOrControl` so one settings file works on every machine;
 * shown verbatim it overflowed the control — the old panel's exact
 * truncation failure, reproduced in a button.
 */
const prettyHotkey = (hotkey: string): string =>
  hotkey.replace("CommandOrControl", navigator.userAgent.includes("Mac") ? "⌘" : "Ctrl");

// ── Sections ─────────────────────────────────────────────────────────────

/**
 * One section on screen at a time, driven by the sidebar. State lives in the
 * DOM (`aria-current` + `hidden`) — five buttons and five sections do not
 * need a router.
 */
function initNav(): void {
  const tabs = [...document.querySelectorAll<HTMLButtonElement>(".stg__tab")];
  const sections = [...document.querySelectorAll<HTMLElement>(".stg__section")];

  const show = (name: string): void => {
    for (const tab of tabs) {
      const on = tab.dataset["section"] === name;
      tab.classList.toggle("stg__tab--on", on);
      if (on) tab.setAttribute("aria-current", "page");
      else tab.removeAttribute("aria-current");
    }
    for (const section of sections) {
      section.toggleAttribute("hidden", section.dataset["section"] !== name);
    }
  };

  for (const tab of tabs) {
    tab.addEventListener("click", () => {
      const name = tab.dataset["section"];
      if (name !== undefined) show(name);
    });
  }
  show("general");
}

// ── The form ─────────────────────────────────────────────────────────────

/**
 * Save a patch and word the outcome.
 *
 * A clamp is applied out loud — `fill` snaps the control back and with no
 * sentence beside it a 500 that became 200 reads as the app ignoring the
 * user. Failures show Rust's own sentence; the detail goes to the console.
 */
async function save(patch: Partial<Settings>): Promise<void> {
  const asked = patch.maxItems;
  try {
    const stored = await saveSettings(patch);
    note().textContent =
      asked !== undefined && asked !== stored.maxItems
        ? `Max items was limited to ${stored.maxItems}.`
        : "";
  } catch (error) {
    console.error("[shotshelf] settings could not be saved", error);
    note().textContent = error instanceof Error ? error.message : String(error);
  }
  fill();
}

/** Every control, written from the store. The one owner of control state. */
function fill(): void {
  const current = currentSettings();

  const retention = el<HTMLSelectElement>("#setting-retention");
  const held = current.retentionHours === null ? "" : String(current.retentionHours);
  // A hand-edited file can hold a value the presets don't cover — show it
  // rather than silently falling back to "Forever".
  if (![...retention.options].some((choice) => choice.value === held)) {
    const extra = document.createElement("option");
    extra.value = held;
    extra.textContent = `${held} hours`;
    retention.append(extra);
  }
  retention.value = held;
  refreshSelect(retention);

  el<HTMLInputElement>("#setting-max").value = String(current.maxItems);
  el<HTMLInputElement>("#setting-downscale").checked = current.downscaleExports;
  el<HTMLInputElement>("#setting-autostart").checked = current.startAtLogin;
  el<HTMLInputElement>("#setting-updates").checked = current.checkForUpdates;
  const monitor = el<HTMLSelectElement>("#setting-monitor");
  monitor.value = current.dockMonitor;
  refreshSelect(monitor);
  const theme = el<HTMLSelectElement>("#setting-theme");
  theme.value = current.theme;
  refreshSelect(theme);
  el<HTMLButtonElement>("#setting-hotkey").textContent = prettyHotkey(current.hotkey);

  for (const corner of document.querySelectorAll<HTMLButtonElement>("[data-corner]")) {
    corner.setAttribute("aria-checked", String(corner.dataset["corner"] === current.dockCorner));
  }

  // Nothing removed means nothing to restore — a button that would save a
  // no-op is a button that lies about having done something.
  el<HTMLButtonElement>("#watch-restore").disabled = current.watchRemoved.length === 0;

  applyTheme(current.theme);
}

function bindControls(): void {
  el<HTMLSelectElement>("#setting-retention").addEventListener("change", (event) => {
    const value = (event.currentTarget as HTMLSelectElement).value;
    void save({ retentionHours: value === "" ? null : Number(value) });
  });
  el<HTMLInputElement>("#setting-max").addEventListener("change", (event) => {
    void save({ maxItems: Number((event.currentTarget as HTMLInputElement).value) });
  });
  el<HTMLInputElement>("#setting-downscale").addEventListener("change", (event) => {
    void save({ downscaleExports: (event.currentTarget as HTMLInputElement).checked });
  });
  el<HTMLInputElement>("#setting-autostart").addEventListener("change", (event) => {
    void save({ startAtLogin: (event.currentTarget as HTMLInputElement).checked });
  });
  el<HTMLInputElement>("#setting-updates").addEventListener("change", (event) => {
    void save({ checkForUpdates: (event.currentTarget as HTMLInputElement).checked });
  });
  el<HTMLSelectElement>("#setting-monitor").addEventListener("change", (event) => {
    void save({
      dockMonitor: (event.currentTarget as HTMLSelectElement).value as Settings["dockMonitor"],
    });
  });

  el<HTMLSelectElement>("#setting-theme").addEventListener("change", (event) => {
    void save({ theme: (event.currentTarget as HTMLSelectElement).value as Settings["theme"] });
  });
  for (const corner of document.querySelectorAll<HTMLButtonElement>("[data-corner]")) {
    corner.addEventListener("click", () => {
      void save({ dockCorner: corner.dataset["corner"] as Settings["dockCorner"] });
    });
  }

  initHotkeyCapture();
}

// ── The hotkey, recorded rather than typed ───────────────────────────────

/**
 * Click, press a combination, done. Escape cancels; anything without a
 * non-modifier key keeps waiting. The free-text field this replaces clipped
 * its own value and taught its accepted syntax only through the truncation.
 */
function initHotkeyCapture(): void {
  const button = el<HTMLButtonElement>("#setting-hotkey");

  const stop = (recorded?: string): void => {
    button.classList.remove("stg__hotkey--recording");
    document.removeEventListener("keydown", onKey, true);
    fill();
    if (recorded !== undefined) void save({ hotkey: recorded });
  };

  const onKey = (event: KeyboardEvent): void => {
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") {
      stop();
      return;
    }
    // A combination needs a real key under the modifiers.
    if (["Control", "Shift", "Alt", "Meta"].includes(event.key)) return;

    const parts: string[] = [];
    if (event.ctrlKey || event.metaKey) parts.push("CommandOrControl");
    if (event.shiftKey) parts.push("Shift");
    if (event.altKey) parts.push("Alt");
    parts.push(event.key.length === 1 ? event.key.toUpperCase() : event.key);
    stop(parts.join("+"));
  };

  button.addEventListener("click", () => {
    button.classList.add("stg__hotkey--recording");
    button.textContent = "Press keys…";
    document.addEventListener("keydown", onKey, true);
  });
}

// ── Capturing: the real watch list ───────────────────────────────────────

/** The engine answers "still starting" while it comes up; keep asking. */
const WATCH_WAIT: Wait = {
  attempts: 120,
  everyMs: 500,
  transient: (error) => String(error).includes("still starting"),
};

/** What the last render saw watched — the add flow's duplicate check. */
let watchedNow: string[] = [];

/**
 * Swap a row's content for a one-line question with two buttons — themed and
 * in place, because a native confirm cannot be themed and a modal for a
 * one-row decision is a heavier interruption than the decision.
 */
function askInRow(item: HTMLElement, question: string, act: string, onYes: () => void): void {
  item.replaceChildren();
  item.classList.add("stg__watchitem--asking");
  const ask = document.createElement("span");
  ask.className = "stg__watchpath";
  ask.textContent = question;
  const yes = document.createElement("button");
  yes.type = "button";
  yes.className = "stg__button";
  yes.textContent = act;
  yes.addEventListener("click", onYes);
  const no = document.createElement("button");
  no.type = "button";
  no.className = "stg__button";
  no.textContent = "Cancel";
  // Re-rendering is the undo: the row goes back to what the store says.
  no.addEventListener("click", () => showWatchList());
  item.append(ask, yes, no);
}

/** A watched-folder row: the path, and a × that asks before it stops. */
function watchRow(dir: string, down: boolean): HTMLLIElement {
  const item = document.createElement("li");
  item.className = down ? "stg__watchitem stg__watchitem--down" : "stg__watchitem";
  const path = document.createElement("span");
  path.className = "stg__watchpath";
  path.textContent = dir;
  // An added folder is watched with everything inside it; the tip is where
  // that depth is said, per row, without spending a column on it.
  const deep = currentSettings().watchAdded.includes(dir)
    ? `${dir}\nWatched with everything inside it.`
    : dir;
  path.dataset["tip"] = down
    ? `${dir}\nNot currently watched — the folder may not exist on this machine.`
    : deep;
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "stg__watchremove";
  remove.textContent = "×";
  remove.setAttribute("aria-label", `Stop watching ${dir}`);
  remove.dataset["tip"] = "Stop watching this folder";
  remove.addEventListener("click", () => {
    askInRow(item, "Stop watching this folder? Files are never touched.", "Stop", () => {
      const current = currentSettings();
      // An added folder is un-added; a stock folder goes on the removed
      // list, which is what Restore defaults clears.
      const patch: Partial<Settings> = current.watchAdded.includes(dir)
        ? { watchAdded: current.watchAdded.filter((kept) => kept !== dir) }
        : { watchRemoved: [...current.watchRemoved, dir] };
      void save(patch).then(() => refreshWatchListSoon());
    });
  });
  item.append(path, remove);
  return item;
}

function showWatchList(): void {
  const list = el<HTMLElement>("#watch-list");
  void until(() => watchStateNow(), WATCH_WAIT)
    .then(({ dirs, clipboard }) => {
      watchedNow = dirs;
      list.replaceChildren();
      for (const dir of dirs) list.append(watchRow(dir, false));
      // Added folders the engine is not actually watching — chosen on another
      // machine this file roamed from, or deleted from disk since. Shown down
      // rather than hidden, so they can still be un-added from here.
      for (const extra of currentSettings().watchAdded) {
        if (!dirs.includes(extra)) list.append(watchRow(extra, true));
      }
      const clip = document.createElement("li");
      clip.className = clipboard ? "stg__watchitem" : "stg__watchitem stg__watchitem--down";
      clip.textContent = clipboard
        ? "The clipboard (Win+Shift+S and ⌘⌃⇧4)"
        : "The clipboard watcher is not running — see the log";
      list.append(clip);
      if (dirs.length === 0) {
        const none = document.createElement("li");
        none.className = "stg__watchitem stg__watchitem--down";
        none.textContent = "No folders are being watched — see the log";
        list.prepend(none);
      }
    })
    .catch(() => {
      list.replaceChildren();
      const dead = document.createElement("li");
      dead.className = "stg__watchitem stg__watchitem--down";
      dead.textContent = "The catch engine could not be reached.";
      list.append(dead);
    });
}

/**
 * Once now for the stored truth, once again after the watchers had time to
 * follow it — `set_settings` hands the rewatch to a worker, so the engine's
 * answer can trail the store by a beat.
 */
function refreshWatchListSoon(): void {
  showWatchList();
  window.setTimeout(showWatchList, 700);
}

function initWatchControls(): void {
  const list = el<HTMLElement>("#watch-list");

  el<HTMLButtonElement>("#watch-add").addEventListener("click", () => {
    void chooseWatchFolder()
      .then((chosen) => {
        // Closing the picker is the answer, not an error.
        if (chosen === null) return;
        if (watchedNow.includes(chosen) || currentSettings().watchAdded.includes(chosen)) {
          note().textContent = "That folder is already being watched.";
          return;
        }
        // Picked is not yet chosen: the row asks once more before anything
        // is saved or watched.
        const item = document.createElement("li");
        item.className = "stg__watchitem";
        list.append(item);
        askInRow(item, `Watch ${chosen}?`, "Watch", () => {
          void save({ watchAdded: [...currentSettings().watchAdded, chosen] }).then(() =>
            refreshWatchListSoon(),
          );
        });
      })
      .catch((error: unknown) => {
        console.error("[shotshelf] the folder picker failed", error);
        note().textContent = "The folder picker could not be opened.";
      });
  });

  el<HTMLButtonElement>("#watch-restore").addEventListener("click", () => {
    if (currentSettings().watchRemoved.length === 0) return;
    const item = document.createElement("li");
    item.className = "stg__watchitem";
    list.append(item);
    askInRow(item, "Bring back the stock folders? Folders you added stay.", "Restore", () => {
      void save({ watchRemoved: [] }).then(() => refreshWatchListSoon());
    });
  });
}

// ── About ────────────────────────────────────────────────────────────────

function initAbout(): void {
  el<HTMLElement>("#about-version").textContent = `v${__APP_VERSION__}`;

  const check = el<HTMLButtonElement>("#about-check");
  const answer = el<HTMLElement>("#update-answer");
  check.addEventListener("click", () => {
    check.disabled = true;
    answer.textContent = "Asking the release feed…";
    void checkForUpdatesNow()
      .then((sentence) => {
        answer.textContent = sentence;
      })
      .catch((error: unknown) => {
        answer.textContent = error instanceof Error ? error.message : String(error);
      })
      .finally(() => {
        check.disabled = false;
      });
  });

  // Through a named allowlisted command, never a raw URL from the webview.
  for (const anchor of document.querySelectorAll<HTMLAnchorElement>(".stg a[href]")) {
    anchor.addEventListener("click", (event) => {
      event.preventDefault();
      const which = anchor.href.includes("USAGE")
        ? "usage"
        : anchor.href.includes("issues")
          ? "issues"
          : "repo";
      void openLink(which).catch((error: unknown) => {
        console.error("[shotshelf] could not open the link", error);
      });
    });
  }
}

// ── Boot ─────────────────────────────────────────────────────────────────

initNav();
bindControls();
initAbout();
initTooltips();
initWatchControls();
// After bindControls: the themed dropdowns re-dispatch `change` on the real
// selects, so the save handlers must already be listening.
enhanceSelect(el<HTMLSelectElement>("#setting-retention"));
enhanceSelect(el<HTMLSelectElement>("#setting-monitor"));
enhanceSelect(el<HTMLSelectElement>("#setting-theme"));

// A save from any window — including this one — refreshes the form with what
// was actually stored. The registration promise is watched: a window that
// silently stops tracking the store shows stale settings forever.
//
// The watch list re-renders only when the watch *lists* moved: it holds
// in-flight confirmation rows, and a theme click elsewhere must not sweep a
// question off the screen mid-answer.
let watchListsSeen = JSON.stringify([currentSettings().watchAdded, currentSettings().watchRemoved]);
void onSettingsChanged((settings) => {
  fill();
  const watchListsNow = JSON.stringify([settings.watchAdded, settings.watchRemoved]);
  if (watchListsNow !== watchListsSeen) {
    watchListsSeen = watchListsNow;
    refreshWatchListSoon();
  }
}).catch((error: unknown) => {
  console.error("[shotshelf] settings subscription failed", error);
  note().textContent = "This window may not notice changes made elsewhere.";
});

void loadSettings()
  .then(() => fill())
  .catch((error: unknown) => {
    console.error("[shotshelf] could not load settings", error);
    note().textContent = "Settings could not be loaded — showing defaults.";
    fill();
  });

showWatchList();
