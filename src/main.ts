/**
 * Wiring, mostly — and the exceptions are named, because `shelf/index.ts`
 * carried the unqualified version of this sentence until it was retracted there
 * for the same reason.
 *
 * Most rules live in a module that can be tested on its own — what the shelf
 * keeps, when the popover is up, what a card looks like — and this file
 * introduces them to each other and to the events coming out of Rust.
 *
 * What it owns outright: the platform sniff that sets `data-os`, the visibility
 * of the Compare and Edit controls, key normalisation for CapsLock, and the
 * catch-engine retry budget with the predicate that reads Rust's "still
 * starting" sentinel. (The settings retry budget is *not* here — `settings.ts`
 * owns that one, and its predicate is deliberately different.) Those are
 * decisions, not wiring, and three of them have had bugs.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { el } from "./dom.ts";
import { icon } from "./icons.ts";
import { Popover } from "./popover.ts";
import { closeSettings, currentSettings, initSettings, settingsOpen } from "./settings.ts";
import { textRecognitionAvailable } from "./shelf/bridge.ts";
import { Shelf, type Capture } from "./shelf/index.ts";
import { until, type Wait } from "./retry.ts";
import {
  noteScanUnavailable,
  noteWatchUnavailable,
  onAlertChange,
  say,
  showWatchState,
  type WatchState,
} from "./status.ts";

// Windows rounds the window through DWM at a fixed 8px, so the panel's own
// radius has to match it there — see `window::round_corners`. The user agent is
// enough to tell the two apart and costs no dependency.
if (navigator.userAgent.includes("Windows")) {
  document.documentElement.dataset["os"] = "windows";
}

const shelfWindow = getCurrentWindow();
const root = el<HTMLElement>(".shelf");

const compareButton = el<HTMLButtonElement>("#shelf-compare");
const editButton = el<HTMLButtonElement>("#shelf-edit");
const settingsButton = el<HTMLButtonElement>("#shelf-settings");
const hideButton = el<HTMLButtonElement>("#shelf-hide");
settingsButton.prepend(icon("settings", 16));
hideButton.prepend(icon("minus", 16));

const shelf = new Shelf(
  el<HTMLElement>("#shelf-items"),
  el<HTMLElement>("#shelf-count"),
  el<HTMLElement>("#shelf-overlay"),
  {
    onColumnChange: () => popover.onColumnChange(),
    // A comparison of one capture, or of five, is not a thing.
    onSelectionChange: (_picked, editable, comparable) => {
      // Hidden while an overlay is up.
      //
      // The overlay deliberately does not cover the title strip — that is the
      // window's only drag handle — so these two stayed live and clickable
      // behind an open editor. One click on Edit discarded every unsaved mark,
      // silently. The keydown handler has guarded this since the editor
      // existed; the click handlers never did.
      const busyOverlay = shelf.overlayOpen;
      // Not `picked !== 2`: two picked *recordings* showed Compare, and
      // pressing it decoded an `.mp4` as an image and reported that the two
      // captures could not be compared — for doing exactly what the button
      // invited. Same shape as the Edit control one line below.
      compareButton.toggleAttribute("hidden", busyOverlay || !comparable);
      // Not `picked !== 1`: a single picked recording has nothing to mark up,
      // and offering the control for it made the button look broken.
      editButton.toggleAttribute("hidden", busyOverlay || !editable);
    },
    onProblem: (message) => say(message),
    limits: () => currentSettings(),
  },
);

const popover = new Popover(root, shelf, {
  // An OS drag steals focus, the settings panel is a deliberate act, and an
  // open editor is someone's unsaved work; a launch appearance must not vanish
  // out from under any of them. The overlay was missing from this list, so the
  // four-second launch timer discarded an editor opened inside it.
  busy: () => shelf.dragging || shelf.overlayOpen || settingsOpen(),
  onHidden: () => {
    closeSettings();
  },
});

shelf.start();
popover.scheduleLaunchDismissal();

// ── Input ────────────────────────────────────────────────────────────────

// Hovering or focusing the column stops its cards ageing out under the pointer.
root.addEventListener("pointerenter", () => shelf.holdColumn("pointer", true));
root.addEventListener("pointerleave", () => shelf.holdColumn("pointer", false));

/**
 * The keyboard path.
 *
 * The shelf is a popover you summon with a hotkey, so reaching for the mouse
 * to act on what it shows undoes the point of summoning it that way.
 *
 * Bound unconditionally, once, for the life of the document — this used to
 * claim it was "only bound when the shelf is genuinely open", which is not what
 * the line below does and would be the wrong shape anyway. What is true is the
 * second half: the auto-popup column is created without focus, so no key event
 * is ever delivered to it, and the guards inside the handler cover the rest.
 * The distinction matters because "not bound" and "bound but never reached"
 * fail differently — the first cannot misfire, the second can, which is why
 * every branch below states its own condition.
 */
document.addEventListener("keydown", (event) => {
  if (event.defaultPrevented) return;
  // Typing a hotkey into the settings panel is not a shelf command.
  if (settingsOpen() && event.key !== "Escape") return;
  // While marking up a capture, the arrows and Delete belong to the editor's
  // own surface, not to the list underneath it.
  // Lower-cased because `key` reports the character produced: with CapsLock
  // on it is "Z" and "E", which fell through every branch below and left undo
  // and the editor unreachable.
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  if (shelf.editing && !["Escape", "z"].includes(key)) return;

  switch (key) {
    case "Escape":
      // Escape backs out one level at a time: the editor, then a preview,
      // then the shelf. One key that closes two things at once is one key
      // that loses your place.
      // Settings is a rung on this ladder, and was missing from it: Escape
      // reached `dismiss()` with the panel still logically open, and every
      // shelf key stayed dead for the rest of the session.
      if (shelf.closeEditor()) return;
      if (closeSettings()) return;
      if (!shelf.closePreview()) popover.dismiss();
      return;

    case "z":
      if (!event.ctrlKey && !event.metaKey) return;
      if (!shelf.editing) return;
      event.preventDefault();
      shelf.undoEdit();
      return;

    case "e":
      if (shelf.editing) return;
      event.preventDefault();
      shelf.editPicked();
      return;

    case "t":
      // The text in the picked capture, onto the clipboard — the OCR the
      // credential scan already runs, finally answering to the keyboard.
      event.preventDefault();
      shelf.copyPickedText();
      return;

    case "p":
      event.preventDefault();
      shelf.togglePinPicked();
      return;

    case "o":
      event.preventDefault();
      shelf.revealPicked();
      return;

    case "ArrowDown":
    case "ArrowUp":
      event.preventDefault();
      shelf.moveSelection(event.key === "ArrowDown" ? 1 : -1);
      return;

    case " ":
      event.preventDefault();
      shelf.togglePreview();
      return;

    case "Enter":
      event.preventDefault();
      shelf.copyPicked();
      return;

    case "Delete":
    case "Backspace":
      event.preventDefault();
      shelf.removePicked();
      return;

    default:
      return;
  }
});

hideButton.addEventListener("click", () => popover.dismiss());

editButton.addEventListener("click", () => shelf.editPicked());

compareButton.addEventListener("click", () => {
  void shelf.compare().catch((error: unknown) => {
    console.error("[shotshelf] could not compare those captures", error);
    say("Those two captures could not be compared.");
  });
});

/**
 * Register a subscription, and say so if the registration itself fails.
 *
 * Every `listen` here returns a promise, and `void`-ing it discarded the one
 * piece of information it carries: whether the app is actually wired to the
 * events it depends on. A rejected registration is silent, permanent, and
 * indistinguishable from "nothing has happened yet" — for `capture://new`
 * that is the whole product not working, with no indication why.
 *
 * The message says what stopped working rather than which channel failed,
 * because the channel name is not something the user can act on. It goes to
 * the console too, where it is.
 */
function subscribe(registration: Promise<unknown>, lost: string): void {
  void registration.catch((error: unknown) => {
    console.error(`[shotshelf] a subscription failed: ${lost}`, error);
    say(lost);
  });
}

// Note what is deliberately absent: nothing dismisses on focus loss. An opened
// popover is sticky by design, and the column is never focused in the first
// place — it is the card timers that end it.
// The alert strip is part of the column's height, so its appearing or going
// away is a resize — without this the message was readable and the card it was
// about was clipped by however tall the message happened to be.
//
// `resizeColumn`, never `onColumnChange`: that one also puts an empty column
// away, so wiring the strip to it made an alert raised while the column held
// nothing dismiss the shelf.
onAlertChange((showing) => {
  popover.resizeColumn();
  // A message can be the only thing on screen — see `Popover.showProblem` — so
  // when it goes, the window it was holding up has to go too.
  if (!showing) popover.dismissIfEmpty();
});

subscribe(
  shelfWindow.onFocusChanged(({ payload: focused }) => popover.onFocusChanged(focused)),
  "Shotshelf may not notice when it loses focus. Restarting should fix it.",
);

if (!import.meta.env.DEV) {
  window.addEventListener("contextmenu", (event) => event.preventDefault());
}

// ── Events out of Rust ───────────────────────────────────────────────────

// A capture that never made it, said out loud.
//
// The catch engine had no channel to the alert strip at all: a clipboard image
// that could not be written went to `shotshelf.log` and nowhere else, and since
// the clipboard copy is the *only* copy, a full disk destroyed the screenshot
// while the user saw nothing but a shelf that did not appear.
//
// Rust composes the sentence, because only Rust knows what failed.
subscribe(
  listen<string>("capture://problem", ({ payload }) => {
    // `say` first: `showProblem` sizes the window to its contents, and the
    // strip is the only content there is.
    say(payload);
    popover.showProblem();
  }),
  "Shotshelf will not be able to tell you when a capture goes missing.",
);

subscribe(
  listen<Capture>("capture://new", ({ payload }) => popover.catch(payload)),
  "New captures will not appear on the shelf. Restarting should fix it.",
);

/**
 * Ask Rust something the catch engine has to be up for, waiting while it is not.
 *
 * The engine starts on a worker — resolving watch folders can take SMB round
 * trips on a redirected profile — while the webview is created *before* Rust's
 * `setup` runs and asks within milliseconds. So both catch commands answer
 * "the catch engine is still starting" for a while, and the difference between
 * that and a real answer is the difference between "ask again" and "your
 * captures are not being watched".
 *
 * A minute, against `settings.ts`'s five seconds: this waits on folder
 * resolution and watch registration over a possibly-remote path, which is a
 * different and slower thing than the file read that one waits on.
 *
 * The caller passes the `invoke` rather than a command name, so the command
 * stays a string literal at its call site — `check-commands.mjs` finds callers
 * by looking for `invoke("…")`, and taking the name here read better and made
 * both catch commands report as having no caller.
 */
const ENGINE_WAIT: Wait = {
  attempts: 120,
  everyMs: 500,
  // Only the one answer that means "not yet". Rust names it
  // `catch::STARTING`; anything else is a real failure and should be reported
  // now rather than in a minute.
  transient: (error) => String(error).includes("still starting"),
};

function whenEngineIsUp<T>(what: string, ask: () => Promise<T>): Promise<T> {
  return until(ask, ENGINE_WAIT).catch((error: unknown) => {
    console.error(`[shotshelf] ${what} never became available`, error);
    throw error instanceof Error ? error : new Error(String(error));
  });
}

// Captures taken while Shotshelf was not running are *pulled*, not pushed.
//
// Rust creates the window and then runs `setup`, so anything emitted there
// fires while this bundle is still loading — and Tauri delivers only to
// registered handlers and buffers nothing. A push-based backfill was a silent
// no-op that the README promised to users.
void whenEngineIsUp("captures from before launch", () => invoke<Capture[]>("catch_backfill"))
  .then((missed) => {
    // Added rather than `catch`ed: these are not new, so they must not pop the
    // column over whatever the user is doing at launch. They are already
    // oldest-first, and each carries the time it was taken.
    for (const capture of missed) shelf.add(capture);
  })
  .catch((error: unknown) => {
    // Its own message, not the listener's: the live path is registered and
    // working, and saying otherwise sends the user after the wrong thing.
    console.error("[shotshelf] could not recover captures from before launch", error);
    say("Captures taken while Shotshelf was closed could not be recovered.");
  });

// Rust shows or hides the window on a tray click, a menu item or the hotkey;
// these only reshape the front-end to match. Neither may call back into Rust.
// The updater asks the feed and reports; it installs nothing. This is the
// whole of what the user sees of it, and without this listener the event was
// emitted into a webview that had never subscribed.
subscribe(
  listen<string>("update://available", ({ payload }) => {
    say(`Shotshelf ${payload} is available.`);
  }),
  "Shotshelf cannot tell you about new versions this session.",
);

// Registered together and reported once: they are two halves of one thing —
// keeping the front-end's idea of the window's shape in step with Rust's —
// and two separate failures would put the same sentence in the strip twice.
subscribe(
  Promise.all([
    listen<boolean>("shelf://opened", ({ payload: deliberate }) => popover.adoptBrowse(deliberate)),
    listen("shelf://hidden", () => popover.adoptHidden()),
  ]),
  "The shelf may not reshape correctly. Restarting should fix it.",
);

// ── Start-up ─────────────────────────────────────────────────────────────

// Settings first: the shelf reads its limits from them, and pinned captures
// have to be back before anything new lands on top.
void initSettings(() => shelf.applySettings())
  .then((settings) => shelf.restorePinned(settings))
  .catch((error: unknown) => {
    console.error("[shotshelf] could not load settings", error);
    say("Settings could not be loaded — running on defaults.");
  });

void whenEngineIsUp("the watch folders", () => invoke<WatchState>("catch_watch_dirs"))
  .then(({ dirs, clipboard }) => {
    showWatchState(dirs, clipboard);
    // The engine is up, so the asset-protocol scope for capture folders is now
    // open. Anything restored before that — pinned captures, which render as
    // soon as `get_settings` answers — may have failed to load against a scope
    // that did not yet include them, and that failure does not retry itself:
    // the image `error` handler is `{ once: true }` and the view reuses the
    // node. One redraw here is the whole fix.
    shelf.redrawTiles();
  })
  .catch((error: unknown) => {
    console.error("[shotshelf] could not read the watch folders", error);
    // The indicator is told too. Only the `.then` used to set it, so the app's
    // total failure left the dot with no state at all and the sole signal was
    // an alert that erases itself after twelve seconds.
    noteWatchUnavailable();
    // Neither watcher is claimed to be running or not running here, because
    // this arm knows nothing about either.
    //
    // It said "folder watching is off", copied from `status.ts`, where the
    // premise holds: there the engine has answered and `started.clipboard` is a
    // fact. Here it has answered nothing. `catch_watch_dirs` fails only with
    // `STARTING`, and `whenEngineIsUp` retries that — so reaching this line
    // means `catch::start` has not finished inside `ENGINE_WAIT` (a minute, as
    // that constant's own comment says), and `started` is its last statement. Either the engine is still before `folders::start`,
    // and *nothing* is being caught while this names only folders; or it is
    // past it, and folder watching is running while this says it is off. There
    // is no state in which the sentence was true.
    say("Shotshelf could not reach its catch engine — captures may not be picked up. See the log.");
  })
  // Its own chain, deliberately. Asking whether captures can be checked for
  // credentials is advisory, and hanging it off the watch-folder call meant a
  // failure here was reported as the catch engine being down — a failure
  // attributed to the wrong subsystem is worse than one reported nowhere.
  .finally(() => {
    void textRecognitionAvailable()
      .then((available) => {
        if (!available) noteScanUnavailable();
      })
      .catch(() => {
        // Nothing to tell the user: not knowing whether checking is available
        // is not itself worth a line in the alert strip.
      });
  });
