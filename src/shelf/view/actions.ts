/**
 * The controls that appear on a card when you hover it.
 *
 * Pin, copy and remove. They earn their space only on hover because the
 * picture is the card's identity — chrome on every tile all the time is what
 * made the first shelf unreadable.
 */

import { icon } from "../../icons.ts";

/** How long the copy button confirms itself. */
const COPIED_MS = 1100;

/**
 * What a tile needs the shelf to do on its behalf.
 *
 * Everything a control does goes through here, including the copy — which
 * used to call `copyCapture` from this file directly. That left the shelf with
 * two copy implementations reporting failure two different ways: this one
 * flashed the button red and logged, while the same copy from Enter raised the
 * alert strip, for an interface the docs present as equivalent. `onProblem`
 * even documents the opposite. The button still flashes, because immediate
 * feedback on the control you pressed is a view concern — but there is one
 * copy, and it fails one way.
 */
export interface TileHandlers {
  togglePin(id: string): void;
  remove(id: string): void;
  /**
   * The one action that touches the file itself: delete it from its origin
   * folder too, behind the undo toast. Distinct from [`TileHandlers::remove`]
   * on purpose — that one never touches files, and still does not.
   */
  deleteForever(id: string): void;
  copy(id: string): Promise<void>;
  /** Show the capture's real file in the OS file manager. */
  reveal(id: string): Promise<void>;
}

function pinLabel(pinned: boolean): string {
  // Not "past the retention window": `retentionHours` defaults to `null` and
  // `ShelfStore.sweep` returns immediately when it is, so on a default install
  // the tooltip named the one effect pinning does *not* have while omitting the
  // two it always does — exemption from the item cap, and surviving a restart.
  //
  // The accelerator is named in every control tooltip — the Undo button set
  // the precedent, and a keyboard map taught only in a file on GitHub is a
  // keyboard map most users never learn exists.
  return pinned
    ? "Pinned — kept until you unpin it (P)"
    : "Pin to keep this capture, and bring it back next launch (P)";
}

function action(name: Parameters<typeof icon>[0], title: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.className = "tile__action";
  button.type = "button";
  button.dataset["tip"] = title;
  // The name a screen reader announces. The icon is `aria-hidden` and the
  // themed tip is presentation only — the name has to live somewhere real.
  button.setAttribute("aria-label", title);
  button.append(icon(name, 14));
  return button;
}

function flash(button: HTMLElement, ok: boolean): void {
  button.classList.add(ok ? "tile__action--ok" : "tile__action--bad");
  window.setTimeout(
    () => button.classList.remove("tile__action--ok", "tile__action--bad"),
    COPIED_MS,
  );
}

/**
 * The class that says "this is the pin control", so nothing has to count.
 *
 * `reflectPin` used to find this button with `querySelector(".tile__action")`
 * — the first of three controls that all carry that class, which is the pin
 * only because `actions()` happens to append it first. Reordering them, an
 * entirely ordinary edit, would have left the star never lighting when you
 * pinned and the *copy* button quietly relabelled "Pinned — kept until you
 * unpin it". Nothing would have failed.
 */
const PIN = "tile__action--pin";

function pinButton(id: string, pinned: boolean, handlers: TileHandlers): HTMLButtonElement {
  const button = action("star", pinLabel(pinned));
  button.classList.add(PIN);
  setPinned(button, pinned);
  button.addEventListener("click", () => handlers.togglePin(id));
  return button;
}

/**
 * How a pin control shows its state — in one place, used on build and on
 * update.
 *
 * The appearance was established twice: once here at build time and once in
 * `reflectPin`, three lines that had to stay in step by hand.
 */
function setPinned(button: HTMLElement, pinned: boolean): void {
  button.classList.toggle("tile__action--on", pinned);
  button.dataset["tip"] = pinLabel(pinned);
  // The announced name follows the state exactly as the tooltip does.
  button.setAttribute("aria-label", pinLabel(pinned));
  button.setAttribute("aria-pressed", String(pinned));
}

/** For the apps that take a paste but refuse a file drop. */
function copyButton(id: string, name: string, handlers: TileHandlers): HTMLButtonElement {
  const button = action("copy", `Copy ${name} to the clipboard (Enter)`);
  // Named, like its two siblings. All three carried one shared class, so
  // anything reaching for a particular control had to count — see `PIN`.
  button.classList.add("tile__action--copy");

  button.addEventListener("click", () => {
    // The shelf reports the failure; this only says which button it was.
    void handlers
      .copy(id)
      .then(() => flash(button, true))
      .catch(() => flash(button, false));
  });

  return button;
}

/**
 * The shelf holds a pointer to a real file, and this is the shortest path to
 * it — every shelf app's most-reached-for control after drag itself. The flash
 * mirrors the copy button's: the shelf reports the failure, the button only
 * says which control it was.
 */
function revealButton(id: string, name: string, handlers: TileHandlers): HTMLButtonElement {
  const button = action("folder", `Show ${name} in its folder (O)`);
  button.classList.add("tile__action--reveal");
  button.addEventListener("click", () => {
    void handlers
      .reveal(id)
      .then(() => flash(button, true))
      .catch(() => flash(button, false));
  });
  return button;
}

/** The file goes too — the tip says so before the click ever lands. */
function deleteButton(id: string, name: string, handlers: TileHandlers): HTMLButtonElement {
  const button = action("trash", `Delete ${name} — removes the file too. Undo has 12 seconds`);
  button.classList.add("tile__action--delete");
  button.addEventListener("click", () => handlers.deleteForever(id));
  return button;
}

function removeButton(id: string, name: string, handlers: TileHandlers): HTMLButtonElement {
  const button = action("close", `Remove ${name} from the shelf — the file stays on disk (Delete)`);
  button.classList.add("tile__action--remove");
  button.addEventListener("click", () => handlers.remove(id));
  return button;
}

export function actions(
  id: string,
  name: string,
  pinned: boolean,
  handlers: TileHandlers,
): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "tile__actions";
  // Pin first (state), then the two hand-it-elsewhere controls, destructive
  // last — the order every platform convention agrees on.
  wrap.append(
    pinButton(id, pinned, handlers),
    copyButton(id, name, handlers),
    revealButton(id, name, handlers),
    removeButton(id, name, handlers),
    // Outermost: the corner grammar puts the most destructive act last, and
    // nothing here destroys more than this.
    deleteButton(id, name, handlers),
  );
  return wrap;
}

/**
 * Keep a card's pin controls in step with the data.
 *
 * Pinning is the one change applied to a live card rather than by rebuilding
 * it: rebuilding on a pin would reload the picture and flicker, for a change
 * that is two class toggles.
 */
export function reflectPin(tile: HTMLElement, pinned: boolean): void {
  tile.classList.toggle("tile--pinned", pinned);
  // By name, not by position.
  const button = tile.querySelector<HTMLButtonElement>(`.${PIN}`);
  if (!button) return;
  setPinned(button, pinned);
}
