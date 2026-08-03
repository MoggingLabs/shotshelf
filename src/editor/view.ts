/**
 * Where the capture is, and how big, inside the window looking at it.
 *
 * Pure: no canvas, no DOM, no IPC — the same rule `session.ts` keeps, and for
 * the same reason. Zoom arithmetic is the classic place for an off-by-a-factor
 * bug, and `deviceScaleFactor` is pinned to 1 in both Playwright projects, so
 * a browser spec can never see the high-DPI path at all. These functions can.
 *
 * The split of responsibilities is worth stating, because it is what stops
 * zoom reaching the saved file:
 *
 * - `session.ts` holds **what was drawn**, in image pixels.
 * - this holds **where it is being looked at from**, and nothing else.
 * - the export composites from `session.ts` alone at scale 1, so no value in
 *   this file can change a single pixel of what is written to disk.
 */

import type { Rect } from "./session.ts";

/**
 * The window onto the capture.
 *
 * `scale` is CSS pixels per image pixel — 1 means one image pixel per CSS
 * pixel, which is what the toolbar calls 100%. `originX`/`originY` are the
 * image coordinate sitting at the stage's top-left corner.
 *
 * `fitted` is not derived: a view can be *at* the fit scale without being *in*
 * Fit mode, and the difference is what the stage's ResizeObserver needs to
 * know. Re-fitting on every resize is right in Fit mode and wrong at 100% —
 * it would silently undo the user's zoom every time they dragged the window
 * edge, and a maximizable window gets dragged a lot.
 */
export interface View {
  scale: number;
  originX: number;
  originY: number;
  fitted: boolean;
}

/** How far a `+`/`-` step moves, as a multiplier. */
export const ZOOM_STEP = 1.25;

/**
 * The zoom range.
 *
 * The floor is low enough to see all of a very large capture at once; the
 * ceiling is where a screenshot's pixels are unambiguous blocks. Beyond either
 * there is nothing left to see, and an unbounded zoom is a way to lose the
 * picture entirely.
 */
export const MIN_SCALE = 0.05;
export const MAX_SCALE = 16;

/** The largest scale that shows all of `region` inside `box`. */
export function fitScale(region: Rect, box: { width: number; height: number }): number {
  // Before the first layout there is no box. Answering 1 rather than 0 or
  // Infinity keeps every later multiplication finite; the observer calls again
  // the moment there is a real box.
  if (box.width <= 0 || box.height <= 0 || region.width <= 0 || region.height <= 0) return 1;
  return Math.min(box.width / region.width, box.height / region.height);
}

/**
 * A view showing all of `region`, centred in `box`.
 *
 * **Never enlarges.** Fit means "show me all of it", and for a capture smaller
 * than the window all of it is already on screen — blowing it up to fill the
 * space answers a question nobody asked and, with smoothing off above 100%,
 * answers it in blocks. Observed live: a 320×180 capture opened at *464%*,
 * which is not a fit, it is a zoom nobody chose. Every image viewer worth
 * copying caps here; zooming past 100% stays available and stays deliberate.
 */
export function fitView(region: Rect, box: { width: number; height: number }): View {
  return centred(region, box, Math.min(fitScale(region, box), 1));
}

/** A view at `scale`, centred on `region` inside `box`. */
export function centred(
  region: Rect,
  box: { width: number; height: number },
  scale: number,
): View {
  const safe = clampScale(scale);
  return clampOrigin(
    {
      scale: safe,
      originX: region.x - (box.width / safe - region.width) / 2,
      originY: region.y - (box.height / safe - region.height) / 2,
      fitted: false,
    },
    region,
    box,
  );
}

export function clampScale(scale: number): number {
  if (!Number.isFinite(scale) || scale <= 0) return 1;
  return Math.min(Math.max(scale, MIN_SCALE), MAX_SCALE);
}

/**
 * Keep the picture reachable.
 *
 * Two rules, and the second is the one that is easy to get wrong. When the
 * capture is *smaller* than the stage it is centred — anything else parks it
 * against a corner with dead space on two sides. When it is larger, the origin
 * is held inside the image so a pan cannot scroll the picture off the edge and
 * leave the user looking at blank canvas with no way back.
 */
export function clampOrigin(
  view: View,
  region: Rect,
  box: { width: number; height: number },
): View {
  const visibleWidth = box.width / view.scale;
  const visibleHeight = box.height / view.scale;

  const axis = (origin: number, start: number, extent: number, visible: number): number => {
    if (!Number.isFinite(origin)) return start;
    if (visible >= extent) return start - (visible - extent) / 2;
    return Math.min(Math.max(origin, start), start + extent - visible);
  };

  return {
    ...view,
    originX: axis(view.originX, region.x, region.width, visibleWidth),
    originY: axis(view.originY, region.y, region.height, visibleHeight),
  };
}

/**
 * Zoom to `scale` while keeping the image point under `at` under `at`.
 *
 * `at` is in **stage** coordinates — CSS pixels from the stage's top-left —
 * which is what a wheel event gives once the stage's bounding box is taken
 * off. Anchoring to the pointer is the difference between zoom that feels like
 * a magnifier and zoom that throws away the thing you were looking at.
 */
export function zoomAbout(
  view: View,
  region: Rect,
  box: { width: number; height: number },
  scale: number,
  at: { x: number; y: number },
): View {
  const next = clampScale(scale);
  // The image coordinate currently under the pointer…
  const imageX = view.originX + at.x / view.scale;
  const imageY = view.originY + at.y / view.scale;
  // …put back under it at the new scale.
  return clampOrigin(
    {
      scale: next,
      originX: imageX - at.x / next,
      originY: imageY - at.y / next,
      fitted: false,
    },
    region,
    box,
  );
}

/** Move the view by a drag of `dx`/`dy` **stage** pixels. */
export function pan(
  view: View,
  region: Rect,
  box: { width: number; height: number },
  dx: number,
  dy: number,
): View {
  return clampOrigin(
    {
      ...view,
      fitted: false,
      originX: view.originX - dx / view.scale,
      originY: view.originY - dy / view.scale,
    },
    region,
    box,
  );
}

/**
 * A stage coordinate in image pixels — which is what a mark is stored in.
 *
 * The inverse of the transform `paint` draws under, and deliberately derived
 * from the view rather than from the canvas's backing store. Those are two
 * different things once `devicePixelRatio` is in play: the backing store is
 * CSS pixels times the ratio, and converting with it would put every mark
 * somewhere other than where it was drawn on any display that is not exactly
 * 100%.
 */
export function toImage(view: View, at: { x: number; y: number }): { x: number; y: number } {
  return {
    x: view.originX + at.x / view.scale,
    y: view.originY + at.y / view.scale,
  };
}

/** How the zoom reads in the toolbar. 100% is one image pixel per CSS pixel. */
export function zoomLabel(view: View): string {
  return `${Math.round(view.scale * 100)}%`;
}
