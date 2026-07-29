/**
 * Painting a session's marks onto a canvas.
 *
 * Used twice, with the same code: once to draw on screen at whatever size the
 * window is, and once to produce the exported file at the capture's own
 * resolution. Sharing it is the point — two painters would drift, and the mark
 * you exported would stop matching the one you drew.
 *
 * The redaction rule holds here and is the reason export goes through a canvas
 * at all: `fillRect` over the image data **replaces** those pixels, and
 * `toBlob` encodes what is on the canvas. There is no layer to peel off. A
 * redaction drawn as an annotation on top of an intact image would be
 * separable from what it covers, which is not redaction at all.
 */

import type { EditSession, Mark } from "./session.ts";

/** Amber, the same "look here" colour the comparison uses. */
const INK = "#f59e0b";
/** Opaque and near-black, so a redaction reads as one rather than as shadow. */
const REDACTION = "#111114";
const OUTLINE_WIDTH = 3;
const ARROW_HEAD = 14;
const CALLOUT_RADIUS = 13;

/**
 * Draw the capture and everything on it.
 *
 * `scale` maps image pixels to canvas pixels: 1 when exporting at full size,
 * less when the capture is shown scaled to fit a window.
 *
 * Line widths are in **image** pixels and are deliberately not compensated for
 * it. A 3px outline is 3px of the capture, so on screen it shrinks with
 * everything else and what you see is a faithful preview of the exported
 * file — dividing by `scale` would hold the stroke at a constant thickness on
 * screen and therefore make it thinner, relative to the picture, in the file
 * you actually send. (This docstring used to claim the division was done. It
 * never was, and it should not be.)
 */
export function paint(
  context: CanvasRenderingContext2D,
  picture: CanvasImageSource,
  session: EditSession,
  scale: number,
): void {
  context.save();
  // Everything below is in image pixels with the crop's origin at zero, so a
  // mark drawn at (x, y) lands at (x, y) whether or not there is a crop.
  inImageSpace(context, session, scale);

  context.drawImage(picture, 0, 0);

  // Redactions first: they destroy, and anything else is meant to be seen on
  // top of the result rather than buried under a black rectangle.
  for (const mark of session.marks()) {
    if (mark.kind === "redact") {
      context.fillStyle = REDACTION;
      context.fillRect(mark.x, mark.y, mark.width, mark.height);
    }
  }

  for (const mark of session.marks()) {
    if (mark.kind !== "redact") drawMark(context, mark);
  }

  context.restore();
}

/**
 * How a mark is stroked, in one place.
 *
 * The live preview under the pointer used to set `"#f59e0b"` and `3` itself,
 * because `INK` and `OUTLINE_WIDTH` were module-private here — so the
 * rectangle you dragged had square corners and the one that landed a
 * millisecond later had round joins, and recolouring a mark would have changed
 * only half of it. Two painters of the same thing is exactly what `paint`'s
 * own docstring says sharing this module exists to prevent.
 */
export function inkStyle(context: CanvasRenderingContext2D): void {
  context.strokeStyle = INK;
  context.fillStyle = INK;
  context.lineWidth = OUTLINE_WIDTH;
  context.lineJoin = "round";
  context.lineCap = "round";
}

/**
 * Put the context into image space: capture pixels, crop origin at zero.
 *
 * The caller is responsible for `save`/`restore`. Shared for the same reason
 * as the style — `paint` and the live preview both need it, and a fourth site
 * applied the same correction arithmetically instead, which is where the
 * second-crop bug came from.
 */
export function inImageSpace(
  context: CanvasRenderingContext2D,
  session: EditSession,
  scale: number,
): void {
  const region = session.exportRect();
  context.scale(scale, scale);
  context.translate(-region.x, -region.y);
}

function drawMark(context: CanvasRenderingContext2D, mark: Mark): void {
  inkStyle(context);

  switch (mark.kind) {
    case "box":
      // Hollow: the point is to draw the eye to something, not to hide it.
      context.strokeRect(mark.x, mark.y, mark.width, mark.height);
      return;

    case "arrow":
      drawArrow(context, mark.x1, mark.y1, mark.x2, mark.y2);
      return;

    case "callout":
      drawCallout(context, mark.x, mark.y, mark.number);
      return;

    case "redact":
      // Painted in the pass above, before anything else.
      return;
  }
}

function drawArrow(
  context: CanvasRenderingContext2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): void {
  const angle = Math.atan2(y2 - y1, x2 - x1);

  context.beginPath();
  context.moveTo(x1, y1);
  context.lineTo(x2, y2);
  context.stroke();

  // A filled head rather than two strokes: at small sizes two lines meeting at
  // a point read as a fork.
  context.beginPath();
  context.moveTo(x2, y2);
  context.lineTo(
    x2 - ARROW_HEAD * Math.cos(angle - Math.PI / 7),
    y2 - ARROW_HEAD * Math.sin(angle - Math.PI / 7),
  );
  context.lineTo(
    x2 - ARROW_HEAD * Math.cos(angle + Math.PI / 7),
    y2 - ARROW_HEAD * Math.sin(angle + Math.PI / 7),
  );
  context.closePath();
  context.fill();
}

/**
 * A numbered marker.
 *
 * The number is the whole reason this tool exists: it makes the image
 * *referenceable from a sentence* — "why is 2 misaligned but 3 fine?" — which
 * an anonymous box can never be.
 */
function drawCallout(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  value: number,
): void {
  context.beginPath();
  context.arc(x, y, CALLOUT_RADIUS, 0, Math.PI * 2);
  context.fill();

  context.fillStyle = "#1b1206";
  context.font = `700 ${CALLOUT_RADIUS + 3}px ui-sans-serif, system-ui, sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  // A hair below centre: digits sit optically high in most faces.
  context.fillText(String(value), x, y + 1);
}

/** The crop being dragged, shown by dimming everything outside it. */
export function paintCropGuide(
  context: CanvasRenderingContext2D,
  canvas: { width: number; height: number },
  rect: { x: number; y: number; width: number; height: number },
): void {
  context.save();
  context.fillStyle = "rgba(8, 9, 14, 0.62)";

  // Four bands around the selection, not a full cover with the middle punched
  // out. `clearRect` was the obvious way to write this and the wrong one: it
  // makes those pixels *transparent*, and there is nothing underneath —
  // `paint` drew the capture onto this same canvas moments earlier, and the
  // element's CSS background is near-black. So the region you were selecting
  // rendered as a solid dark rectangle, and the crop tool hid exactly the
  // thing you were using it to frame. The comment that used to sit here
  // reasoned about an overlay canvas this renderer does not have.
  const right = rect.x + rect.width;
  const bottom = rect.y + rect.height;
  context.fillRect(0, 0, canvas.width, rect.y);
  context.fillRect(0, bottom, canvas.width, canvas.height - bottom);
  context.fillRect(0, rect.y, rect.x, rect.height);
  context.fillRect(right, rect.y, canvas.width - right, rect.height);

  context.strokeStyle = INK;
  context.lineWidth = 2;
  context.strokeRect(rect.x, rect.y, rect.width, rect.height);
  context.restore();
}
