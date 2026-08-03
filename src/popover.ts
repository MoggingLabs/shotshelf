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

import { currentSettings } from "./settings.ts";
import { alertHeight, undoHeight } from "./status.ts";

import type { Capture, Shelf } from "./shelf/index.ts";

/**
 * The height the browse shape needs for what it holds, or `null` for "your
 * ceiling" on the empty state.
 *
 * The span of the first-to-last child, not `scrollHeight`: the items box
 * flexes to fill the window, so `scrollHeight` can never report less than the
 * box it is measuring the content *for* — one card read as a full window and
 * the fit was a no-op. The child span carries the day headings and the gaps
 * between groups by construction, and the box's own padding is added back.
 */
function browseContent(bar: HTMLElement, items: HTMLElement): number | null {
  if (items.dataset["empty"] === "true") return null;
  const first = items.firstElementChild;
  const last = items.lastElementChild;
  if (first === null || last === null) return null;
  const style = getComputedStyle(items);
  const padding = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
  // Three cards at a time is the rule, so past three the measurement cuts at
  // the third card's bottom edge — whatever day headings fall among them —
  // and the scroll fade takes it from there. (Today's fixed window never
  // actually fit three whole cards; "three at a time" was the intent, and
  // now it is the measurement.) When the user has dragged their own height,
  // that height is the ceiling instead: send the full span and let Rust cap
  // it, so a tall window shows as many cards as it can actually hold.
  const tiles = items.querySelectorAll(".tile");
  const cutAtThree = currentSettings().browseHeight === null;
  const third = cutAtThree && tiles.length > 3 ? tiles[2] : null;
  const bottom = (third ?? last).getBoundingClientRect().bottom;
  const span = bottom - first.getBoundingClientRect().top;
  return Math.ceil(bar.offsetHeight + span + padding + alertHeight() + undoHeight());
}

/** How long the shelf stays up after launch, so a running app looks like one. */
const LAUNCH_MS = 4000;

export interface PopoverOptions {
  /**
   * Whether something is mid-flight that must not be interrupted — an OS
   * drag, or an open editor or quick look. Checked before the launch
   * appearance puts itself away.
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

  /**
   * Ask Rust to fit the browse window to what it is showing.
   *
   * The browse view fits its content now — one card gets one card's height,
   * two get two — up to the ceiling `tauri.conf.json` declares, past which
   * the list scrolls as it always has. Measured, not derived from card
   * arithmetic: day headings and a wrapped alert line are part of the height,
   * and `alertHeight`'s own docstring is the argument against a constant.
   *
   * `null` is the front end asking for the ceiling: the empty state is the
   * app's teaching surface and keeps the full window on purpose.
   *
   * Does nothing unless the browse shape is actually on screen — a report
   * measured off the column would poison the cache Rust keeps for the next
   * deliberate open.
   */
  resizeBrowse(): void {
    if (!this.#showing || this.#root.dataset["mode"] !== "browse") return;
    const items = this.#root.querySelector<HTMLElement>("#shelf-items");
    const bar = this.#root.querySelector<HTMLElement>(".shelf__bar");
    if (!items || !bar) return;
    void invoke("size_browse", { content: browseContent(bar, items) });
  }

  /**
   * A capture was lost on the way in. Put the window where it can be read.
   *
   * The one deliberate exception to "an alert never resurfaces the shelf", and
   * the distinction is what makes both rules right. That rule was written for
   * *unsolicited* notices — an update is available, a watch folder is missing —
   * and a window that reappears on its own after you dismissed it is the single
   * complaint people have about tray apps. None of that applies here: the user
   * pressed Win+Shift+S a moment ago, the app's ordinary answer to a capture is
   * to pop the column, and this is the same answer for a capture that did not
   * survive. Staying silent is the anomaly.
   *
   * It matters because of *which* capture. `report_problem`'s only caller is a
   * clipboard write that failed, and a clipboard capture has no file anywhere
   * until Shotshelf writes one — so a full disk destroys the only copy that
   * exists. Before this the shelf was hidden by construction at that moment
   * (nothing emitted `capture://new`, so nothing called `showColumn`), `say`
   * wrote into a hidden window, and `resizeColumn` returned at its first guard.
   * The message was unreachable in the only state it could ever be raised in.
   *
   * Nothing to do when the browse view is already up: the strip is on screen
   * there, and switching a deliberate open into the column shape would take the
   * user's grid away to tell them something.
   */
  showProblem(): void {
    if (this.#opened) return;
    // Nor while anything is mid-flight. `showColumn` sets the column shape,
    // and the states `busy()` names — a drag, an open overlay — already have
    // the window up with the strip readable, so there is nothing to raise.
    // (This guard once also protected the in-shelf settings panel from being
    // reshaped off screen; that panel is its own window now.)
    // `#showing` as well as `busy()`: the guard is about not taking something
    // off screen, and there is nothing on screen to take. Without it, any state
    // that leaves `busy()` true while the window is down — which is every state
    // it can be in, since a drag, an overlay and the panel all used to survive
    // a hide — made this message unreachable again.
    if (this.#showing && this.#options.busy()) return;
    // The launch timer no longer owns this window, for the same reason `catch`
    // stood it down: raised at t = 3.9 s, the four-second dismissal took the
    // message away a tenth of a second later — and this is the one message the
    // user cannot afford to miss.
    this.#standDown();
    // The shelf is told, not just the window. `showColumn` sets the column
    // shape and resizes to it; every other route in — `catch` through `note`,
    // and `adoptHidden` — also calls `setMode`, and this one did not. During
    // the launch appearance the shape is browse, so a problem raised in those
    // four seconds resized the window to a strip while `Shelf` went on
    // rendering the full browse list into it: the "full-size content in a
    // column-sized window" failure that `window::preview` and `Shelf.editPicked`
    // both exist to prevent, on a new path.
    this.#shelf.setMode("column");
    this.showColumn();
  }

  /**
   * The strip has gone, and it may have been the only thing on screen.
   *
   * `showProblem` can put up a column with no cards in it, so when the message
   * times out there is a window left holding nothing. Cards ageing out reach
   * `onColumnChange`, which owns "the column is empty, so put it away"; a
   * message timing out reaches nothing, so this is that path.
   *
   * Deliberately narrow — showing, not opened, and no cards — so it can only
   * ever close a window that has nothing left in it.
   */
  dismissIfEmpty(): void {
    if (!this.#showing || this.#opened || !this.#shelf.columnIsEmpty) return;
    // The same two conditions the rest of this file applies, and both were
    // missing when this method was written.
    //
    // The mode, for the reason `onColumnChange` gives ten lines down: `#opened`
    // is false for the whole launch appearance while the shape is *browse* and
    // the column is legitimately empty. So without this, any message at all —
    // the update notice, "no capture folders are being watched", a failed pin —
    // dismissed the shelf twelve seconds later, on the *falling* edge of a
    // strip that had nothing to do with the column.
    //
    // And `busy()`, because that dismissal took an open editor's unsaved marks
    // with it through `adoptHidden`. That is verbatim the failure `resizeColumn`
    // was extracted to prevent, reintroduced on the other edge of one signal.
    //
    // Since the settings panel became its own window, no e2e can hold an
    // *empty* launch appearance open past an alert's twelve seconds — every
    // remaining busy state needs a card, and a card makes `columnIsEmpty`
    // the deciding guard instead. The mode term stays as defence in depth;
    // popover.spec.ts records why it is no longer separately falsifiable.
    if (this.#root.dataset["mode"] !== "column") return;
    if (this.#options.busy()) return;
    this.dismiss();
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
    // `deliberate`, not `true`. `#opened` means "up because you asked for it",
    // and its own docstring gives the consequence of conflating that with the
    // browse *shape*: a capture arriving during the launch appearance is
    // filed into the browse list instead of popping the column, so the very
    // first capture never pops. The launch timer then dismisses the window,
    // and `adoptHidden`'s `setMode("column")` finds an empty queue, so nothing
    // pops afterwards either.
    //
    // Round 21 added the flag that answers this and spent it only on the
    // dismissal timer one line above, leaving the rule stated in a docstring
    // and enforced nowhere.
    this.#opened = deliberate;
    this.#showing = true;
    this.#root.dataset["mode"] = "browse";
    this.#shelf.setMode("browse");
    // Explicitly, not only through the render hook: the shelf boots in the
    // browse mode, so the `setMode` above can be a no-op on the very first
    // open — and that open is exactly the one Rust sized from a cache no
    // report has warmed yet.
    this.resizeBrowse();
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
    // The pick goes with the window. It used to survive — `Selection.clear`
    // had exactly one caller, in `compare` — so a card picked days ago held
    // its ring across every hide, walked down the list as newer captures
    // landed on top, and kept Edit lit for a capture nobody remembered
    // choosing. A popover's selection is as transient as the popover.
    this.#shelf.clearSelection();
    // (The settings panel used to close here too, with a paragraph of
    // history about the session-killing flag it left behind. The panel is
    // its own window now, with the OS's own lifetime — a whole class of
    // open-state bugs retired by making the state real.)
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

    // A capture is a reason for the window to be up in its own right, so the
    // launch timer no longer owns it.
    //
    // Without this a capture landing at t = 3.9 s popped the column and the
    // launch dismissal put it away at t = 4.0 s — a tenth of a second, against
    // the minute both README.md and docs/USAGE.md promise. `#standDown` is
    // reached by a deliberate open and by focus arriving; neither can happen
    // here, because a peeked column is created without focus on purpose.
    this.#standDown();
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

    // And nothing to put away unless the window is *showing the column*.
    //
    // `#opened` is false during the launch appearance — nobody asked for it —
    // but the shape is browse and the column is legitimately empty. Without this
    // check, anything that took a capture off the shelf in those four seconds
    // hid the window: a × on a backfilled card, or a retention change saved
    // in the settings window, whose sweep drops cards mid-look.
    //
    // The guard is the mode rather than `columnIsEmpty` because those are
    // different questions, and answering the second in place of the first is
    // what `resizeColumn` was extracted to avoid one method above.
    if (this.#root.dataset["mode"] !== "column") return;

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
