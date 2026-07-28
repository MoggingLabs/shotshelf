/**
 * The shelf, assembled.
 *
 * Everything below is wiring: the store holds captures, the column queue holds
 * what has just landed, the view turns either into DOM, and this class is the
 * only thing that knows about all three. Nothing here decides *rules* — those
 * live in the pure modules, where they can be tested without a browser.
 *
 * The one invariant worth stating out loud: `#release` is the single way a
 * capture leaves. Both routes out — the × and falling off the end of a limit —
 * have to forget the card and clean up a recording's cached poster frame, and
 * when that cleanup lived in one caller instead of here, every recording that
 * aged out leaked its frame forever.
 */

import { persistPinned, type Settings } from "../settings.ts";
import {
  compareCaptures,
  copyCapture,
  forgetVideo,
  previewShelf,
  setCaptureCount,
} from "./bridge.ts";
import { ColumnQueue, type HoldReason } from "./column.ts";
import { armDrag, beginDrag } from "./drag.ts";
import { columnHeight } from "./geometry.ts";
import { Selection } from "./selection.ts";
import { ShelfStore } from "./store.ts";
import { type Capture, captureId, type ShelfItem } from "./types.ts";
import { ShelfView } from "./view/index.ts";
import { hidePreview, previewIsOpen, showPreview } from "./view/preview.ts";
import { closeEditor, editorIsOpen, openEditor, undoEdit } from "../editor/index.ts";

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
  onSelectionChange(picked: number): void;
  /** The editor closed, so the window goes back to the browse view. */
  onEditorClosed(): void;
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
  #timers: number[] = [];

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

  /** Window height the column needs for what it is holding. */
  columnHeight(): number {
    return columnHeight(this.#column.size);
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  start(): void {
    this.#refresh();
    this.#timers.push(
      window.setInterval(() => this.#sweep(), SWEEP_MS),
      window.setInterval(() => this.#ageColumn(), COLUMN_TICK_MS),
    );
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
    this.#column.remove(id);
    this.#refresh();
    void this.#savePins();
  }

  /** The single way a capture leaves. Both routes out clean up identically. */
  #release(item: ShelfItem): void {
    this.#view.release(item.id);
    // The poster frame is ours; the recording is not. Only the cache is cleared.
    if (item.kind === "video") void forgetVideo(item.path);
  }

  #enforceLimits(): void {
    for (const evicted of this.#store.trim(this.#options.limits().maxItems)) {
      this.#release(evicted);
      this.#column.remove(evicted.id);
    }
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
      this.#column.remove(item.id);
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
    if (this.#mode !== "column" || this.#dragging) return;
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
    this.#options.onSelectionChange(this.#selection.size);
  }

  /** What the shelf is showing, in the order it is showing it. */
  #visibleIds(): string[] {
    return this.#mode === "column"
      ? this.#columnItems().map((item) => item.id)
      : this.#store.items().map((item) => item.id);
  }

  /**
   * The picked captures, oldest first.
   *
   * One defined order, used by everything that acts on a selection.
   * `Selection.ids()` cannot provide it: a ctrl-click appends, so it yields
   * click order, while a shift-range rebuilds the set in the order the shelf
   * is showing — which is newest-first. Anything reading that order directly
   * therefore handed a before/after pair over backwards for one gesture and
   * correctly for the other, which is a bug that looks like working software.
   *
   * Capture time is the answer under both gestures. The path breaks ties so
   * two captures sharing a millisecond — legal, since identity is `ts:path` —
   * cannot fall back to the ordering this exists to avoid.
   */
  #pickedItems(): ShelfItem[] {
    return this.#selection
      .ids()
      .map((id) => this.#store.find(id))
      .filter((picked): picked is ShelfItem => picked !== undefined)
      .sort((a, b) => a.ts - b.ts || a.path.localeCompare(b.path));
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
    if (!before || !after || picked.length !== 2) return;

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
    this.closePreview();
    const [item] = this.#pickedItems();
    if (!item) return;

    void openEditor(item, this.#overlay, {
      size: (aspect) => previewShelf(aspect),
      saved: (path) => {
        // An edit is a capture in its own right, dated now.
        this.add({ path, kind: "image", ts: Date.now() });
      },
      closed: () => this.#options.onEditorClosed(),
      failed: (message) => this.#options.onProblem(message),
    });
  }

  get editing(): boolean {
    return editorIsOpen();
  }

  /** Back out of the editor. Returns false if it was not open. */
  closeEditor(): boolean {
    return closeEditor(this.#overlay, () => this.#options.onEditorClosed());
  }

  /** Undo the last mark. Returns false if there was nothing to undo. */
  undoEdit(): boolean {
    return undoEdit();
  }

  /** Close the preview. Returns false if there was nothing to close. */
  closePreview(): boolean {
    if (!previewIsOpen()) return false;
    hidePreview(this.#overlay);
    return true;
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

    void showPreview(item, this.#overlay).catch((error: unknown) => {
      console.error("[shotshelf] could not preview that capture", error);
      this.#options.onProblem("That capture could not be opened.");
    });
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

    const current = this.#selection.ids().at(-1);
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

    void copyCapture(item.path, item.kind).catch((error: unknown) => {
      console.error("[shotshelf] could not copy that capture", error);
      this.#options.onProblem("That capture could not be copied.");
    });
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
    // A newly pinned capture may put the shelf back under its cap.
    this.#enforceLimits();
    void this.#savePins();
  }

  /** Pins are the only shelf state worth surviving a restart. */
  #savePins(): Promise<void> {
    return persistPinned(this.#store.pinned());
  }

  // ── Dragging out ───────────────────────────────────────────────────────

  #armDrag(node: HTMLElement, item: ShelfItem, event: PointerEvent): void {
    armDrag(node, item, event, (target, capture) => {
      this.#dragging = true;
      void beginDrag(target, this.#dragSet(capture), () => {
        this.#dragging = false;
        // The OS had the pointer for the length of the drag, so the webview
        // saw no `pointerleave` and the hover hold is still armed.
        this.#column.hold("pointer", false);
      });
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
