/**
 * The two places the shelf tells you about itself: the live dot in the title
 * strip, and the alert line beneath it.
 *
 * Both stay out of the way until there is something to say. A tray app that
 * chatters is a tray app people quit.
 */

import { maybeEl } from "./dom.ts";
/** How long a message stays on the strip before it takes itself down. */
const ALERT_MS = 12_000;

let alertTimer: number | undefined;

/**
 * The alert strip stays hidden until there is something worth reading, and
 * goes away again afterwards.
 *
 * The clearing half is not tidiness. A message that never leaves permanently
 * costs a line of a 225px panel and, far worse, a stale one reads as current —
 * the strip carried "No capture folders found" from start-up onwards, so
 * "the alert is visible" was true for the entire session. Three regression
 * tests used exactly that as their proof that a failure had been reported, and
 * all three passed with the code that reports it deleted.
 */
export function say(message: string): void {
  const alert = maybeEl<HTMLElement>("#shelf-alert");
  if (!alert) return;
  alert.textContent = message;
  alert.removeAttribute("hidden");

  window.clearTimeout(alertTimer);
  alertTimer = window.setTimeout(hush, ALERT_MS);
}

/** Take the strip down, and stop it coming back on an old timer. */
function hush(): void {
  window.clearTimeout(alertTimer);
  const alert = maybeEl<HTMLElement>("#shelf-alert");
  if (!alert) return;
  alert.textContent = "";
  alert.setAttribute("hidden", "");
}

/**
 * Describe what the catch engine is watching, in the dot's tooltip.
 *
 * A missing capture folder is created beside a parent that already exists, so
 * the list here is what is genuinely being watched — which is also how you
 * find out that the folder you expected is not among them.
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
  const mark = maybeEl<HTMLElement>("#shelf-mark");
  if (!mark) return;
  mark.title = `${mark.title}

Captures are not checked for credentials on this platform.`;
}

/**
 * Show whether the catch engine is actually catching anything.
 *
 * `dirs` is what Rust is **really** watching, not what it meant to watch —
 * `folders::start` drops any directory the watcher refused. So an empty list
 * here is a genuine "nothing is being watched", and it must not look like
 * success.
 *
 * It did. The dot was turned green unconditionally, so the Rust half of this
 * fix — reporting the true list — was undone one line later in the front end:
 * an exhausted inotify limit, a declined macOS permission or a folder
 * redirected to an offline share all produced an empty list and a green dot.
 * The alert strip was the only honest signal, and it erases itself after
 * twelve seconds; the usage guide points the user at this indicator.
 */
export function showWatchState(dirs: readonly string[]): void {
  console.info("[shotshelf] watching", dirs);
  setMark(dirs.length > 0, describeWatch(dirs));

  if (dirs.length === 0) {
    say("No capture folders are being watched — captures will not be picked up. See the log.");
  }
}

/**
 * The catch engine could not be asked at all.
 *
 * Distinct from "watching nothing": this is the app not knowing, which is
 * worse, and it previously left the dot with no state and no tooltip because
 * `showWatchState` was only ever called from `.then`.
 */
export function noteWatchUnavailable(): void {
  setMark(false, "Shotshelf could not reach its catch engine.");
}

/** The one place the indicator's state is set, so the two callers agree. */
function setMark(live: boolean, title: string): void {
  const mark = maybeEl<HTMLElement>("#shelf-mark");
  if (!mark) return;
  mark.classList.toggle("shelf__mark--live", live);
  mark.title = title;
}
