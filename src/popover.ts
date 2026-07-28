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

import type { Shelf } from "./shelf/index.ts";

/** How long the shelf stays up after launch, so a running app looks like one. */
const LAUNCH_MS = 4000;

export interface PopoverOptions {
  /**
   * Whether something is mid-flight that must not be interrupted — an OS drag,
   * or the settings panel being open. Checked before the launch appearance
   * puts itself away.
   */
  busy(): boolean;
}

export class Popover {
  readonly #root: HTMLElement;
  readonly #shelf: Shelf;
  readonly #options: PopoverOptions;

  #launchTimer: number | undefined;
  /**
   * Whether the popover is up because you asked for it.
   *
   * Distinct from the render mode: the shelf starts in the browse *shape* for
   * its launch appearance, but nobody asked for it, so a capture arriving then
   * should still pop the column. Conflating the two meant the very first
   * capture never popped.
   */
  #opened = false;

  constructor(root: HTMLElement, shelf: Shelf, options: PopoverOptions) {
    this.#root = root;
    this.#shelf = shelf;
    this.#options = options;
  }

  get opened(): boolean {
    return this.#opened;
  }

  /** Put the column on screen at whatever height its cards need right now. */
  showColumn(): void {
    this.#root.dataset["mode"] = "column";
    void invoke("show_shelf", { focus: false, height: this.#shelf.columnHeight() });
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
  adoptBrowse(): void {
    this.#opened = true;
    this.#root.dataset["mode"] = "browse";
    this.#shelf.setMode("browse");
  }

  /**
   * The window is down, by whatever route — the tray icon, its menu, or the
   * hotkey, none of which pass through here. Front-end state only.
   */
  adoptHidden(): void {
    window.clearTimeout(this.#launchTimer);
    this.#opened = false;
    // Whatever shape it was in, the next capture gets the column.
    this.#shelf.setMode("column");
  }

  /** A capture landed. Either it joins what you are looking at, or it pops. */
  catch(capture: Parameters<Shelf["add"]>[0]): void {
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
    if (this.#opened) return;
    if (this.#shelf.columnIsEmpty) this.dismiss();
    else this.showColumn();
  }

  /** Shown once at launch, then treated exactly like an empty column. */
  scheduleLaunchDismissal(): void {
    this.#launchTimer = window.setTimeout(() => {
      if (!this.#options.busy()) this.dismiss();
    }, LAUNCH_MS);
  }

  /** Focus arriving means you are using it; the launch timer stands down. */
  onFocusChanged(focused: boolean): void {
    this.#shelf.holdColumn("focus", focused);
    if (focused) window.clearTimeout(this.#launchTimer);
  }
}
