/**
 * One capture, as a card.
 *
 * Tiles are cached by the shelf and reused across renders rather than rebuilt.
 * Both views are redrawn wholesale — the alternative is two incremental paths
 * with two chances to get pin state and day grouping subtly wrong — and
 * reusing the elements is what makes that affordable: a redraw re-appends
 * existing nodes instead of re-fetching every picture through the asset
 * protocol and flickering.
 */

import { fileName, formatBytes, formatDuration } from "../../format.ts";
import { icon, solidIcon } from "../../icons.ts";
import { videoDetails } from "../bridge.ts";
import type { ShelfItem, VideoDetails } from "../types.ts";
import { actions, type TileHandlers } from "./actions.ts";
import { markSecrets } from "./secrets.ts";
import { glyphThumb, imageThumb, replaceThumb, setWash } from "./thumb.ts";

/** What a tile needs beyond the buttons: starting a native drag. */
export interface TileCallbacks extends TileHandlers {
  armDrag(node: HTMLElement, item: ShelfItem, event: PointerEvent): void;
  /** A press landed on the card, with whatever modifiers were held. */
  pick(id: string, event: PointerEvent): void;
}

/**
 * The line along the bottom of a card, shown on hover.
 *
 * "VS Code — auth.ts" where the OS could tell us, and the filename otherwise.
 * A capture is named after the clock, which identifies it to a filesystem and
 * to nobody else; what was in front when it was taken is how a person actually
 * remembers which screenshot this is.
 */
function label(item: ShelfItem): HTMLElement {
  const el = document.createElement("div");
  el.className = "tile__label";
  const context = item.context?.label;
  el.textContent = context ?? fileName(item.path);
  // The filename is still what the file is called, so it stays reachable.
  el.title = context ? `${context}
${fileName(item.path)}` : fileName(item.path);
  return el;
}

/** Marks a recording as one even once it looks like a still. */
function badge(): HTMLElement {
  const el = document.createElement("span");
  el.className = "tile__badge";
  el.append(solidIcon("play", 9));
  const text = document.createElement("span");
  text.className = "tile__badge-text";
  el.append(text);
  return el;
}

function describeSize(details: VideoDetails): string {
  const size = formatBytes(details.bytes);
  return details.durationMs === null
    ? size
    : `${formatDuration(details.durationMs)} · ${size}`;
}

/**
 * Swap the film glyph for a real frame and put the recording's length and size
 * on the card. A failure here is not worth surfacing — the card stays useful
 * and still drags out the original file.
 */
async function describeVideo(tile: HTMLElement, item: ShelfItem): Promise<void> {
  let details: VideoDetails;
  try {
    details = await videoDetails(item.path);
  } catch (error) {
    console.error("[shotshelf] could not read that recording", error);
    return;
  }

  const text = tile.querySelector<HTMLElement>(".tile__badge-text");
  if (text) text.textContent = describeSize(details);

  if (details.poster === null) return;

  const frame = imageThumb(details.poster, fileName(item.path));
  // A poster that has been swept from the cache should not blank the card.
  frame.addEventListener("error", () => replaceThumb(tile, glyphThumb("film"), null), {
    once: true,
  });
  // The poster is the recording's own frame, so it fills the bars too.
  replaceThumb(tile, frame, details.poster);
}

export function buildTile(item: ShelfItem, callbacks: TileCallbacks): HTMLElement {
  const name = fileName(item.path);

  const tile = document.createElement("article");
  tile.className = "tile";
  tile.title = item.path;
  tile.dataset["id"] = item.id;
  tile.classList.toggle("tile--pinned", item.pinned);

  if (item.kind === "video") {
    tile.append(glyphThumb("film"));
  } else {
    const picture = imageThumb(item.path, name);
    picture.addEventListener(
      "error",
      () => replaceThumb(tile, glyphThumb("alert", "missing"), null),
      { once: true },
    );
    tile.append(picture);
    setWash(tile, item.path);
  }

  tile.append(
    label(item),
    actions(item.id, item.path, item.kind, name, item.pinned, callbacks),
  );

  if (item.kind === "video") {
    tile.append(badge());
    void describeVideo(tile, item);
  } else {
    // Reading the capture is slow and entirely optional; the card is complete
    // and draggable whether or not this ever comes back.
    void markSecrets(tile, item.path);
  }

  // Press-and-move on the card itself hands the capture to the OS. The action
  // buttons are excluded so copy, pin and remove stay clickable.
  tile.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    if ((event.target as HTMLElement).closest(".tile__action")) return;
    callbacks.pick(item.id, event);
    callbacks.armDrag(tile, item, event);
  });

  return tile;
}

/** The placeholder shown when there is nothing on the shelf at all. */
export function emptyState(): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "empty";

  const frame = document.createElement("div");
  frame.className = "empty__frame";
  frame.append(icon("camera", 26));

  const title = document.createElement("p");
  title.className = "empty__title";
  title.textContent = "Nothing on the shelf";

  const hint = document.createElement("p");
  hint.className = "empty__hint";
  hint.textContent = "Screenshots and recordings land here the moment you take them.";

  wrap.append(frame, title, hint);
  return wrap;
}
