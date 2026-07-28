/**
 * The lifetime bookkeeping an overlay needs, in one place.
 *
 * The editor and the quick look are different surfaces with the same lifetime:
 * an open that spans several awaits, a close that owes the window back, and a
 * discard that does not. Both wrote that out independently, in byte-identical
 * code with byte-identical comments — and then the two copies drifted, which
 * is the whole reason this file exists.
 *
 * Three fixes landed in `editor/index.ts` and none of them reached
 * `view/preview.ts` eight files away: clearing `opening` when a close cancels
 * an open in flight, clearing it again on discard, and distinguishing "the
 * user backed out" from "the window is going away". The consequence in the
 * preview was that a capture whose bytes never arrived left `opening` true
 * for good — after which Space never opened a quick look again, Escape never
 * dismissed the popover again, and the popped column never left the screen,
 * with no recovery short of restarting the app.
 *
 * Nothing here touches the DOM or Rust, so the rules are testable on their own.
 */
export class OverlayTicket {
  #opening = false;
  #ticket = 0;
  #abandoned = false;

  /**
   * Whether an open is in flight.
   *
   * Part of "is this overlay up?", because the surface does not exist yet for
   * the whole span between the first await and the last — and a keystroke
   * arriving in that span has to be treated as landing on the overlay, not on
   * the shelf behind it.
   */
  get opening(): boolean {
    return this.#opening;
  }

  /**
   * Whether the cancelled open was abandoned rather than backed out of.
   *
   * The two need opposite endings. Backing out owes the browse window back;
   * the window being put away owes nothing, and restoring there would re-show
   * an always-on-top window the user just dismissed.
   */
  get abandoned(): boolean {
    return this.#abandoned;
  }

  /**
   * The token of whatever is open now.
   *
   * For work that starts *after* the open finished and must still know which
   * surface it belongs to — a save composites, encodes and writes across three
   * awaits, and used to close whatever happened to be live when it returned,
   * which tore down a different editor opened in the meantime.
   */
  get current(): number {
    return this.#ticket;
  }

  /** Start an open. The returned token identifies it to `stale`. */
  begin(): number {
    this.#opening = true;
    this.#abandoned = false;
    this.#ticket += 1;
    return this.#ticket;
  }

  /** Whether the open holding `token` has since been superseded. */
  stale(token: number): boolean {
    return token !== this.#ticket;
  }

  /** An open reached its end, mounted or not. */
  finish(): void {
    this.#opening = false;
  }

  /**
   * The user backed out. Returns whether an open was in flight, so the caller
   * can report that it consumed the gesture rather than letting it fall
   * through to whatever Escape does next.
   */
  close(): boolean {
    const pending = this.#opening;
    this.#ticket += 1;
    this.#abandoned = false;
    this.#opening = false;
    return pending;
  }

  /** The window is going away. Same invalidation, no restore owed. */
  discard(): void {
    this.#ticket += 1;
    this.#abandoned = true;
    this.#opening = false;
  }
}
