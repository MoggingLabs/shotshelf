/**
 * The app's one tooltip, themed and window-bound, driven by `data-tip`.
 *
 * The OS tooltip cannot be themed, shows on the OS's own schedule, and over
 * an always-on-top frameless popover routinely surfaces behind the window it
 * describes. One delegated listener per window replaces every `title=` the
 * app used to set. The split of duties is deliberate: `data-tip` is
 * presentation only, and the accessible *name* stays on `aria-label` — a
 * `title` doubling as a fallback name is exactly the ambiguity the a11y
 * policy ("label equals tip") existed to end.
 */

/** Long enough to prove intent, short enough to answer a hover. */
const SHOW_MS = 500;
/** Moving between neighbouring controls keeps the answer instant. */
const GRACE_MS = 300;
/** The bubble never touches the window edge. */
const EDGE = 8;

let bubble: HTMLElement | undefined;
let showTimer: number | undefined;
let shownFor: HTMLElement | undefined;
let graceUntil = 0;

function ensureBubble(): HTMLElement {
  if (bubble === undefined) {
    bubble = document.createElement("div");
    bubble.className = "tip";
    // Presentation only: the name is on the control's aria-label, so a
    // screen reader announcing the bubble too would say everything twice.
    bubble.setAttribute("role", "presentation");
    bubble.setAttribute("aria-hidden", "true");
    bubble.hidden = true;
    document.body.append(bubble);
  }
  return bubble;
}

function place(target: HTMLElement, tip: HTMLElement): void {
  const anchor = target.getBoundingClientRect();
  const size = tip.getBoundingClientRect();
  let left = anchor.left + anchor.width / 2 - size.width / 2;
  left = Math.max(EDGE, Math.min(left, window.innerWidth - size.width - EDGE));
  // Below the control unless the window ends first — then above. Clamped
  // rather than clever: on a 225px shelf there is no room to be clever in.
  let top = anchor.bottom + 6;
  if (top + size.height + EDGE > window.innerHeight) top = anchor.top - size.height - 6;
  top = Math.max(EDGE, top);
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}

function show(target: HTMLElement): void {
  const text = target.dataset["tip"];
  if (text === undefined || text === "") return;
  const tip = ensureBubble();
  tip.textContent = text;
  tip.hidden = false;
  place(target, tip);
  shownFor = target;
}

function hide(): void {
  window.clearTimeout(showTimer);
  showTimer = undefined;
  if (shownFor !== undefined) {
    graceUntil = Date.now() + GRACE_MS;
    shownFor = undefined;
  }
  if (bubble !== undefined) bubble.hidden = true;
}

function arm(target: HTMLElement): void {
  window.clearTimeout(showTimer);
  if (Date.now() < graceUntil) {
    show(target);
    return;
  }
  showTimer = window.setTimeout(() => show(target), SHOW_MS);
}

/**
 * One call per window, at boot. Everything else is the `data-tip` attribute.
 */
export function initTooltips(): void {
  document.addEventListener("pointerover", (event) => {
    const target = (event.target as Element | null)?.closest("[data-tip]");
    if (target instanceof HTMLElement) {
      if (target !== shownFor) arm(target);
    } else {
      hide();
    }
  });

  // Keyboard users get the same answer on focus, and immediately: a delay
  // that proves pointer intent proves nothing about a Tab press.
  document.addEventListener("focusin", (event) => {
    const target = (event.target as Element | null)?.closest("[data-tip]");
    if (target instanceof HTMLElement) show(target);
    else hide();
  });

  // Pressing, scrolling, leaving or Escape all mean "done reading". The
  // Escape listener deliberately consumes nothing: the shelf's one-level-at-
  // a-time ladder must still receive the same press.
  document.addEventListener("pointerdown", () => hide(), true);
  document.addEventListener("scroll", () => hide(), true);
  document.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Escape") hide();
    },
    true,
  );
  window.addEventListener("blur", () => hide());
}
