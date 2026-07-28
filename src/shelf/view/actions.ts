/**
 * The controls that appear on a card when you hover it.
 *
 * Pin, copy and remove. They earn their space only on hover because the
 * picture is the card's identity — chrome on every tile all the time is what
 * made the first shelf unreadable.
 */

import { icon } from "../../icons.ts";
import { copyCapture } from "../bridge.ts";
import type { CaptureKind } from "../types.ts";

/** How long the copy button confirms itself. */
const COPIED_MS = 1100;

/** What a tile needs the shelf to do on its behalf. */
export interface TileHandlers {
  togglePin(id: string): void;
  remove(id: string): void;
}

function pinLabel(pinned: boolean): string {
  return pinned
    ? "Pinned — kept until you unpin it"
    : "Pin to keep this past the retention window";
}

function action(name: Parameters<typeof icon>[0], title: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.className = "tile__action";
  button.type = "button";
  button.title = title;
  button.append(icon(name, 13));
  return button;
}

function flash(button: HTMLElement, ok: boolean): void {
  button.classList.add(ok ? "tile__action--ok" : "tile__action--bad");
  window.setTimeout(
    () => button.classList.remove("tile__action--ok", "tile__action--bad"),
    COPIED_MS,
  );
}

function pinButton(id: string, pinned: boolean, handlers: TileHandlers): HTMLButtonElement {
  const button = action("star", pinLabel(pinned));
  button.classList.toggle("tile__action--on", pinned);
  button.addEventListener("click", () => handlers.togglePin(id));
  return button;
}

/** For the apps that take a paste but refuse a file drop. */
function copyButton(path: string, kind: CaptureKind, name: string): HTMLButtonElement {
  const button = action("copy", `Copy ${name} to the clipboard`);

  button.addEventListener("click", () => {
    void copyCapture(path, kind)
      .then(() => flash(button, true))
      .catch((error: unknown) => {
        console.error("[shotshelf] could not copy that capture", error);
        flash(button, false);
      });
  });

  return button;
}

function removeButton(id: string, name: string, handlers: TileHandlers): HTMLButtonElement {
  const button = action("close", `Remove ${name} from the shelf (the file stays on disk)`);
  button.classList.add("tile__action--remove");
  button.addEventListener("click", () => handlers.remove(id));
  return button;
}

export function actions(
  id: string,
  path: string,
  kind: CaptureKind,
  name: string,
  pinned: boolean,
  handlers: TileHandlers,
): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "tile__actions";
  wrap.append(
    pinButton(id, pinned, handlers),
    copyButton(path, kind, name),
    removeButton(id, name, handlers),
  );
  return wrap;
}

/**
 * Keep a card's pin controls in step with the data.
 *
 * Pinning is the one change applied to a live card rather than by rebuilding
 * it: rebuilding on a pin would reload the picture and flicker, for a change
 * that is two class toggles.
 */
export function reflectPin(tile: HTMLElement, pinned: boolean): void {
  tile.classList.toggle("tile--pinned", pinned);
  const button = tile.querySelector<HTMLButtonElement>(".tile__action");
  if (!button) return;
  button.classList.toggle("tile__action--on", pinned);
  button.title = pinLabel(pinned);
}
