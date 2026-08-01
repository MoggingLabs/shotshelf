/**
 * The lifetime of a surface shown over the shelf, in one place.
 *
 * The editor and the quick look are different things to look at with the same
 * lifetime: an open spanning several awaits, a close that owes the window
 * back, and a discard that does not. Both wrote that out independently, and
 * the copies drifted — three fixes landed in one and none in the other, which
 * left a capture that never decoded able to wedge the shelf for the session.
 *
 * The first attempt at this moved the three *flags* here and left every rule
 * that used them duplicated, so the next fix could still land in one file
 * only. This owns the rules: what "open" means, who may end an open, who owes
 * the browse window back, and when a surface is torn down. The two consumers
 * supply the parts that genuinely differ — how to build their surface, how to
 * take it off screen, and how to hand the window back.
 *
 * The restore is injected rather than imported so this stays what it is: a
 * rule about lifetimes, with no DOM and no IPC, testable the way the rest of
 * the pure core is.
 */

export class Overlay<T> {
  #live: T | undefined;
  #opening = false;
  #ticket = 0;
  /**
   * The ticket of the open that was abandoned, if any.
   *
   * A bare flag was instance-wide, and any later `show` or `close` reset it —
   * so an open parked on a slow picture could be discarded, superseded by a
   * new one, and then resolve to find the flag cleared and hand the window
   * back *under the surface now on screen*. The ticket makes the answer
   * belong to the open that asked.
   */
  #abandonedTicket: number | undefined;
  readonly #teardown: (live: T) => void;
  readonly #restore: () => void;

  constructor(surface: { teardown: (live: T) => void; restore: () => void }) {
    this.#teardown = surface.teardown;
    this.#restore = surface.restore;
  }

  /**
   * Whether something is on screen or on its way.
   *
   * The "on its way" half matters: the surface does not exist for the whole
   * span between the first await and the last, and a keystroke arriving in
   * that span belongs to the overlay, not to the shelf behind it.
   */
  get isOpen(): boolean {
    return this.#live !== undefined || this.#opening;
  }

  /** What is on screen, for the surface's own operations. */
  get live(): T | undefined {
    return this.#live;
  }

  /**
   * The token of whatever is open now.
   *
   * For work that starts *after* an open finished and must still know which
   * surface it belongs to — a save composites, encodes and writes across
   * three awaits, and closing "whatever is live" when it returns tore down a
   * different editor opened in the meantime.
   */
  get current(): number {
    return this.#ticket;
  }

  #wasAbandoned(token: number): boolean {
    return this.#abandonedTicket === token;
  }

  /** Whether the open holding `token` has since been superseded. */
  stale(token: number): boolean {
    return token !== this.#ticket;
  }

  /**
   * Show a surface, unless one is already up or on its way.
   *
   * `build` is handed a `stale` predicate and must check it after every await;
   * returning `undefined` means nothing mounts. If the open is superseded
   * while in flight, the browse window is handed back — unless the reason was
   * the window going away, in which case restoring it would put an
   * always-on-top window the user just dismissed back on screen.
   *
   * Returns whether **this call** mounted something. Callers cannot ask `live`
   * instead: after a refusal that is the surface someone else put up, and
   * treating it as your own is how the editor bound its pointer handlers to an
   * existing canvas a second time — after which one drag committed two marks
   * and one undo took back half of it.
   */
  async show(build: (stale: () => boolean) => Promise<T | undefined>): Promise<boolean> {
    if (this.isOpen) return false;

    this.#opening = true;
    this.#ticket += 1;
    const mine = this.#ticket;
    const stale = (): boolean => this.stale(mine);

    try {
      const built = await build(stale);
      if (stale()) {
        // Asked about *this* open. A discard of some earlier open is not a
        // reason to withhold the window from this one.
        if (!this.#wasAbandoned(mine)) this.#restore();
        return false;
      }
      this.#live = built;
      return built !== undefined;
    } finally {
      // Only the open that owns the ticket may clear the flag. Clearing it
      // unconditionally meant a superseded open's `finally` — which runs
      // whenever it happens to run — reported "nothing is opening" while a
      // newer one still was, and everything that vetoes on an open overlay
      // stopped vetoing: the column timer, the launch dismissal, the keyboard
      // router. That is the same family of bug this class exists to end.
      if (!stale()) this.#opening = false;
    }
  }

  /**
   * The user backed out. Tears down whatever is up and hands the window back.
   *
   * Returns whether it consumed the gesture — true while one is merely
   * *opening* too, so a keystroke that cancels a pending open does not also
   * fall through to whatever Escape does next.
   */
  close(): boolean {
    const pending = this.#opening;
    this.#ticket += 1;
    this.#opening = false;

    const live = this.#live;
    if (live === undefined) return pending;

    this.#live = undefined;
    this.#teardown(live);
    this.#restore();
    return true;
  }

  /**
   * The window itself is going away. Same invalidation, no restore owed.
   *
   * Without this the surface outlived the hide, and the next capture popped a
   * column with a stale canvas painted across it — untouchable, because a
   * peeked window never takes focus, so Escape could not reach it either.
   */
  discard(): void {
    // Recorded against the open being abandoned, not as a mode.
    this.#abandonedTicket = this.#ticket;
    this.#ticket += 1;
    this.#opening = false;

    const live = this.#live;
    if (live === undefined) return;

    this.#live = undefined;
    this.#teardown(live);
  }
}

/** How long to wait on a picture before giving up on it. */
const IMAGE_TIMEOUT_MS = 15_000;

/**
 * Wait for a picture to be readable, or give up.
 *
 * Neither `load` nor `error` is guaranteed to fire — a file on a disconnected
 * share, one still being written. Without a deadline the open never ends, the
 * overlay reports itself open forever, and the shelf stops answering the
 * keyboard. Both surfaces need exactly this and had two copies of it with two
 * constants of the same value.
 */
export function readable(picture: HTMLImageElement): Promise<HTMLImageElement | undefined> {
  if (picture.complete && picture.naturalWidth > 0) return Promise.resolve(picture);

  return new Promise((resolve) => {
    const giveUp = window.setTimeout(() => resolve(undefined), IMAGE_TIMEOUT_MS);
    const settle = (result: HTMLImageElement | undefined): void => {
      window.clearTimeout(giveUp);
      resolve(result);
    };

    picture.addEventListener("load", () => settle(picture), { once: true });
    picture.addEventListener("error", () => settle(undefined), { once: true });
  });
}
