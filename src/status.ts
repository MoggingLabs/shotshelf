/**
 * The two places the shelf tells you about itself: the live dot in the title
 * strip, and the alert line beneath it.
 *
 * Both stay out of the way until there is something to say. A tray app that
 * chatters is a tray app people quit.
 */

/** Elements are looked up lazily so this module can be imported by tests. */
function el<T extends HTMLElement>(selector: string): T | null {
  return document.querySelector<T>(selector);
}

/** The alert strip stays hidden until there is something worth reading. */
export function say(message: string): void {
  const alert = el<HTMLElement>("#shelf-alert");
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
export function describeWatch(dirs: readonly string[]): string {
  if (dirs.length === 0) return "Watching the clipboard only";
  return [
    `Watching ${dirs.length} folder${dirs.length === 1 ? "" : "s"} + the clipboard`,
    ...dirs,
  ].join("\n");
}

export function showWatchState(dirs: readonly string[]): void {
  console.info("[shotshelf] watching", dirs);

  const mark = el<HTMLElement>("#shelf-mark");
  if (mark) {
    mark.classList.add("shelf__mark--live");
    mark.title = describeWatch(dirs);
  }

  if (dirs.length === 0) say("No capture folders found — watching the clipboard only.");
}
