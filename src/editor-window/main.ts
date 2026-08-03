/**
 * The editor window's page: boot, keys, and the window's own lifecycle.
 *
 * The same shape as `src/settings-window/main.ts` — a second page under the
 * same stylesheet, the same theme, the same store — and deliberately thin. The
 * editor itself lives in `src/editor/`, which knows nothing about windows;
 * this file is the part that does.
 *
 * It owns no `invoke`: everything into Rust goes through
 * `src/editor-window/bridge.ts`, which is the file `check-commands.mjs`
 * allow-lists for this window, exactly as `src/settings.ts` is for the
 * settings window.
 */

import { listen } from "@tauri-apps/api/event";

import {
  openCapture,
  requestClose,
  saveEditedCapture,
  setPanning,
  undoEdit,
  zoomBy,
  zoomTo,
  zoomToFit,
} from "../editor/index.ts";
import { editTarget, hideEditor } from "./bridge.ts";
import { currentSettings, loadSettings, onSettingsChanged } from "../settings.ts";
import { applyTheme } from "../theme.ts";
import { initTooltips } from "../ui/tooltip.ts";
import { el } from "../dom.ts";
import { ZOOM_STEP } from "../editor/view.ts";

const root = (): HTMLElement => el<HTMLElement>("#editor-root");
const note = (): HTMLElement => el<HTMLElement>("#editor-note");

/**
 * What the editor tells this window.
 *
 * `done` hides rather than closes, matching the settings window: the editor is
 * a *declared* window, so it exists exactly once for the life of the app and
 * hiding it makes the next open instant. Destroying it would make it
 * unreachable until restart.
 */
const shell = {
  failed(message: string): void {
    note().textContent = message;
  },
  done(): void {
    note().textContent = "";
    void hideEditor().catch((error: unknown) => {
      console.error("[shotshelf] the editor window could not be hidden", error);
    });
  },
};

/** Open, or resume, whatever Rust says this window is for. */
function show(path: string | null): void {
  if (!path) return;
  note().textContent = "";
  void openCapture(path, root(), shell).catch((error: unknown) => {
    console.error("[shotshelf] the editor could not open that capture", error);
    shell.failed("That capture could not be opened for editing.");
  });
}

// Two ways in, and both are needed.
//
// This window is declared-and-hidden, so its webview has been alive since
// launch and an `editor://open` emitted before this listener attached would be
// lost — which is exactly what the very first open looks like. So the target
// is *read* at boot as well as *announced* on every open. Rust holds it; the
// two paths funnel into the same call, and asking for the capture already on
// screen is defined as a resume, so they cannot fight.
//
// A page that WebView2 reloads after a renderer crash takes the boot path
// again and comes back showing the right capture, which an event-only design
// could not do at all.
void listen<string>("editor://open", ({ payload }) => show(payload)).catch((error: unknown) => {
  console.error("[shotshelf] the editor is not listening for captures", error);
  shell.failed("This window may not notice the next capture you ask to edit. Restarting will fix it.");
});

// The window's X. Rust always refuses the close and asks here, because only
// this side knows whether there are unsaved marks — and a second press inside
// four seconds hides regardless, so the button still works if this page is
// wedged. See `window::note_editor_close`.
//
// Deliberately *not* Tauri's own `tauri://close-requested` through
// `getCurrentWindow().onCloseRequested`: that helper destroys the window when
// the handler does not call `preventDefault`, and one missed call on an error
// path would take a declared window out of the app permanently.
void listen("editor://close-requested", () => requestClose()).catch((error: unknown) => {
  console.error("[shotshelf] the editor is not listening for close requests", error);
});

void editTarget()
  .then((path) => show(path))
  .catch((error: unknown) => {
    console.error("[shotshelf] the editor could not ask what it is for", error);
    shell.failed("This window could not find out which capture to open.");
  });

// ── Keys ─────────────────────────────────────────────────────────────────

document.addEventListener("keydown", (event) => {
  // Whatever has focus gets Enter and Space first. The shelf learned this the
  // hard way — tabbing to a button and pressing Enter ran the global handler
  // instead of the button — and this window has six toolbar buttons and a
  // Space that pans, so the same carve-out is mandatory here.
  const focused = document.activeElement;
  const onControl = focused instanceof HTMLElement && focused.closest("button") !== null;

  if (event.key === " " && !onControl) {
    // Space pans while held. `repeat` is ignored so holding it does not churn.
    if (!event.repeat) setPanning(true);
    event.preventDefault();
    return;
  }

  // Folded, so Shift or CapsLock cannot put a key out of reach — a bug this
  // app has already shipped once, on the shelf's own `e`.
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;

  switch (key) {
    case "escape":
    case "Escape":
      requestClose();
      return;
    case "z":
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      if (!undoEdit()) note().textContent = "Nothing to undo.";
      return;
    case "s":
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      saveEditedCapture();
      return;
    case "+":
    case "=":
      event.preventDefault();
      zoomBy(ZOOM_STEP);
      return;
    case "-":
      event.preventDefault();
      zoomBy(1 / ZOOM_STEP);
      return;
    case "1":
      event.preventDefault();
      zoomTo(1);
      return;
    case "0":
      event.preventDefault();
      zoomToFit();
      return;
    default:
      return;
  }
});

document.addEventListener("keyup", (event) => {
  if (event.key === " ") setPanning(false);
});

// A window that loses focus mid-pan never sees the keyup, and would come back
// still in pan mode with nothing holding the key down.
window.addEventListener("blur", () => setPanning(false));

// ── Boot ─────────────────────────────────────────────────────────────────

initTooltips();

void loadSettings()
  .then(() => applyTheme(currentSettings().theme))
  .catch((error: unknown) => {
    console.error("[shotshelf] the editor could not load settings", error);
    applyTheme(currentSettings().theme);
  });

void onSettingsChanged((settings) => applyTheme(settings.theme)).catch((error: unknown) => {
  console.error("[shotshelf] editor settings subscription failed", error);
});
