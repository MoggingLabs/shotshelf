/**
 * What has been drawn on a capture, and in what order.
 *
 * Pure: no canvas, no DOM, no IPC. Everything here is a plain function of the
 * marks made so far, which is what lets undo, the callout numbering and the
 * crop maths be tested in Node rather than by drawing on a screen and looking
 * at it.
 *
 * All coordinates are in **image pixels**, never screen or card pixels. The
 * editor shows the capture scaled to fit a window, so screen coordinates are a
 * property of the window size and would be wrong the moment it changed — and
 * the exported file has to line up with the capture, not with the display it
 * was drawn on.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * A mark on a capture.
 *
 * `redact` is a rectangle like `box`, and deliberately a separate kind: a box
 * outlines something to draw the eye to it, a redaction destroys what is under
 * it. Conflating them is how a "black rectangle" annotation ends up shipped as
 * if it were a redaction, with the original still recoverable underneath.
 */
export type Mark =
  | ({ kind: "box" } & Rect)
  | ({ kind: "redact" } & Rect)
  | { kind: "arrow"; x1: number; y1: number; x2: number; y2: number }
  /** A numbered marker, so the image can be talked about: "why is 2 wrong?" */
  | { kind: "callout"; x: number; y: number; number: number };

export type Tool = Mark["kind"] | "crop";

export class EditSession {
  readonly #marks: Mark[] = [];
  #crop: Rect | undefined;
  #tool: Tool = "box";

  /** The capture's own size, which bounds every mark and the crop. */
  readonly width: number;
  readonly height: number;

  // Written out rather than declared as constructor parameter properties:
  // Node's type-stripping runs these tests without a compiler, and it cannot
  // erase that syntax. Keeping the source runnable by the test runner is worth
  // four lines.
  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }

  get tool(): Tool {
    return this.#tool;
  }

  set tool(next: Tool) {
    this.#tool = next;
  }

  marks(): readonly Mark[] {
    return this.#marks;
  }

  crop(): Rect | undefined {
    return this.#crop;
  }

  get isEmpty(): boolean {
    return this.#marks.length === 0 && this.#crop === undefined;
  }

  /**
   * The number the next callout will carry.
   *
   * Counted from the callouts present rather than from a running total, so
   * undoing one frees its number instead of leaving a gap — a sequence that
   * jumps from 1 to 3 reads as a missing step.
   */
  nextNumber(): number {
    return this.#marks.filter((mark) => mark.kind === "callout").length + 1;
  }

  /** Add a mark, clipped to the capture. Returns false if nothing was added. */
  add(mark: Mark): boolean {
    const clipped = this.#clip(mark);
    if (!clipped) return false;
    this.#marks.push(clipped);
    return true;
  }

  /**
   * Set the crop, clipped to the capture.
   *
   * One crop, replaced rather than accumulated: cropping a crop is a sequence
   * of coordinate spaces nobody can reason about, and the second drag almost
   * always means "no, this bit".
   */
  setCrop(rect: Rect): boolean {
    const clipped = clipRect(rect, this.width, this.height);
    if (!clipped) return false;
    this.#crop = clipped;
    return true;
  }

  /**
   * Undo the last thing done, whatever kind it was.
   *
   * The crop counts as an action: setting one and then undoing has to give the
   * whole capture back, or the only way out is to start again.
   */
  undo(): boolean {
    if (this.#marks.length > 0) {
      this.#marks.pop();
      return true;
    }
    if (this.#crop !== undefined) {
      this.#crop = undefined;
      return true;
    }
    return false;
  }

  /** The region the exported file covers: the crop, or the whole capture. */
  exportRect(): Rect {
    return this.#crop ?? { x: 0, y: 0, width: this.width, height: this.height };
  }

  #clip(mark: Mark): Mark | undefined {
    switch (mark.kind) {
      case "box":
      case "redact": {
        const rect = clipRect(mark, this.width, this.height);
        return rect ? { ...rect, kind: mark.kind } : undefined;
      }
      case "arrow": {
        // An arrow is a direction, so it is clamped rather than dropped —
        // dragging past the edge means "point off that way", not "cancel".
        const x1 = clamp(mark.x1, 0, this.width);
        const y1 = clamp(mark.y1, 0, this.height);
        const x2 = clamp(mark.x2, 0, this.width);
        const y2 = clamp(mark.y2, 0, this.height);
        // A zero-length arrow is a stray click, not a mark.
        if (Math.hypot(x2 - x1, y2 - y1) < 2) return undefined;
        return { kind: "arrow", x1, y1, x2, y2 };
      }
      case "callout":
        if (mark.x < 0 || mark.y < 0 || mark.x > this.width || mark.y > this.height) {
          return undefined;
        }
        return mark;
    }
  }
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

/**
 * Normalise and clip a rectangle.
 *
 * Normalising matters because a rectangle is dragged, and dragging up or left
 * produces negative width — every consumer would otherwise have to remember
 * that, and one of them would forget.
 */
export function clipRect(rect: Rect, width: number, height: number): Rect | undefined {
  const left = clamp(Math.min(rect.x, rect.x + rect.width), 0, width);
  const top = clamp(Math.min(rect.y, rect.y + rect.height), 0, height);
  const right = clamp(Math.max(rect.x, rect.x + rect.width), 0, width);
  const bottom = clamp(Math.max(rect.y, rect.y + rect.height), 0, height);

  // Below this it is a click that moved slightly, not a rectangle.
  if (right - left < 2 || bottom - top < 2) return undefined;
  return { x: left, y: top, width: right - left, height: bottom - top };
}
