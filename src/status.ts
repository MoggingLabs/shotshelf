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
  resized?.(true);
}

/**
 * How tall the strip currently is, or zero when it is not showing.
 *
 * Measured rather than derived from a constant: the height depends on how far
 * the message wraps at the column's width, so a number in `geometry.ts` would
 * be right for one message and wrong for the next.
 *
 * `offsetHeight` is zero for a `display: none` element, so the `hidden` check
 * is belt and braces — but it states the intent, and this is the file that
 * owns whether the strip is showing.
 */
export function alertHeight(): number {
  const alert = maybeEl<HTMLElement>("#shelf-alert");
  if (!alert || alert.hasAttribute("hidden")) return 0;

  // Known limit: measured at the width the window is *now*, not the width it
  // is about to become.
  //
  // After a quick look the window is much wider — `discardPreview` deliberately
  // does not give it back — so a long message wraps to fewer lines here than it
  // will need at the column's width, `peek` gets a height too small, and
  // `overflow: hidden` clips the last line. Reported by review; the obvious fix
  // (force the column's content width before measuring) was tried and reverted,
  // because the constant it needs is not the 199 a card is and every value
  // guessed for it moved three existing column-height gates. Sizing this
  // correctly means measuring after the resize lands, which is a second round
  // trip this module cannot make on its own.
  //
  // Written down rather than half-fixed: the message is still readable, it is
  // the tail of a long one that can be cut.
  return alert.offsetHeight;
}

/**
 * Told when the strip appears or goes away, so the column can resize.
 *
 * A callback rather than an import of the popover: this module reports state
 * and knows nothing about windows, and the sizing decision stays with the
 * thing that owns the window. `main.ts` is where the two meet.
 */
export function onAlertChange(listener: (showing: boolean) => void): void {
  resized = listener;
}

/**
 * `true` when the strip has just appeared, `false` when it has just gone.
 *
 * The listener used to take nothing, so the two events were indistinguishable —
 * which was fine while the only response was "resize", and is not once a
 * message can be the *only* reason a window is on screen. Something has to put
 * that window away when the message goes.
 */
let resized: ((showing: boolean) => void) | undefined;

/** Take the strip down, and stop it coming back on an old timer. */
function hush(): void {
  window.clearTimeout(alertTimer);
  const alert = maybeEl<HTMLElement>("#shelf-alert");
  if (!alert) return;
  alert.textContent = "";
  alert.setAttribute("hidden", "");
  resized?.(false);
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
  scanned = false;
  paint();
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
  watch = { live: dirs.length > 0, said: describeWatch(dirs) };
  paint();

  if (dirs.length === 0) {
    // Not "captures will not be picked up": the clipboard watcher is started
    // unconditionally and is independent of the folder watchers, so
    // Win+Shift+S and ⌘⌃⇧4 *are* still caught in exactly this state — Rust
    // even logs "clipboard watch only". The old sentence was false whenever
    // the tooltip beside it ("Watching the clipboard only") was true.
    say("No capture folders are being watched — only the clipboard. See the log for why.");
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
  watch = { live: false, said: "Shotshelf could not reach its catch engine." };
  paint();
}

/**
 * What the indicator knows. The tooltip is derived from this and never edited
 * in place.
 *
 * Appending to `mark.title` made the element itself the store, and an element
 * cannot be appended to twice safely: `setMark` overwrote the whole attribute,
 * so whichever of the two wrote last won. It happened to be correct only
 * because `main.ts` sequenced the watch report in `.then`/`.catch` and the scan
 * note in the trailing `.finally` — an ordering contract written in neither
 * function. Calling `showWatchState` a second time, which re-reading the watch
 * list after a settings change would do, silently erased the credential note.
 *
 * `undefined` means not yet known, which is different from `false`.
 */
let watch: { live: boolean; said: string } | undefined;
let scanned: boolean | undefined;

/**
 * The one place the indicator is written — genuinely, this time.
 *
 * Every caller sets state and asks for a repaint, so the order they run in
 * cannot change the result.
 */
function paint(): void {
  const mark = maybeEl<HTMLElement>("#shelf-mark");
  if (!mark) return;

  mark.classList.toggle("shelf__mark--live", watch?.live === true);
  mark.title = [
    watch?.said,
    scanned === false ? "Captures are not checked for credentials on this platform." : undefined,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n\n");
}
