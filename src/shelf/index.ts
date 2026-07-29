/**
 * The shelf, assembled.
 *
 * Mostly wiring: the store holds captures, the column queue holds what has just
 * landed, the view turns either into DOM, and this class is the only thing that
 * knows about all three.
 *
 * It is not *only* wiring, and the header used to claim it was. What is decided
 * here is the handful of rules that need two of those collaborators at once and
 * cannot be stated without both — what a modifier key means for a selection,
 * which captures a drag from a given card carries, what "the next one down"
 * means, and when a comparison is offered. Those are gated through the browser
 * suite, which is the only place they are reachable.
 *
 * Rules that need *neither* the DOM nor the store belong in the pure modules
 * and are tested without a browser — `selection.ts` for what a selection is and
 * the order it hands over in, `store.ts` for what the shelf keeps, `column.ts`
 * for what ages out, `geometry.ts` for how tall the column is. `inHandoverOrder`
 * moved there for exactly that reason: a comparison depends on it, and here it
 * could only be reached by driving a browser.
 *
 * The one invariant worth stating out loud: `#release` is the single way a
 * capture leaves. All three routes out — the ×, the item cap, and the retention
 * sweep —
 * have to forget the card and clean up a recording's cached poster frame, and
 * when that cleanup lived in one caller instead of here, every recording that
 * aged out leaked its frame forever.
 */

import {
  closeEditor,
  discardEditor,
  editorIsOpen,
  openEditor,
  undoEdit,
} from "../editor/index.ts";
import { persistPinned, type Settings } from "../settings.ts";
import {
  browseShelf,
  compareCaptures,
  copyCapture,
  forgetVideo,
  setCaptureCount,
} from "./bridge.ts";
import { ColumnQueue, type HoldReason } from "./column.ts";
import { armDrag, beginDrag } from "./drag.ts";
import { columnHeight } from "./geometry.ts";
import { alertHeight } from "../status.ts";
import { inHandoverOrder, Selection } from "./selection.ts";
import { ShelfStore } from "./store.ts";
import { canCompare, type Capture, captureId, isEditable, type ShelfItem } from "./types.ts";
import { ShelfView } from "./view/index.ts";
import {
  discardPreview,
  hidePreview,
  previewedId,
  previewIsOpen,
  showPreview,
} from "./view/preview.ts";

export type { Capture } from "./types.ts";

/** Which shape the popover is currently in. */
export type Mode = "browse" | "column";

/** How often expired captures are swept off the shelf. */
const SWEEP_MS = 15_000;
/** How often the column checks whether a card's minute is up. */
const COLUMN_TICK_MS = 1000;

export interface ShelfOptions {
  /**
   * Fired when the auto-popup column gains or loses a card, so the window can
   * be resized or put away.
   *
   * A callback rather than a poll: the column is empty almost all the time,
   * and a timer asking "anything to do?" every second forever is exactly what
   * a 24/7 tray app should not have.
   */
  onColumnChange(): void;
  /**
   * How many captures are picked out.
   *
   * Reported rather than exposed, so the control that acts on a selection can
   * show itself without anything outside the shelf holding selection state.
   */
  onSelectionChange(picked: number, editable: boolean, comparable: boolean): void;
  /**
   * Something the user needs telling about.
   *
   * One channel, so the keyboard and the buttons report a failure the same
   * way. They did not: a copy from the copy button flashed the button red and
   * logged, while the same copy from Enter produced an unhandled rejection and
   * nothing on screen — for an interface the docs present as equivalent.
   */
  onProblem(message: string): void;
  /** Current limits. Read on demand so a settings change takes effect at once. */
  limits(): Pick<Settings, "maxItems" | "retentionHours">;
}

export class Shelf {
  readonly #store = new ShelfStore();
  readonly #column = new ColumnQueue();
  readonly #selection = new Selection();
  readonly #view: ShelfView;
  readonly #options: ShelfOptions;

  #mode: Mode = "browse";
  /** True while a comparison is being rendered; a second click must not start another. */
  #comparing = false;
  /** An OS drag steals focus; the popover must not read that as a dismissal. */
  #dragging = false;

  /**
   * Where the editor and quick look mount.
   *
   * Deliberately not the list: the view rebuilds that wholesale on every
   * render, so a capture arriving mid-annotation removed the editor from under
   * the user — silently, with the module still pointing at the detached node
   * and the keyboard still in editor mode.
   */
  readonly #overlay: HTMLElement;

  constructor(
    list: HTMLElement,
    count: HTMLElement,
    overlay: HTMLElement,
    options: ShelfOptions,
  ) {
    this.#options = options;
    this.#overlay = overlay;
    this.#view = new ShelfView(list, count, {
      togglePin: (id) => this.#togglePin(id),
      remove: (id) => this.remove(id),
      copy: (id) => this.copy(id),
      armDrag: (node, item, event) => this.#armDrag(node, item, event),
      pick: (id, event) => this.#pick(id, event),
    });
  }

  // ── State the popover asks about ───────────────────────────────────────

  get dragging(): boolean {
    return this.#dragging;
  }

  get columnIsEmpty(): boolean {
    return this.#column.isEmpty;
  }

  /**
   * Whether the editor or the quick look is on screen, or about to be.
   *
   * "The user is in the middle of something", for every timer that would
   * otherwise put the window away underneath them. There are two such timers —
   * the column's expiry and the launch dismissal — and they each had their own
   * idea of what counts: the column vetoed on a drag in flight, the launch
   * dismissal on a drag or the settings panel, and neither knew about the
   * overlay. Both tore an open editor down and took every unsaved mark with it.
   */
  get overlayOpen(): boolean {
    return editorIsOpen() || previewIsOpen();
  }

  /**
   * Draw every card again from scratch.
   *
   * Called once, when the catch engine reports ready: a capture restored at
   * launch can have rendered before the asset-protocol scope was open, and that
   * failure is permanent — the image `error` handler is `{ once: true }` and the
   * view reuses the node. Cheap, and only on a transition that happens once a
   * session.
   */
  redrawTiles(): void {
    this.#view.forgetTiles();
    this.#refresh();
  }

  /** Window height the column needs for what it is holding. */
  columnHeight(): number {
    return columnHeight(this.#column.size, alertHeight());
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  start(): void {
    this.#refresh();
    // Never cleared: the shelf lives as long as the window does, and the
    // handles were being collected into a field that nothing read.
    window.setInterval(() => this.#sweep(), SWEEP_MS);
    window.setInterval(() => this.#ageColumn(), COLUMN_TICK_MS);
  }

  // ── Captures arriving ──────────────────────────────────────────────────

  /**
   * A capture landed while the shelf was not open. It joins the shelf *and*
   * the column that pops up to show it — different lifetimes on purpose.
   */
  note(capture: Capture): void {
    this.add(capture, { render: false });
    this.#column.add(captureId(capture));
    this.#mode = "column";
    this.#refresh();
  }

  /** Put a capture on the shelf without disturbing whatever is on screen. */
  add(capture: Capture, options: { pinned?: boolean; render?: boolean } = {}): void {
    const added = this.#store.add(capture, { pinned: options.pinned ?? false });
    if (!added) return;

    this.#enforceLimits();
    if (options.render ?? true) this.#refresh();
  }

  /**
   * Offer a capture the launch backfill found, unless the shelf already has it.
   *
   * `ShelfStore.add` de-duplicates on `ts:path`, and the two ways a capture
   * arrives disagree about `ts`: the live watcher stamps when it caught the
   * file, backfill stamps the file's own mtime. So a screenshot taken while
   * Shotshelf was starting up — caught by a watcher that had already registered
   * for its folder, *and* offered by a backfill whose boundary is stamped after
   * the last folder registers — produced two ids and two identical cards.
   *
   * Here rather than in the store, and by path rather than by id, because this
   * is the one place where "already on the shelf" means "the same capture". A
   * *live* re-catch of the same path is a genuine second capture — a tool that
   * overwrites its output — and `store.test.ts` states that rule deliberately.
   * A backfill is a one-shot at launch offering what was there before it, so a
   * path it names that is already showing can only be the capture already
   * showing.
   *
   * The timing cannot be fixed instead: the watchers go live one directory at a
   * time, so a boundary stamped before the first leaves a gap and one stamped
   * after the last allows this overlap. Identity is the half that can be right.
   */
  addFromBackfill(capture: Capture): void {
    if (this.#store.items().some((item) => item.path === capture.path)) return;
    this.add(capture);
  }

  /** Put pinned captures back after a restart, oldest first so order survives. */
  restorePinned(settings: Settings): void {
    for (const capture of [...settings.pinned].sort((a, b) => a.ts - b.ts)) {
      this.add(capture, { pinned: true, render: false });
    }
    this.#refresh();
  }

  /** Re-apply limits when the settings change. */
  applySettings(): void {
    this.#enforceLimits();
    this.#sweep();
    this.#refresh();
  }

  // ── Captures leaving ───────────────────────────────────────────────────

  /**
   * Take a capture off the shelf. The file on disk is deliberately untouched:
   * the shelf is a view of your captures, not their owner.
   */
  remove(id: string): void {
    const removed = this.#store.remove(id);
    if (!removed) return;

    this.#release(removed);
    // Taking a card off the shelf takes it out of the popup column too.
    this.#dropFromColumn(id);
    this.#refresh();
    void this.#savePins();
  }

  /**
   * The single way a capture leaves. All three routes out clean up identically:
   * the ×, the item cap, and the retention sweep — the last being the one the
   * standing requirements care about most, and the one both of these sentences
   * used to omit while saying "both".
   */
  #release(item: ShelfItem): void {
    this.#view.release(item.id);
    // A capture leaving takes its quick look with it. Deleting the picked
    // capture while looking at it left a full-size picture of something the
    // shelf no longer had, with no way to dismiss it but Escape — and the id
    // needed to notice was already being recorded and never read.
    //
    // The *editor* deliberately survives this. Its pixels are in memory and
    // `save_edit` no longer needs the original, so the annotation can still be
    // finished and saved; closing it would throw that work away.
    if (previewedId() === item.id) this.closePreview();
    // The poster frame is ours; the recording is not. Only the cache is cleared.
    if (item.kind === "video") void forgetVideo(item.path);
  }

  /**
   * Take a card out of the popup column, and say so if that emptied it.
   *
   * `onColumnChange` had one call site — inside `#ageColumn`, behind
   * `if (!this.#column.expire()) return;` — and `expire` on an already-empty
   * queue returns `false`. So the three routes that pull a card out directly
   * (the ×, the item cap, the retention sweep) emptied the column and told
   * nobody, and `Popover.dismiss` was never reached.
   *
   * In the peeked column that is unrecoverable: the window is never focused, so
   * Escape cannot reach it, and the title strip carrying the hide button is
   * `display: none` in that shape. Removing the last card left a frameless,
   * always-on-top blank panel the front end could not take down — against the
   * column's own promise that it "empties itself a card at a time and then
   * drops back into the tray".
   */
  #dropFromColumn(id: string): void {
    this.#column.remove(id);
    // Always, not only when the column empties.
    //
    // The `isEmpty` guard made the non-empty branch of `onColumnChange` —
    // which is the only route to `show_shelf` with a height — unreachable from
    // the ×, the item cap and the retention sweep. So removing one card of
    // three left an always-on-top panel a card's worth too tall, opaque and
    // swallowing clicks, with nothing to correct it while the pointer stayed
    // over the window holding the column open.
    //
    // Whether that means resize, dismiss or ignore is the popover's decision,
    // and it now has the shape check it needs to make it.
    this.#options.onColumnChange();
  }

  /** `true` if anything was evicted, which is the caller's cue to refresh. */
  #enforceLimits(): boolean {
    let evictedAny = false;
    for (const evicted of this.#store.trim(this.#options.limits().maxItems)) {
      this.#release(evicted);
      this.#dropFromColumn(evicted.id);
      evictedAny = true;
    }
    return evictedAny;
  }

  /**
   * Retention only ever takes captures off the shelf. The files stay exactly
   * where the OS wrote them.
   */
  #sweep(): void {
    const evicted = this.#store.sweep(this.#options.limits().retentionHours);
    if (evicted.length === 0) return;

    for (const item of evicted) {
      this.#release(item);
      this.#dropFromColumn(item.id);
    }
    this.#refresh();
  }

  // ── The auto-popup column ──────────────────────────────────────────────

  setMode(next: Mode): void {
    if (this.#mode === next) return;
    this.#mode = next;
    if (next === "browse") this.#column.clear();
    this.#refresh();
  }

  /**
   * Hovering or focusing the column stops its cards ageing out under you.
   *
   * The reason is named because both happen at once and stop independently:
   * with a single flag, the pointer leaving a focused window released a hold
   * that focus still wanted.
   */
  holdColumn(reason: HoldReason, held: boolean): void {
    this.#column.hold(reason, held);
  }

  /**
   * Let go of the column entirely.
   *
   * Used when the events that would have released each hold cannot arrive —
   * the window has been hidden, or a native drag has taken the pointer away
   * from the webview. Without it a hold leaks and the column never ages again.
   */
  releaseColumn(): void {
    this.#column.releaseAll();
  }

  #ageColumn(): void {
    // An OS drag and an open overlay are both "the user is in the middle of
    // something"; ageing the column out from under either ends with the window
    // dismissed. `#dragging` was here from the start and the overlay was not,
    // so a column that emptied while you were annotating tore the editor down
    // and took every unsaved mark with it — silently, on a timer, with the
    // window disappearing at the same moment.
    //
    // Belt to the braces in `window::preview`, which now puts the shelf into
    // the browse shape so this cannot be reached with an overlay open at all.
    // Two independent reasons for the same rule, because losing someone's work
    // is not a failure worth being clever about.
    if (this.#mode !== "column" || this.#dragging) return;
    if (this.overlayOpen) return;
    if (!this.#column.expire()) return;

    this.#refresh();
    this.#options.onColumnChange();
  }

  // ── Picking captures out ───────────────────────────────────────────────

  /**
   * A press landed on a card. Modifier keys mean what they mean everywhere:
   * plain picks one, ctrl/cmd adds or removes, shift extends a range.
   *
   * Picking happens on press rather than on click so that a drag starting from
   * an already-picked card carries the whole selection — waiting for the click
   * would mean the drag had already begun with the wrong set.
   */
  #pick(id: string, event: PointerEvent): void {
    if (event.shiftKey) this.#selection.extendTo(id, this.#visibleIds());
    else if (event.ctrlKey || event.metaKey) this.#selection.toggle(id);
    // Pressing an already-picked card keeps the selection, so a multi-drag can
    // start from any card in it.
    else if (!this.#selection.has(id)) this.#selection.only(id);

    this.#reflectSelection();
  }

  #reflectSelection(): void {
    this.#view.reflectSelection(new Set(this.#selection.ids()));
    const picked = this.#pickedItems();
    // Editability is reported alongside the count because the count alone
    // cannot answer it: one picked *recording* showed the Edit control, and
    // pressing it did nothing at all and said nothing either.
    this.#options.onSelectionChange(
      picked.length,
      picked.length === 1 && picked[0] !== undefined && isEditable(picked[0]),
      // Comparability for the same reason editability is here: the count alone
      // cannot answer it, and two picked recordings offered a control that
      // could only fail.
      canCompare(picked),
    );
  }

  /**
   * The captures in the order they are **on screen**, which is what the arrows
   * and shift-ranges walk.
   *
   * Browse mode renders day groups, newest day first — so the DOM order is
   * `groupByDay(items)` flattened, not `items`. This returned the raw store
   * order, and the two only agree when captures happen to be added in the same
   * order they were taken.
   *
   * They routinely are not, and `groupByDay`'s own docstring says why: "the
   * shelf is ordered by when captures were *added*, not by when they were
   * taken: a pin restored at startup can be a week older than the capture
   * after it." Restoring a pin does exactly that, and it races the backfill at
   * launch — so with no user action at all, the first ArrowDown could land on
   * the second card on screen, and a shift-range could select a set that is
   * not contiguous in the list the user is looking at.
   *
   * Both callers document the behaviour this now has: `moveSelection` says
   * "follow the order you can see", and `#pick` passes this to `extendTo`,
   * whose parameter is named for "the order the shelf is showing".
   */
  #visibleIds(): string[] {
    // Whatever the last render drew, in that order — for **both** modes.
    //
    // This derived browse order itself: first as `store.items()`, which was
    // simply the wrong order, then as `groupByDay(store.items())`, the right
    // one computed a second time. A first fix asked the view for browse and
    // left the column re-deriving its own — the same two-places-one-rule shape,
    // one branch down. The view is the authority for both, because the view is
    // what put them there.
    return [...this.#view.visibleOrder()];
  }

  /** The picked captures, oldest first. */
  #pickedItems(): ShelfItem[] {
    // The ordering rule itself lives in `selection.ts`, where it is pure and
    // testable without a browser — see `inHandoverOrder`.
    return inHandoverOrder(
      this.#selection
        .ids()
        .map((id) => this.#store.find(id))
        .filter((picked): picked is ShelfItem => picked !== undefined),
    );
  }

  /** The captures a drag from `item` should carry. */
  #dragSet(item: ShelfItem): ShelfItem[] {
    if (!this.#selection.has(item.id)) return [item];
    return this.#pickedItems();
  }

  /**
   * Put the two picked captures side by side, with what changed outlined.
   *
   * The **older** capture is the before — see `#pickedItems`, which is the
   * single ordering every consumer of a selection uses.
   *
   * The result is a new capture on the shelf rather than a file written back
   * over either input.
   */
  async compare(): Promise<void> {
    if (this.#comparing) return;

    const picked = this.#pickedItems();
    const [before, after] = picked;
    // The same rule the button uses, applied again here. Not belt-and-braces
    // for its own sake: the keyboard path reaches this without going near the
    // button, so a count check alone would still let two recordings through.
    if (!before || !after || !canCompare(picked)) return;

    // Guarded because the button stays on screen for the length of a
    // full-resolution decode of two captures, and a second click would run a
    // second comparison and write a second file nobody asked for.
    this.#comparing = true;
    try {
      const path = await compareCaptures(before.path, after.path);
      this.#selection.clear();
      this.#reflectSelection();
      // Dated now rather than from either input: it is a capture made now.
      this.add({ path, kind: "image", ts: Date.now() });
    } finally {
      this.#comparing = false;
    }
  }

  // ── Quick look and the keyboard ────────────────────────────────────────

  /**
   * Mark up the picked capture.
   *
   * Opens on the same window the preview uses — annotating is looking at a
   * capture closely and then pointing at part of it, which is one view at two
   * intensities rather than two windows.
   */
  editPicked(): void {
    // Every reason not to open is checked *before* the quick look is torn
    // down. `discardPreview` deliberately does not give the window back, so
    // tearing down first and bailing afterwards stranded an always-on-top
    // window at preview size with the browse list inside it — the exact
    // symptom the editor's own restore was added to fix, on a path that
    // predated it.
    const [item] = this.#pickedItems();
    if (!item) return;
    if (!isEditable(item)) {
      // The control should not be offered at all, and is not; this is the
      // keyboard path, where `e` reaches whatever happens to be picked.
      this.#options.onProblem("A recording cannot be marked up.");
      return;
    }

    // Torn down rather than closed: closing gives the window back to the
    // browse shape, and the editor is about to ask for a large one — the user
    // would watch it shrink and grow again for no reason.
    discardPreview();

    void openEditor(item, this.#overlay, {
      saved: (path) => {
        // An edit is a capture in its own right, dated now.
        this.add({ path, kind: "image", ts: Date.now() });
      },
      failed: (message) => this.#options.onProblem(message),
    })
      // Before the settlement below, not after it, and this ordering is the
      // whole point. `openEditor` can reject — `Overlay.show` has a `finally`
      // and no `catch`, so anything thrown while building propagates — and a
      // bare `.then` is skipped on rejection. That skipped the restore, which
      // is the one thing that cannot be skipped here: the quick look has
      // already been discarded, the window has already been grown, and
      // nothing else in the app knows it is owed back. The user was left with
      // an always-on-top window at preview size showing the browse list, which
      // is verbatim what the comment below exists to prevent.
      .catch((error: unknown) => {
        console.error("[shotshelf] the editor could not open", error);
        this.#options.onProblem("That capture could not be opened for editing.");
      })
      .then(() => {
        // The editor either mounted or refused. Either way the title-strip
        // controls depend on whether an overlay is up, and this is the moment
        // that answer changed.
        this.#reflectSelection();
        // And if it refused after the quick look was torn down, the window it
        // grew is still large with nothing in it. `discardPreview` above owes
        // no restore by contract, so the debt lands here — the only place that
        // knows a preview was thrown away for an editor that never opened.
        if (!this.overlayOpen) {
          void browseShelf().catch((error: unknown) => {
            console.error("[shotshelf] could not restore the browse window", error);
          });
        }
      });
  }

  get editing(): boolean {
    return editorIsOpen();
  }

  /** Back out of the editor. Returns false if there was nothing to back out of. */
  closeEditor(): boolean {
    const closed = closeEditor();
    if (closed) this.#reflectSelection();
    return closed;
  }

  /** Undo the last mark. Returns false if there was nothing to undo. */
  undoEdit(): boolean {
    return undoEdit();
  }

  /** Close the preview. Returns false if there was nothing to close. */
  closePreview(): boolean {
    const closed = hidePreview();
    if (closed) this.#reflectSelection();
    return closed;
  }

  /**
   * Drop whatever is on the overlay because the window is going away.
   *
   * The overlay was given a lifetime of its own so the list could rebuild
   * underneath it, and then nothing ever ended that lifetime: an editor or a
   * quick look survived the shelf being hidden, and the next capture popped a
   * column with a stale canvas painted across it. That column is never
   * focused, so Escape could not reach the thing covering it either — one
   * hide, and the app's core loop was blind for the rest of the session.
   *
   * Silent by design. The deliberate closes hand the window back to the browse
   * shape; doing that here would re-show a window the user has just dismissed.
   */
  discardOverlay(): void {
    discardEditor();
    discardPreview();
    this.#reflectSelection();
  }

  /**
   * Show the picked capture large, or close the preview if one is open.
   *
   * One key, both directions: a quick look you cannot dismiss with the key
   * that opened it is a modal, and this is meant to be quick.
   */
  togglePreview(): void {
    if (this.closePreview()) return;

    const [item] = this.#pickedItems();
    if (!item) return;

    void showPreview(item, this.#overlay)
      .catch((error: unknown) => {
        console.error("[shotshelf] could not preview that capture", error);
        this.#options.onProblem("That capture could not be opened.");
      })
      // The title-strip controls depend on whether an overlay is up.
      .finally(() => this.#reflectSelection());
  }

  /**
   * Move the selection by one card.
   *
   * Works off what is on screen rather than the store, so the arrows follow
   * the order you can see — which is what "the next one" means to someone
   * looking at it.
   */
  moveSelection(delta: number): void {
    const visible = this.#visibleIds();
    if (visible.length === 0) return;

    // `focus()`, not `ids().at(-1)`: after a range selected upwards those are
    // opposite ends, and the second is not the card the user last touched.
    const current = this.#selection.focus();
    const index = current === undefined ? -1 : visible.indexOf(current);
    // From nothing, the first press lands on the newest — the top of the list
    // — whichever direction it was.
    const next = index === -1 ? 0 : Math.min(Math.max(index + delta, 0), visible.length - 1);

    const id = visible[next];
    if (id === undefined) return;

    this.#selection.only(id);
    this.#reflectSelection();
    this.#view.scrollIntoView(id);
  }

  /** Copy the picked capture, for the keyboard path. */
  copyPicked(): void {
    const [item] = this.#pickedItems();
    if (!item) return;
    void this.copy(item.id).catch(() => {
      // Already reported through `onProblem`; the keyboard has no button to
      // flash, so there is nothing further to do here.
    });
  }

  /**
   * Put one capture on the clipboard.
   *
   * The single copy the shelf has. Both routes in — the tile's button and
   * Enter — land here, so a failure is reported the same way whichever was
   * used, which is what `onProblem` says and did not do. Rejects as well as
   * reporting, so the button that was pressed can show it went wrong.
   */
  async copy(id: string): Promise<void> {
    const item = this.#store.find(id);
    if (!item) return;

    try {
      await copyCapture(item.path, item.kind);
    } catch (error) {
      console.error("[shotshelf] could not copy that capture", error);
      this.#options.onProblem("That capture could not be copied.");
      throw error;
    }
  }

  /** Take the picked captures off the shelf. The files are untouched. */
  removePicked(): void {
    for (const item of this.#pickedItems()) this.remove(item.id);
  }

  // ── Pins ───────────────────────────────────────────────────────────────

  #togglePin(id: string): void {
    const pinned = this.#store.togglePin(id);
    if (pinned === undefined) return;

    this.#view.reflectPin(id, pinned);
    // *Un*pinning is what can evict: the cap counts unpinned captures, so
    // pinning only ever reduces that count and can never push the shelf over.
    // The comment here used to say the opposite, and the code matched the
    // comment — `#enforceLimits` was called without the `#refresh()` its other
    // two callers pair it with. So unpinning at the cap dropped a capture while
    // the header still counted it, the tray badge was never told, and `#order`
    // went on naming a card that had gone, which an arrow key or a shift-range
    // could then select to no effect.
    if (this.#enforceLimits()) this.#refresh();
    void this.#savePins();
  }

  /**
   * Pins are the only shelf state worth surviving a restart, so a failed write
   * is worth saying out loud.
   *
   * Silence here meant the star lit and the pin was gone at the next launch,
   * with the reason only in a console the user cannot see.
   */
  #savePins(): Promise<void> {
    return persistPinned(this.#store.pinned()).catch((error: unknown) => {
      // Reported, not rethrown. Both callers are `void this.#savePins()`, and
      // there is no `unhandledrejection` handler anywhere, so rethrowing made
      // every failed write an unhandled rejection on top of the message —
      // including in the spec that drives this path. `onProblem` has already
      // done what the caller would have done with it.
      //
      // "The pinned list", not "that pin": `remove` saves the list too, so a ×
      // on an unpinned capture reached this and reported a pin nobody touched.
      console.error("[shotshelf] could not save pinned captures", error);
      this.#options.onProblem(
        "The pinned list could not be saved. Pins may not survive a restart.",
      );
    });
  }

  // ── Dragging out ───────────────────────────────────────────────────────

  #armDrag(node: HTMLElement, item: ShelfItem, event: PointerEvent): void {
    armDrag(node, item, event, (target, capture) => {
      this.#dragging = true;
      void beginDrag(
        target,
        this.#dragSet(capture),
        () => {
          this.#dragging = false;
          // The OS had the pointer for the length of the drag, so the webview
          // saw no `pointerleave` and the hover hold is still armed.
          this.#column.hold("pointer", false);
        },
        (message) => this.#options.onProblem(message),
      );
    });
  }

  // ── Rendering ──────────────────────────────────────────────────────────

  /** Redraw whichever view is showing and keep the counts in step with it. */
  #refresh(): void {
    if (this.#mode === "column") this.#view.renderColumn(this.#columnItems());
    else this.#view.renderBrowse(this.#store.items());

    this.#selection.retain(this.#store.items().map((item) => item.id));
    this.#reflectSelection();
    this.#view.setCount(this.#store.size);
    void setCaptureCount(this.#store.size);
  }

  /**
   * The captures the column is showing, in column order.
   *
   * An id in the queue with nothing behind it on the shelf is not an error —
   * a capture can be removed while its card is still popped up — so those are
   * dropped rather than rendered as holes.
   */
  #columnItems(): ShelfItem[] {
    return this.#column
      .ids()
      .map((id) => this.#store.find(id))
      .filter((item): item is ShelfItem => item !== undefined);
  }
}
