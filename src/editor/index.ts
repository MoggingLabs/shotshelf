/**
 * Marking up a capture before it goes somewhere.
 *
 * This used to be built on the quick look, mounted as an overlay inside the
 * shelf's own window, on the argument that "look at this closely" and "point at
 * part of this" are one view at two intensities and a second window would need
 * its own lifecycle, placement and dismissal. **That is retired, and the
 * reasoning is kept here rather than deleted, because it was half right.** The
 * two views really are alike — the quick look still works exactly that way and
 * still should. What the argument missed is that the shelf's window is
 * `decorations: false`, `alwaysOnTop`, `skipTaskbar` and `resizable: false`, so
 * an editor living in it could not be resized, maximized, snapped or found in
 * Alt-Tab, and always scaled the capture to fit. For a glance you dismiss, none
 * of that matters. For the surface where you redact a credential, all of it
 * does. The three things a second window was said to need are now the settings
 * window's three, written once more.
 *
 * The tools are deliberately few: crop, box, arrow, numbered callout, redact.
 * Every one earns its place for the same job — telling someone else, or a
 * model, *where to look*. Text, colours, layers and freehand are a different
 * product, and each one added makes the thirty-second path slower. That
 * argument is about the tool set and not about the window, and it stands.
 *
 * What is drawn lives in `session.ts` (image pixels), how it is painted in
 * `draw.ts`, and where it is being looked at from in `view.ts`. Only the first
 * two reach the exported file.
 */

import { convertFileSrc } from "@tauri-apps/api/core";

import { saveEdit } from "../editor-window/bridge.ts";
import { readable } from "../shelf/overlay.ts";
import { inImageSpace, inkStyle, paint, paintCropGuide, REDACTION } from "./draw.ts";
import { EditSession, type Rect, type Tool } from "./session.ts";
import {
  centred,
  clampOrigin,
  fitView,
  pan,
  toImage,
  zoomAbout,
  zoomLabel,
  ZOOM_STEP,
  type View,
} from "./view.ts";

/**
 * What the editor needs from the window that hosts it.
 *
 * Two things, and neither is the shelf: this window has no list of captures
 * and no way to reach one. A saved edit reaches the shelf through Rust's
 * `capture://edited`, which is why there is no `saved` callback here any more.
 */
export interface EditorShell {
  /**
   * Something went wrong and the user needs telling.
   *
   * The redact tool destroys pixels and the docs sell it as permanent — a save
   * that fails in silence, leaving the editor open, is the one failure here
   * that must never be quiet.
   */
  failed(message: string): void;
  /** The user is finished; take the window off screen. */
  done(): void;
}

interface Live {
  path: string;
  session: EditSession;
  picture: HTMLImageElement;
  canvas: HTMLCanvasElement;
  frame: HTMLElement;
  /** The box the canvas fills. Watched, because it changes. */
  stage: HTMLElement;
  /** Where the capture is being looked at from. */
  view: View;
  watch: ResizeObserver;
}

let live: Live | undefined;
let shell: EditorShell | undefined;

/**
 * Which open is current.
 *
 * Loading a capture spans several awaits, and a second open can arrive in the
 * middle of the first — the window stays up between captures now, so this is
 * ordinary rather than exotic. Every await checks the ticket it started with
 * before touching anything, which is the same rule `Overlay` enforced for the
 * shelf and the reason it is a ticket rather than a boolean.
 */
let ticket = 0;


/**
 * Open the editor on a capture.
 *
 * Three cases, and keeping them apart is what stops the window throwing work
 * away. The **same** capture asked for again is a resume: the marks stay and
 * nothing reloads, which matters because Rust shows and focuses the window
 * before this is called, so a stray second press must not cost anything. A
 * **different** capture over a dirty session asks first. Anything else loads.
 */
export async function openCapture(
  path: string,
  root: HTMLElement,
  host: EditorShell,
): Promise<void> {
  shell = host;

  if (live?.path === path) {
    // Already here. Re-fit in case the window changed shape while hidden.
    layout();
    render();
    return;
  }
  if (live?.session.dirty) {
    askBefore(
      `Unsaved marks on ${nameOf(live.path)}.`,
      "Save and open",
      () => void save(() => void openCapture(path, root, host)),
      "Discard and open",
      () => {
        teardown();
        void openCapture(path, root, host);
      },
    );
    return;
  }

  teardown();
  const mine = ++ticket;

  const picture = new Image();
  // The asset protocol sends CORS headers, so this keeps the canvas
  // untainted — without it `toBlob` throws and nothing can be saved. It works
  // from this page for the same reason it worked from the shelf's: the asset
  // protocol's scope is granted per *app*, not per window, and the CSP is one
  // string for every page in `tauri.conf.json`.
  picture.crossOrigin = "anonymous";
  picture.src = convertFileSrc(path);

  const loaded = await readable(picture);
  if (mine !== ticket) return;
  if (!loaded) {
    // Rust has already refused a path that does not exist, so this is the
    // narrower set: a decode failure, a fifteen-second timeout on a file still
    // being written or on a disconnected share, or an asset-protocol scope
    // refusal. `readable` answers the same `undefined` to all three.
    host.failed("That capture could not be opened. It may have been moved, or is still being written.");
    return;
  }

  const session = new EditSession(loaded.naturalWidth, loaded.naturalHeight);

  const frame = document.createElement("div");
  frame.className = "editor";
  // Which capture this is. Read by the specs, and it is here rather than on a
  // test-only global because it is a fact about what is on screen — a window
  // that cannot say what it is showing is worse for a person than for a test.
  frame.dataset["capture"] = path;

  const canvas = document.createElement("canvas");
  canvas.className = "editor__canvas";
  // The canvas sits in its own stage so the toolbar's height is taken out of
  // the space it fits into, rather than the canvas overflowing past it.
  const stage = document.createElement("div");
  stage.className = "editor__stage";
  stage.append(canvas);
  frame.append(toolbar(session), stage);
  root.append(frame);

  const watch = new ResizeObserver(() => {
    layout();
    render();
  });
  watch.observe(stage);

  live = {
    path,
    session,
    picture: loaded,
    canvas,
    frame,
    stage,
    view: { scale: 1, originX: 0, originY: 0, fitted: true },
    watch,
  };

  layout();
  bindPointer();
  bindWheel();
  render();
  refreshZoom();
}

/**
 * Back out.
 *
 * Called by Escape and by the window's X, which is the same gesture asked
 * twice — Rust refuses the close and asks this. Unsaved marks get a real
 * decision bar rather than the old "press Escape again within four seconds":
 * that idiom existed because a frameless, never-focused popover had nowhere to
 * put a question. A focused window with a title bar does.
 */
export function requestClose(): void {
  if (!live) {
    shell?.done();
    return;
  }
  if (!live.session.dirty) {
    teardown();
    shell?.done();
    return;
  }
  askBefore(
    "You have unsaved marks.",
    "Save",
    () => void save(() => shell?.done()),
    "Discard",
    () => {
      teardown();
      shell?.done();
    },
  );
}

/** Undo the last mark. Returns false if there was nothing to undo. */
export function undoEdit(): boolean {
  if (!live?.session.undo()) return false;
  layout();
  render();
  refreshUndo();
  return true;
}

/** Save the marks as a new capture. Returns false if there is nothing open. */
export function saveEditedCapture(): boolean {
  if (!live) return false;
  void save(() => shell?.done());
  return true;
}

// ── Zoom ─────────────────────────────────────────────────────────────────

export function zoomBy(factor: number): void {
  if (!live) return;
  const box = live.stage.getBoundingClientRect();
  live.view = centred(live.session.exportRect(), box, live.view.scale * factor);
  render();
  refreshZoom();
}

export function zoomTo(scale: number): void {
  if (!live) return;
  const box = live.stage.getBoundingClientRect();
  live.view = centred(live.session.exportRect(), box, scale);
  render();
  refreshZoom();
}

export function zoomToFit(): void {
  if (!live) return;
  const box = live.stage.getBoundingClientRect();
  live.view = { ...fitView(live.session.exportRect(), box), fitted: true };
  render();
  refreshZoom();
}

// ── Internals ────────────────────────────────────────────────────────────

/** A capture's own name, for the title strip and the questions. */
function nameOf(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/**
 * Take the editor down without asking anything.
 *
 * Every caller has already decided; this is the mechanical half. The
 * `ResizeObserver` is disconnected first — a live observer on a removed
 * element is how the previous version could paint into a detached canvas.
 */
function teardown(): void {
  ticket += 1;
  if (!live) return;
  live.watch.disconnect();
  live.frame.remove();
  live = undefined;
}

/**
 * Ask before throwing marks away.
 *
 * Rendered into the toolbar rather than as a modal: the question is about the
 * thing on screen and the answer is one click, so covering the picture to ask
 * it would hide the very marks the user is being asked about. Cancel is the
 * third answer and always exists — a two-button question about unsaved work is
 * a question with no safe answer.
 */
function askBefore(
  question: string,
  affirm: string,
  onAffirm: () => void,
  deny: string,
  onDeny: () => void,
): void {
  if (!live) return;
  live.frame.querySelector(".editor__ask")?.remove();

  const bar = document.createElement("div");
  bar.className = "editor__ask";
  bar.setAttribute("role", "alert");

  const text = document.createElement("span");
  text.className = "editor__ask-text";
  text.textContent = question;

  const button = (label: string, onClick: () => void, primary = false): HTMLButtonElement => {
    const control = document.createElement("button");
    control.type = "button";
    control.className = primary ? "editor__action editor__action--primary" : "editor__action";
    control.textContent = label;
    control.addEventListener("click", () => {
      bar.remove();
      onClick();
    });
    return control;
  };

  bar.append(
    text,
    button(affirm, onAffirm, true),
    button(deny, onDeny),
    button("Cancel", () => {
      /* The bar removing itself is the whole answer. */
    }),
  );
  live.frame.prepend(bar);
  bar.querySelector("button")?.focus();
}

/**
 * Composite the edit at the capture's own resolution and hand it to Rust.
 *
 * Exported from an offscreen canvas at full size rather than from the one on
 * screen: the visible canvas is scaled to the window and may be zoomed into a
 * corner of the picture, so saving it would save a screenshot of the view
 * instead of an annotated capture. `paint` is called with scale 1 and **no
 * origin**, so neither the zoom nor `devicePixelRatio` can reach the file.
 */
async function save(then: () => void): Promise<void> {
  if (!live || saving === ticket) return;
  const { path, session, picture } = live;

  // The save belongs to *this* open. It composites, encodes and writes across
  // three awaits, and a save still in flight when the user switched captures
  // used to tear the second one down and take its marks with it.
  const mine = ticket;
  saving = mine;
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

    await saveEdit(path, new Uint8Array(await blob.arrayBuffer()));
    // The file is written either way — it is the user's work and it is on
    // disk. Only the open this save started in is torn down.
    if (mine === ticket) {
      teardown();
      then();
    }
  } catch (error) {
    // The editor deliberately stays open: the marks are still there, and
    // closing on a failed save would throw the work away.
    console.error("[shotshelf] could not save that edit", error);
    shell?.failed("That edit could not be saved. Your marks are still here.");
  } finally {
    if (saving === mine) saving = undefined;
  }
}

/** Which open is mid-save, if any. A ticket, not a boolean — see `save`. */
let saving: number | undefined;

function toolbar(session: EditSession): HTMLElement {
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
    button.setAttribute("aria-pressed", String(session.tool === tool));
    // The one irreversible tool says so where the hand hovers — USAGE's
    // "Redact destroys" paragraph reached only readers of USAGE.
    if (tool === "redact") {
      button.dataset["tip"] = "Removes the pixels underneath — permanent in the saved copy";
    }
    button.addEventListener("click", () => setTool(tool));
    bar.append(button);
  }

  const undo = action("Undo", "editor-undo", () => void undoEdit());
  undo.dataset["tip"] = "Undo the last mark (Ctrl+Z)";
  // Nothing has been drawn yet.
  undo.disabled = true;

  // The zoom cluster. It exists because a bigger window is only half the
  // answer to "too small to see": a 4K capture fitted to a 1400px window is
  // still a quarter size, and redacting a token means reading it first.
  const out = action("−", "editor-zoom-out", () => zoomBy(1 / ZOOM_STEP));
  out.dataset["tip"] = "Zoom out (-)";
  out.setAttribute("aria-label", "Zoom out");

  const readout = document.createElement("button");
  readout.type = "button";
  readout.className = "editor__action editor__zoom";
  readout.id = "editor-zoom";
  readout.textContent = "100%";
  readout.dataset["tip"] = "Show at actual size (1)";
  readout.addEventListener("click", () => zoomTo(1));

  const into = action("+", "editor-zoom-in", () => zoomBy(ZOOM_STEP));
  into.dataset["tip"] = "Zoom in (+)";
  into.setAttribute("aria-label", "Zoom in");

  const fit = action("Fit", "editor-fit", () => zoomToFit());
  fit.dataset["tip"] = "Fit the whole capture in the window (0)";

  const save = action("Save", "editor-save", () => void saveEditedCapture());
  // The one control that leaves with something saved reads as the primary
  // action. A styling class, not the id: `styles.css` explains why an
  // id-strength rule was the wrong tool, and the id stays for lookups.
  save.classList.add("editor__action--primary");
  save.dataset["tip"] = "Save as a new capture — the original is untouched";

  bar.append(undo, out, readout, into, fit, save);
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
 * Size the canvas to the stage, and settle the view inside it.
 *
 * The backing store is CSS pixels **times `devicePixelRatio`**, with the CSS
 * size set explicitly alongside it. Those are two different numbers on any
 * display that is not exactly 100%, and conflating them is what made "100%"
 * mean "one image pixel per CSS pixel, then blurred by the OS" — which is not
 * actual size at all, on the one control whose whole job is to promise it.
 *
 * In Fit mode the view is recomputed; otherwise only its origin is re-clamped.
 * Re-fitting unconditionally would undo the user's zoom every time the window
 * was resized, and a maximizable window gets resized a great deal.
 */
function layout(): void {
  if (!live) return;
  const region = live.session.exportRect();
  const box = live.stage.getBoundingClientRect();
  // Before the first layout there is no box. The observer calls again the
  // moment there is one.
  const width = box.width || region.width;
  const height = box.height || region.height;
  const ratio = window.devicePixelRatio || 1;

  live.canvas.width = Math.max(Math.round(width * ratio), 1);
  live.canvas.height = Math.max(Math.round(height * ratio), 1);
  live.canvas.style.width = `${width}px`;
  live.canvas.style.height = `${height}px`;

  live.view = live.view.fitted
    ? { ...fitView(region, { width, height }), fitted: true }
    : clampOrigin(live.view, region, { width, height });
  refreshZoom();
}

function render(guide?: Rect): void {
  if (!live) return;
  const context = live.canvas.getContext("2d");
  if (!context) return;

  const ratio = window.devicePixelRatio || 1;
  const { view } = live;

  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, live.canvas.width, live.canvas.height);
  // Zoom is deliberately not smoothed: a screenshot at 400% should show hard
  // pixel edges, because the point of going that close is to read what is
  // actually there rather than an interpolation of it.
  context.imageSmoothingEnabled = view.scale <= 1;
  paint(context, live.picture, live.session, view.scale * ratio, {
    x: view.originX,
    y: view.originY,
  });

  if (guide) {
    // Canvas space, so the view's origin comes off first.
    //
    // `at()` returns image coordinates while canvas-x 0 is the image
    // coordinate at the view's origin. `paint` and `preview` both handle this
    // through `inImageSpace`; this call site does the arithmetic, and getting
    // it wrong is invisible with no crop and no zoom — where both terms are
    // zero — and wrong everywhere else.
    paintCropGuide(context, live.canvas, {
      x: (guide.x - view.originX) * view.scale * ratio,
      y: (guide.y - view.originY) * view.scale * ratio,
      width: guide.width * view.scale * ratio,
      height: guide.height * view.scale * ratio,
    });
  }
}

/**
 * The Undo button shows whether there is anything to undo.
 *
 * A control that silently does nothing is indistinguishable from a broken one;
 * `:disabled` is the difference. Called wherever the history changes.
 */
function refreshUndo(): void {
  if (!live) return;
  const undo = live.frame.querySelector<HTMLButtonElement>("#editor-undo");
  if (undo) undo.disabled = !live.session.dirty;
}

/**
 * The zoom readout says where the view actually is, including after a fit.
 *
 * The frame also carries the view itself. That is not decoration: the window
 * is a viewport onto a picture that may be scaled, panned and letterboxed, so
 * "where on the capture is this point on screen" is a question with a real
 * answer that nothing else can compute from outside. The specs use it to drag
 * in *image* coordinates, which is the space marks are stored in — before it
 * existed they used stage pixels and quietly depended on Fit blowing a small
 * capture up to fill the window, so capping Fit at actual size broke five of
 * them for a reason that had nothing to do with what they were testing.
 */
function refreshZoom(): void {
  if (!live) return;
  const readout = live.frame.querySelector<HTMLButtonElement>("#editor-zoom");
  if (readout) readout.textContent = zoomLabel(live.view);
  const fit = live.frame.querySelector<HTMLButtonElement>("#editor-fit");
  if (fit) fit.setAttribute("aria-pressed", String(live.view.fitted));
  live.frame.dataset["scale"] = String(live.view.scale);
  live.frame.dataset["originX"] = String(live.view.originX);
  live.frame.dataset["originY"] = String(live.view.originY);
  // And which part of the capture is being edited, which is the whole picture
  // until a crop and the crop afterwards. Separate from the view above: the
  // view can show less of it (zoomed in) or more (a small capture with
  // letterbox around it), and conflating the two is exactly the mistake that
  // made a canvas-sized measurement mean "the capture" for as long as Fit
  // enlarged everything to fill the window.
  const region = live.session.exportRect();
  live.frame.dataset["regionX"] = String(region.x);
  live.frame.dataset["regionY"] = String(region.y);
  live.frame.dataset["regionWidth"] = String(region.width);
  live.frame.dataset["regionHeight"] = String(region.height);
}

function setTool(tool: Tool): void {
  if (!live) return;
  live.session.tool = tool;
  for (const button of live.frame.querySelectorAll<HTMLButtonElement>(".editor__tool")) {
    const on = button.dataset["tool"] === tool;
    button.classList.toggle("editor__tool--on", on);
    // The tool group is five toggles with exactly one on — the strongest case
    // in the app for `aria-pressed`, and the pin already sets the policy:
    // state a screen reader can hear, not only a class.
    button.setAttribute("aria-pressed", String(on));
  }
}

/** Pointer position in image pixels, which is what a mark is stored in. */
function at(event: PointerEvent): { x: number; y: number } {
  if (!live) return { x: 0, y: 0 };
  const box = live.canvas.getBoundingClientRect();
  return toImage(live.view, { x: event.clientX - box.left, y: event.clientY - box.top });
}

/** Whether the space bar is down, which turns a drag into a pan. */
let panning = false;

export function setPanning(on: boolean): void {
  panning = on;
  if (live) live.stage.classList.toggle("editor__stage--pan", on);
}

function bindWheel(): void {
  if (!live) return;
  // `{ passive: false }` is load-bearing. Chromium treats `wheel` as passive
  // by default and silently ignores `preventDefault` on a passive listener —
  // so without this the page zooms (WebView2's own Ctrl+wheel) underneath our
  // zoom, and the trackpad pinch does the same.
  live.stage.addEventListener(
    "wheel",
    (event) => {
      if (!live) return;
      event.preventDefault();
      const box = live.stage.getBoundingClientRect();
      const factor = event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
      live.view = zoomAbout(
        live.view,
        live.session.exportRect(),
        box,
        live.view.scale * factor,
        { x: event.clientX - box.left, y: event.clientY - box.top },
      );
      render();
      refreshZoom();
    },
    { passive: false },
  );
}

function bindPointer(): void {
  if (!live) return;
  const canvas = live.canvas;

  canvas.addEventListener("pointerdown", (event) => {
    // Re-read rather than closing over the binding above: a switch, a save or
    // a close can tear the editor down between press and release, and a drag
    // that goes on painting into a detached canvas is how the editor used to
    // survive its own destruction.
    if (!live) return;
    // The middle button pans always; the left button pans while space is
    // held. Anything else is not ours.
    const isPan = event.button === 1 || (event.button === 0 && panning);
    if (event.button !== 0 && !isPan) return;

    canvas.setPointerCapture(event.pointerId);

    if (isPan) {
      let lastX = event.clientX;
      let lastY = event.clientY;
      const move = (moved: PointerEvent): void => {
        if (!live) return;
        const box = live.stage.getBoundingClientRect();
        live.view = pan(
          live.view,
          live.session.exportRect(),
          box,
          moved.clientX - lastX,
          moved.clientY - lastY,
        );
        lastX = moved.clientX;
        lastY = moved.clientY;
        render();
        refreshZoom();
      };
      const up = (): void => {
        canvas.removeEventListener("pointermove", move);
        canvas.removeEventListener("pointerup", up);
        canvas.removeEventListener("pointercancel", up);
      };
      canvas.addEventListener("pointermove", move);
      canvas.addEventListener("pointerup", up);
      canvas.addEventListener("pointercancel", up);
      return;
    }

    const start = at(event);
    const session = live.session;

    // A callout is a single click; everything else is a drag.
    if (session.tool === "callout") {
      session.add({ kind: "callout", ...start, number: session.nextNumber() });
      render();
      refreshUndo();
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
      if (session.tool === "crop") {
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

      commit(start, at(ended));
      render();
      refreshUndo();
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

  const ratio = window.devicePixelRatio || 1;
  context.save();
  // The same transform and the same ink `paint` uses, rather than a second
  // copy of each. This set `"#f59e0b"` and `3` by hand and set neither
  // `lineJoin` nor `lineCap`, so the rectangle under the pointer had square
  // corners and the one that landed had round ones.
  inImageSpace(context, live.session, live.view.scale * ratio, {
    x: live.view.originX,
    y: live.view.originY,
  });

  // Redaction previews as what it will do, not as a box around it.
  //
  // Every tool drew the same hollow amber rectangle, so the one irreversible
  // operation in the app was indistinguishable from Box while being placed and
  // only turned opaque on release — against this module's own promise that
  // what you see is a faithful preview of the exported file. The colour comes
  // from `draw.ts` rather than a second copy.
  if (live.session.tool === "redact") {
    context.fillStyle = REDACTION;
    context.fillRect(rect.x, rect.y, rect.width, rect.height);
  } else {
    inkStyle(context);
    context.strokeRect(rect.x, rect.y, rect.width, rect.height);
  }
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
      // A crop changes what "all of it" means, so the view goes back to Fit —
      // the user has just said which part they care about. An *undo* does not,
      // which is why only this branch re-fits.
      if (live.session.setCrop(rect)) zoomToFit();
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
