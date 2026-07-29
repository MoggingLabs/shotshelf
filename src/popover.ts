/**
 * When the popover is up, and which shape it is in.
 *
 * Two shapes, two rules:
 *
 * * **column** — a capture landed. A narrow strip sized to just the cards it
 *   holds, never focused, that empties itself a card at a time and then drops
 *   back into the tray.
 * * **browse** — you asked for it. The full list, and it stays put while you
 *   work in other windows until you actually close it.
 *
 * The hard-won part is that Rust owns the *window* and this owns the *intent*,
 * and the two must only ever be synced one way at a time. `open()` in Rust
 * emits `shelf://opened`; when the handler for that answered by asking Rust to
 * show the window, it re-entered `open()` on every emit and the popover
 * re-opened itself forever — which made Esc, the hide button and click-away
 * all look broken while each was working perfectly. So the adopt* methods
 * below change front-end state and nothing else.
 */

import { invoke } from "@tauri-apps/api/core";

import type { Capture, Shelf } from "./shelf/index.ts";

/** How long the shelf stays up after launch, so a running app looks like one. */
const LAUNCH_MS = 4000;

export interface PopoverOptions {
  /**
   * Whether something is mid-flight that must not be interrupted — an OS
   * drag, an open editor or quick look, or the settings panel. Checked before
   * the launch appearance puts itself away.
   *
   * The overlay is in that list because the launch timer discarded an editor
   * opened inside its four seconds, marks and all.
   */
  busy(): boolean;
}

export class Popover {
  readonly #root: HTMLElement;
  readonly #shelf: Shelf;
  readonly #options: PopoverOptions;

  #launchTimer: number | undefined;
  /**
   * Whether the shelf is on screen because it just started, rather than because
   * anyone asked.
   *
   * The launch appearance focuses itself and emits `shelf://opened`, and both of
   * those used to be read as "the user asked for this" — so it cancelled its own
   * four-second dismissal and stayed up indefinitely, an always-on-top window
   * nobody had summoned. Cleared by any deliberate open, so a tray click during
   * those four seconds still keeps the shelf where the user put it.
   */
  #launched = false;
  /**
   * Whether the popover is up because you asked for it.
   *
   * Distinct from the render mode: the shelf starts in the browse *shape* for
   * its launch appearance, but nobody asked for it, so a capture arriving then
   * should still pop the column. Conflating the two meant the very first
   * capture never popped.
   */
  #opened = false;
  /**
   * Whether the window is on screen at all, by either shape.
   *
   * Distinct from `#opened`, which is only "up because you asked for it", and
   * from `columnIsEmpty`, which was standing in for this and is not the same
   * question: `adoptHidden` leaves `ColumnQueue` populated — `setMode("column")`
   * is a no-op when the mode is already `"column"` — so a dismissed shelf holding
   * cards satisfied neither of the old guards, and anything that asked for a
   * resize put the window back on screen.
   *
   * Two ordinary routes reached it. The column's own expiry timer keeps ticking
   * after a hide, so a card ageing out took the `else showColumn()` branch; and
   * every `say()` and its twelve-second `hush()` call `resizeColumn`, so the
   * app's own update notice re-showed a window the user had just dismissed from
   * the tray.
   *
   * Set where the window's visibility actually changes, so the two cannot drift.
   */
  #showing = false;

  constructor(root: HTMLElement, shelf: Shelf, options: PopoverOptions) {
    this.#root = root;
    this.#shelf = shelf;
    this.#options = options;
  }

  /** Put the column on screen at whatever height its cards need right now. */
  showColumn(): void {
    this.#showing = true;
    this.#root.dataset["mode"] = "column";
    void invoke("show_shelf", { focus: false, height: this.#shelf.columnHeight() });
  }

  /**
   * The column's contents changed height without a card arriving or leaving.
   *
   * Distinct from `onColumnChange`, and that distinction is the point: that
   * method also owns "the column is empty, so put it away", which is right for
   * a card ageing out and catastrophically wrong here. Routing the alert strip
   * through it meant a message arriving while the column held nothing dismissed
   * the shelf — including, in the editor, one raised *by* the thing the user
   * was doing.
   *
   * Does nothing when the shelf is open or the column is not on screen: there
   * is no column to resize in either case, and `showColumn` would put one there.
   */
  resizeColumn(): void {
    if (!this.#showing || this.#opened || this.#shelf.columnIsEmpty) return;
    this.showColumn();
  }

  /** Ask Rust to put the window away, and drop our own state with it. */
  dismiss(): void {
    this.adoptHidden();
    void invoke("hide_shelf");
  }

  /**
   * Rust has already sized, placed, shown and focused the window by the time
   * this runs — all that is left is to render the right shape. It must not
   * call back into `show_shelf`.
   */
  adoptBrowse(deliberate: boolean): void {
    // The launch timer stands down here too, and this was the one route that
    // did not clear it.
    //
    // `onFocusChanged(true)` covers the usual case, because `window::open`
    // focuses as well as emitting. It does not cover a focus that never
    // *changes*: a window manager that refuses focus-stealing, or opening a
    // window that already had focus. The timer then fired on a shelf the user
    // had deliberately opened — and `dismiss` runs `setMode("column")` after
    // `setMode("browse")` has already emptied the column queue, so every tile
    // disappeared before the window went away.
    //
    // This also decides whether the browser suite is a gate. Five spec files
    // install no clock, so before this they simply had to finish within four
    // seconds of wall clock; the suite failed two runs in four on a reviewer's
    // machine, and CI's single retry is exactly what would have hidden it.
    // Only a *deliberate* open stands the launch dismissal down.
    //
    // `window::open` is the same function for the tray, the hotkey and the
    // launch, and it emits this event and takes focus in every case — so
    // treating either as "the user asked for this" meant the launch appearance
    // cancelled its own timer and stayed up. Rust now says which it was.
    if (deliberate) this.#standDown();
    this.#opened = true;
    this.#showing = true;
    this.#root.dataset["mode"] = "browse";
    this.#shelf.setMode("browse");
  }

  /**
   * Cancel the launch dismissal, whatever armed it.
   *
   * One method rather than three `clearTimeout` calls, because "which routes
   * stand the timer down" is the rule that was wrong — and a rule spread
   * across three call sites is one that can be fixed in two of them.
   */
  #standDown(): void {
    window.clearTimeout(this.#launchTimer);
    this.#launchTimer = undefined;
    this.#launched = false;
  }

  /**
   * The window is down, by whatever route — the tray icon, its menu, or the
   * hotkey, none of which pass through here. Front-end state only.
   */
  adoptHidden(): void {
    this.#standDown();
    this.#opened = false;
    this.#showing = false;
    // The editor and the quick look mount outside the list so the list can
    // rebuild under them; that also means nothing else ends their lifetime.
    // Left standing, they survived the hide and the next capture popped a
    // column with a stale canvas painted across it — and a peeked window never
    // takes focus, so Escape could not reach it to clear it either.
    this.#shelf.discardOverlay();
    // A hidden window stops delivering pointer events, so a `pointerleave`
    // that would have released the hover hold never arrives. Left armed, the
    // column never ages again and the popover stops dismissing itself for the
    // rest of the session. Releasing every hold here is the reconciliation
    // that DOM enter/leave pairs cannot be relied on to provide.
    this.#shelf.releaseColumn();
    // Whatever shape it was in, the next capture gets the column.
    this.#shelf.setMode("column");
  }

  /** A capture landed. Either it joins what you are looking at, or it pops. */
  catch(capture: Capture): void {
    // Open on purpose? Then don't reshape the window under you — just add it.
    if (this.#opened) {
      this.#shelf.add(capture);
      return;
    }

    this.#shelf.note(capture);
    this.showColumn();
  }

  /** A card aged out. Either the column needs to be shorter, or it is done. */
  onColumnChange(): void {
    // Nothing to reshape and nothing to put away if the window is already down.
    // Without this the column's expiry timer — which keeps ticking after a hide,
    // because the mode is still `"column"` — took the `else` branch and showed a
    // window the user had dismissed.
    if (!this.#showing || this.#opened) return;
    if (this.#shelf.columnIsEmpty) this.dismiss();
    else this.showColumn();
  }

  /** Shown once at launch, then treated exactly like an empty column. */
  scheduleLaunchDismissal(): void {
    this.#launched = true;
    this.#launchTimer = window.setTimeout(() => {
      this.#launched = false;
      if (!this.#options.busy()) this.dismiss();
    }, LAUNCH_MS);
  }

  /**
   * Focus arriving means you are using it — unless it arrived on its own.
   *
   * `window::open` calls `set_focus()`, so the launch appearance focuses itself
   * and this fired for it. Standing the timer down there meant the four-second
   * appearance never went away. `#launched` is cleared by any deliberate open,
   * so a tray click two seconds after launch still cancels it properly.
   */
  onFocusChanged(focused: boolean): void {
    this.#shelf.holdColumn("focus", focused);
    if (focused && !this.#launched) this.#standDown();
  }
}
