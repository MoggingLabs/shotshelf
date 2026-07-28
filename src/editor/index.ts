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

import { saveEdit } from "../shelf/bridge.ts";
import type { ShelfItem } from "../shelf/types.ts";
import { paint, paintCropGuide } from "./draw.ts";
import { EditSession, type Rect, type Tool } from "./session.ts";

/** What the editor needs from whatever opened it. */
export interface EditorHost {
  /** Ask Rust to size the window to this capture. Returns the size given. */
  size(aspect: number): Promise<[number, number]>;
  /** An edit was saved; it joins the shelf as a capture of its own. */
  saved(path: string): void;
  /** The editor has closed. */
  closed(): void;
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
  /** Image pixels per canvas pixel, for turning pointer positions into marks. */
  scale: number;
}

let live: Live | undefined;

export function editorIsOpen(): boolean {
  return live !== undefined;
}

/** Open the editor on a capture. Recordings have nothing to annotate. */
export async function openEditor(
  item: ShelfItem,
  host: HTMLElement,
  callbacks: EditorHost,
): Promise<void> {
  if (item.kind === "video") return;
  closeEditor(host, () => callbacks.closed());

  const picture = await load(convertFileSrc(item.path));
  if (!picture) return;

  const session = new EditSession(picture.naturalWidth, picture.naturalHeight);
  const [width] = await callbacks.size(picture.naturalWidth / picture.naturalHeight);

  const frame = document.createElement("div");
  frame.className = "editor";

  const canvas = document.createElement("canvas");
  canvas.className = "editor__canvas";
  // The canvas sits in its own stage so the toolbar's height is taken out of
  // the space it fits into, rather than the canvas overflowing past it.
  const stage = document.createElement("div");
  stage.className = "editor__stage";
  stage.append(canvas);
  frame.append(toolbar(session, host, callbacks), stage);
  host.append(frame);
  host.dataset["editing"] = "true";

  live = { item, session, picture, canvas, frame, scale: 1 };
  // Sized against what the stage actually offers, not what Rust reported: the
  // toolbar has taken some of it, and on a narrow window the CSS cap is what
  // decides in the end.
  resize(Math.min(width, stage.clientWidth || width));
  bindPointer();
  render();
}

/**
 * Close the editor.
 *
 * Takes the one callback it actually uses rather than a whole `EditorHost`:
 * synthesising a host here meant two of its three fields existed only to
 * satisfy the type, which reads as a contract and is not one.
 */
export function closeEditor(host: HTMLElement, onClosed?: () => void): boolean {
  if (!live) return false;
  live.frame.remove();
  live = undefined;
  delete host.dataset["editing"];
  onClosed?.();
  return true;
}

/** Undo the last mark. Returns false if there was nothing to undo. */
export function undoEdit(): boolean {
  if (!live?.session.undo()) return false;
  resize(live.canvas.clientWidth);
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
async function saveEditedCapture(host: HTMLElement, callbacks: EditorHost): Promise<void> {
  if (!live) return;
  const { item, session, picture } = live;

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
    closeEditor(host, () => callbacks.closed());
    callbacks.saved(path);
  } catch (error) {
    // The editor deliberately stays open: the marks are still there, and
    // closing on a failed save would throw the work away.
    console.error("[shotshelf] could not save that edit", error);
    callbacks.failed("That edit could not be saved. Your marks are still here.");
  }
}

// ── Internals ────────────────────────────────────────────────────────────

function toolbar(session: EditSession, host: HTMLElement, callbacks: EditorHost): HTMLElement {
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
      void saveEditedCapture(host, callbacks);
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

/** Size the canvas to the window and work out the image-to-canvas scale. */
function resize(available: number): void {
  if (!live) return;
  const region = live.session.exportRect();
  const width = Math.max(available || region.width, 1);
  const scale = width / region.width;

  live.canvas.width = Math.round(region.width * scale);
  live.canvas.height = Math.round(region.height * scale);
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
      if (live.session.setCrop(rect)) resize(live.canvas.clientWidth);
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

function load(src: string): Promise<HTMLImageElement | undefined> {
  return new Promise((resolve) => {
    const picture = new Image();
    // The asset protocol sends CORS headers, so this keeps the canvas
    // untainted — without it `toBlob` throws and nothing can be saved.
    picture.crossOrigin = "anonymous";
    picture.addEventListener("load", () => resolve(picture), { once: true });
    picture.addEventListener("error", () => resolve(undefined), { once: true });
    picture.src = src;
  });
}
