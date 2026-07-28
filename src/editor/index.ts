/**
 * Marking up a capture before it goes somewhere.
 *
 * Built on the preview rather than in a window of its own. "Look at this
 * closely" and "point at part of this" are the same view at two intensities,
 * and a second window would need its own lifecycle, its own placement, its own
 * dismissal — all of which already exist here and had to be got right once.
 *
 * The tools are deliberately few: crop, box, arrow, numbered callout, redact.
 * Every one earns its place for the same job — telling someone else, or a
 * model, *where to look*. Text, colours, layers and freehand are a different
 * product, and each one added makes the thirty-second path slower.
 */

import { convertFileSrc } from "@tauri-apps/api/core";

import { browseShelf, previewShelf, saveEdit } from "../shelf/bridge.ts";
import type { ShelfItem } from "../shelf/types.ts";
import { paint, paintCropGuide } from "./draw.ts";
import { OverlayTicket } from "../shelf/overlay-ticket.ts";
import { EditSession, type Rect, type Tool } from "./session.ts";

/**
 * What the editor needs from the shelf that owns it.
 *
 * Only the two things the shelf genuinely owns: what is on it, and what the
 * user is told. The window itself goes through `bridge.ts` like every other
 * view module — this used to take `size` as an injected callback while
 * importing `saveEdit` directly, which declared a seam and then stepped over
 * it in the same file.
 */
export interface EditorHost {
  /** An edit was saved; it joins the shelf as a capture of its own. */
  saved(path: string): void;
  /**
   * Something went wrong and the user needs telling.
   *
   * The editor's marquee tool destroys pixels, and the docs sell it as
   * permanent — a save that fails in silence, leaving the editor open, is the
   * one failure here that must never be quiet.
   */
  failed(message: string): void;
}

interface Live {
  item: ShelfItem;
  session: EditSession;
  picture: HTMLImageElement;
  canvas: HTMLCanvasElement;
  frame: HTMLElement;
  /** The box the canvas has to fit inside. Watched, because it changes. */
  stage: HTMLElement;
  /** Image pixels per canvas pixel, for turning pointer positions into marks. */
  scale: number;
  watch: ResizeObserver;
}

let live: Live | undefined;
/**
 * Opening, superseding and abandoning — the same rules the quick look uses.
 *
 * These were written out here and again in `view/preview.ts`, in identical
 * code with identical comments, and then diverged: three fixes landed here
 * and none reached the copy. `OverlayTicket` exists so the next fix cannot
 * land in only one of them.
 */
const lifetime = new OverlayTicket();
/** Guards the save the same way; a double click wrote two files. */
let saving = false;

export function editorIsOpen(): boolean {
  return live !== undefined || lifetime.opening;
}

/** Open the editor on a capture. Recordings have nothing to annotate. */
export async function openEditor(
  item: ShelfItem,
  host: HTMLElement,
  callbacks: EditorHost,
): Promise<void> {
  // Refuses rather than replaces.
  //
  // It used to discard whatever was open and start again, which made the Edit
  // control — visible in the title strip, which the overlay deliberately does
  // not cover — a one-click shredder for every unsaved mark. The `editing`
  // guard existed twice on the keyboard path and on neither click path. The
  // control is hidden while an overlay is up now; this is the half that does
  // not depend on remembering to hide it.
  if (item.kind === "video" || lifetime.opening || live) return;

  const ticket = lifetime.begin();
  try {
    await open(ticket, item, host, callbacks);
  } finally {
    lifetime.finish();
  }
}

async function open(
  ticket: number,
  item: ShelfItem,
  host: HTMLElement,
  callbacks: EditorHost,
): Promise<void> {
  const picture = await load(convertFileSrc(item.path));
  if (lifetime.stale(ticket)) return;
  if (!picture) {
    // The Edit control is offered for any single picked capture, including one
    // whose file has since gone — an emptied Recycle Bin, a cleared temp
    // folder. Returning in silence left the button looking simply broken.
    callbacks.failed("That capture could not be opened — its file is gone.");
    return;
  }

  const session = new EditSession(picture.naturalWidth, picture.naturalHeight);
  await previewShelf(picture.naturalWidth / picture.naturalHeight);
  // Cancelled while Rust was resizing. The window has grown by now, so the
  // close that cancelled this is still owed the restore it could not do
  // against an editor that did not exist yet.
  if (lifetime.stale(ticket)) {
    if (!lifetime.abandoned) void browseShelf();
    return;
  }

  const frame = document.createElement("div");
  frame.className = "editor";

  const canvas = document.createElement("canvas");
  canvas.className = "editor__canvas";
  // The canvas sits in its own stage so the toolbar's height is taken out of
  // the space it fits into, rather than the canvas overflowing past it.
  const stage = document.createElement("div");
  stage.className = "editor__stage";
  stage.append(canvas);
  frame.append(toolbar(session, callbacks), stage);
  host.append(frame);

  // Re-fit whenever the stage changes shape, rather than at the three moments
  // we happened to think of. The window grows asynchronously — Rust has
  // returned, but the webview has not necessarily laid out at the new size —
  // and a crop or an undo changes the region inside a stage that has not
  // moved at all. One observer covers all three, and replaces three different
  // guesses at "how much room is there" that the call sites used to pass in.
  const watch = new ResizeObserver(() => {
    fit();
    render();
  });
  watch.observe(stage);

  live = { item, session, picture, canvas, frame, stage, scale: 1, watch };
  fit();
  bindPointer();
  render();
}

/**
 * Close the editor because the user backed out or the save finished.
 *
 * Hands the window back as it goes: the editor grew it to show one capture
 * large, so every deliberate close owes the restore. Nothing else did it —
 * closing left an always-on-top window at 72% of the screen showing a 225px
 * column of cards until the user hid it and opened it again.
 *
 * Returns whether it consumed the gesture. True while one is merely *opening*
 * too: Escape during the load used to be swallowed by the `editorIsOpen` guard
 * and then fall through to dismissing the popover, after which the editor
 * mounted into a window that was no longer on screen.
 */
export function closeEditor(): boolean {
  const pending = lifetime.close();
  if (!live) return pending;

  teardown();
  void browseShelf();
  return true;
}

/**
 * Tear the editor down because the window itself is going away.
 *
 * Deliberately does *not* restore: that puts the window back on screen at
 * browse size, which is the exact opposite of what the user just asked for.
 * Without this the editor outlived the hide entirely, and the next capture
 * popped a column with a stale canvas painted over it — untouchable, because a
 * peeked window never takes focus, so Escape could not reach it either.
 */
export function discardEditor(): void {
  lifetime.discard();
  teardown();
}

function teardown(): void {
  if (!live) return;
  live.watch.disconnect();
  live.frame.remove();
  live = undefined;
}

/** Undo the last mark. Returns false if there was nothing to undo. */
export function undoEdit(): boolean {
  if (!live?.session.undo()) return false;
  fit();
  render();
  return true;
}

function setTool(tool: Tool): void {
  if (!live) return;
  live.session.tool = tool;
  for (const button of live.frame.querySelectorAll<HTMLButtonElement>(".editor__tool")) {
    button.classList.toggle("editor__tool--on", button.dataset["tool"] === tool);
  }
}

/**
 * Composite the edit at the capture's own resolution and hand it to Rust.
 *
 * Exported from an offscreen canvas at full size rather than from the one on
 * screen: the visible canvas is scaled to the window, so saving it would save
 * a screenshot of the preview instead of an annotated capture.
 */
async function saveEditedCapture(callbacks: EditorHost): Promise<void> {
  if (!live || saving) return;
  const { item, session, picture } = live;

  // The save belongs to *this* editor.
  //
  // It composites, encodes and writes across three awaits, and then called the
  // module-global close — so a save still in flight when the user backed out
  // and opened a different capture tore that second editor down and took its
  // marks with it. The ticket exists to answer "is this still the operation
  // being waited for"; the save was the one async path not asking.
  const ticket = lifetime.current;

  saving = true;
  try {
    const region = session.exportRect();
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(region.width);
    canvas.height = Math.round(region.height);

    const context = canvas.getContext("2d");
    if (!context) throw new Error("this window cannot draw");
    paint(context, picture, session, 1);

    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("the edit could not be encoded");

    const path = await saveEdit(item.path, new Uint8Array(await blob.arrayBuffer()));
    // The file is written either way — it is the user's work and it is on
    // disk. Only the editor this save started in is closed, and only if it is
    // still the one on screen.
    if (!lifetime.stale(ticket)) closeEditor();
    callbacks.saved(path);
  } catch (error) {
    // The editor deliberately stays open: the marks are still there, and
    // closing on a failed save would throw the work away.
    console.error("[shotshelf] could not save that edit", error);
    callbacks.failed("That edit could not be saved. Your marks are still here.");
  } finally {
    saving = false;
  }
}

// ── Internals ────────────────────────────────────────────────────────────

function toolbar(session: EditSession, callbacks: EditorHost): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "editor__bar";

  const tools: [Tool, string][] = [
    ["crop", "Crop"],
    ["box", "Box"],
    ["arrow", "Arrow"],
    ["callout", "Number"],
    ["redact", "Redact"],
  ];

  for (const [tool, label] of tools) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "editor__tool";
    button.dataset["tool"] = tool;
    button.textContent = label;
    button.classList.toggle("editor__tool--on", session.tool === tool);
    button.addEventListener("click", () => setTool(tool));
    bar.append(button);
  }

  bar.append(
    action("Undo", "editor-undo", () => void undoEdit()),
    action("Save", "editor-save", () => {
      void saveEditedCapture(callbacks);
    }),
  );
  return bar;
}

function action(label: string, id: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "editor__action";
  button.id = id;
  button.textContent = label;
  button.addEventListener("click", onClick);
  return button;
}

/**
 * Size the canvas to the stage, fitting **both** axes.
 *
 * Width alone was not enough, and the stage does not scroll: a canvas taller
 * than it simply has its bottom cut off. That happened to every wide capture
 * the moment it opened, and far worse after a crop to a tall region, where the
 * user could see under half of what they had just cropped to and had no way to
 * draw on the rest.
 */
function fit(): void {
  if (!live) return;
  const region = live.session.exportRect();
  const box = live.stage.getBoundingClientRect();
  // Before the first layout there is no box to fit into. The observer calls
  // again the moment there is one.
  const width = box.width || region.width;
  const height = box.height || region.height;

  const scale = Math.min(width / region.width, height / region.height);
  live.canvas.width = Math.max(Math.round(region.width * scale), 1);
  live.canvas.height = Math.max(Math.round(region.height * scale), 1);
  live.scale = scale;
}

function render(guide?: Rect): void {
  if (!live) return;
  const context = live.canvas.getContext("2d");
  if (!context) return;

  context.clearRect(0, 0, live.canvas.width, live.canvas.height);
  paint(context, live.picture, live.session, live.scale);
  if (guide) {
    paintCropGuide(context, live.canvas, {
      x: guide.x * live.scale,
      y: guide.y * live.scale,
      width: guide.width * live.scale,
      height: guide.height * live.scale,
    });
  }
}

/**
 * Pointer position in image pixels, which is what a mark is stored in.
 *
 * Derived from the element's *rendered* box rather than from the canvas's
 * backing-store size. Those are two different things: the backing store is
 * sized to the capture, and CSS then fits the element into whatever the window
 * allows. Converting with the backing-store scale alone put every mark
 * somewhere other than where it was drawn as soon as the two disagreed —
 * which is whenever a capture is larger than the window it is shown in, i.e.
 * almost always.
 */
function at(event: PointerEvent): { x: number; y: number } {
  if (!live) return { x: 0, y: 0 };
  const box = live.canvas.getBoundingClientRect();
  const region = live.session.exportRect();
  if (box.width === 0 || box.height === 0) return { x: region.x, y: region.y };

  return {
    x: region.x + ((event.clientX - box.left) / box.width) * region.width,
    y: region.y + ((event.clientY - box.top) / box.height) * region.height,
  };
}

function bindPointer(): void {
  if (!live) return;
  const canvas = live.canvas;

  canvas.addEventListener("pointerdown", (event) => {
    if (!live || event.button !== 0) return;
    const start = at(event);
    canvas.setPointerCapture(event.pointerId);

    // A callout is a single click; everything else is a drag.
    if (live.session.tool === "callout") {
      live.session.add({ kind: "callout", ...start, number: live.session.nextNumber() });
      render();
      return;
    }

    const move = (moved: PointerEvent): void => {
      if (!live) return;
      const now = at(moved);
      const rect: Rect = {
        x: start.x,
        y: start.y,
        width: now.x - start.x,
        height: now.y - start.y,
      };
      // Drawn live, so the mark is placed by eye rather than by guesswork.
      if (live.session.tool === "crop") {
        render(normalise(rect));
      } else {
        render();
        preview(rect);
      }
    };

    const up = (ended: PointerEvent): void => {
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", up);
      if (!live) return;

      const end = at(ended);
      commit(start, end);
      render();
    };

    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", up);
  });
}

/** Draw the mark being dragged, without adding it to the session. */
function preview(rect: Rect): void {
  if (!live) return;
  const context = live.canvas.getContext("2d");
  if (!context) return;

  context.save();
  context.scale(live.scale, live.scale);
  const region = live.session.exportRect();
  context.translate(-region.x, -region.y);
  context.strokeStyle = "#f59e0b";
  context.lineWidth = 3;
  context.strokeRect(rect.x, rect.y, rect.width, rect.height);
  context.restore();
}

function commit(start: { x: number; y: number }, end: { x: number; y: number }): void {
  if (!live) return;
  const rect: Rect = {
    x: start.x,
    y: start.y,
    width: end.x - start.x,
    height: end.y - start.y,
  };

  switch (live.session.tool) {
    case "crop":
      if (live.session.setCrop(rect)) fit();
      return;
    case "box":
    case "redact":
      live.session.add({ kind: live.session.tool, ...rect });
      return;
    case "arrow":
      live.session.add({ kind: "arrow", x1: start.x, y1: start.y, x2: end.x, y2: end.y });
      return;
    case "callout":
      // Placed on press; nothing to do on release.
      return;
  }
}

function normalise(rect: Rect): Rect {
  return {
    x: Math.min(rect.x, rect.x + rect.width),
    y: Math.min(rect.y, rect.y + rect.height),
    width: Math.abs(rect.width),
    height: Math.abs(rect.height),
  };
}

/** How long to wait for a capture to decode before giving up on it. */
const LOAD_TIMEOUT_MS = 15_000;

function load(src: string): Promise<HTMLImageElement | undefined> {
  return new Promise((resolve) => {
    const picture = new Image();
    // The asset protocol sends CORS headers, so this keeps the canvas
    // untainted — without it `toBlob` throws and nothing can be saved.
    picture.crossOrigin = "anonymous";

    // Neither `load` nor `error` is guaranteed to fire. Without a deadline
    // `opening` stayed true forever, `editorIsOpen()` with it, and the keydown
    // handler swallowed every key but Escape and Ctrl+Z for the rest of the
    // session — the shelf looked alive and answered nothing.
    const giveUp = window.setTimeout(() => resolve(undefined), LOAD_TIMEOUT_MS);
    const settle = (result: HTMLImageElement | undefined): void => {
      window.clearTimeout(giveUp);
      resolve(result);
    };

    picture.addEventListener("load", () => settle(picture), { once: true });
    picture.addEventListener("error", () => settle(undefined), { once: true });
    picture.src = src;
  });
}
