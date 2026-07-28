/**
 * The two places the shelf tells you about itself: the live dot in the title
 * strip, and the alert line beneath it.
 *
 * Both stay out of the way until there is something to say. A tray app that
 * chatters is a tray app people quit.
 */

import { maybeEl } from "./dom.ts";
/** The alert strip stays hidden until there is something worth reading. */
export function say(message: string): void {
  const alert = maybeEl<HTMLElement>("#shelf-alert");
  if (!alert) return;
  alert.textContent = message;
  alert.removeAttribute("hidden");
}

/**
 * Describe what the catch engine is watching, in the dot's tooltip.
 *
 * Folders that do not exist are skipped by Rust rather than watched blindly,
 * so this is also how you find out that the folder you expected is missing.
 */
function describeWatch(dirs: readonly string[]): string {
  if (dirs.length === 0) return "Watching the clipboard only";
  return [
    `Watching ${dirs.length} folder${dirs.length === 1 ? "" : "s"} + the clipboard`,
    ...dirs,
  ].join("\n");
}

/**
 * Say, once, that captures are not being checked for credentials here.
 *
 * In the tooltip rather than the alert strip, and once rather than per tile:
 * this is a standing property of the platform, not an event, and a warning on
 * every card is a warning people stop reading. Saying nothing at all was the
 * worse option — it made an unchecked capture look identical to a checked one.
 */
export function noteScanUnavailable(): void {
  const mark = document.querySelector<HTMLElement>("#shelf-mark");
  if (!mark) return;
  mark.title = `${mark.title}

Captures are not checked for credentials on this platform.`;
}

export function showWatchState(dirs: readonly string[]): void {
  console.info("[shotshelf] watching", dirs);

  const mark = maybeEl<HTMLElement>("#shelf-mark");
  if (mark) {
    mark.classList.add("shelf__mark--live");
    mark.title = describeWatch(dirs);
  }

  if (dirs.length === 0) say("No capture folders found — watching the clipboard only.");
}
