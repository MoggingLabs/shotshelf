/**
 * The vocabulary the shelf is built from.
 *
 * Deliberately free of DOM types. The store and the column queue reason about
 * captures without ever touching an element, which is what lets them be tested
 * in Node with no browser at all — and what stops view state from leaking into
 * the data it is showing.
 */

export type CaptureKind = "image" | "video";

/** Payload of the Rust `capture://new` event. */
export interface Capture {
  path: string;
  kind: CaptureKind;
  /** Unix milliseconds. */
  ts: number;
}

/**
 * A capture as the shelf holds it.
 *
 * The element showing it lives in the view's own map rather than here: a tile
 * is one possible presentation of an item, not part of what the item *is*, and
 * hanging a node off the data is how a rebuilt view leaves stale references
 * behind.
 */
export interface ShelfItem extends Capture {
  readonly id: string;
  /** Pinned captures ignore retention and the item cap, and survive a restart. */
  pinned: boolean;
}

/** What ffmpeg could tell us about a recording. */
export interface VideoDetails {
  poster: string | null;
  durationMs: number | null;
  bytes: number;
}

/** What the Rust side hands back to feed a native drag. */
export interface DragSource {
  path: string;
  icon: string;
}

/**
 * Identity of a capture on the shelf.
 *
 * Path alone is not enough: the same file can legitimately be caught twice —
 * re-saved, or restored from a pin after a restart — and timestamp alone
 * collides when a burst lands in the same millisecond.
 */
export function captureId(capture: Capture): string {
  return `${capture.ts}:${capture.path}`;
}

/** How alarming a finding is. Mirrors `enrich::secrets::SecretKind`. */
type SecretKind = "privateKey" | "serviceToken" | "jwt" | "assignment" | "personalData";

/**
 * Something in a capture worth a second look before it leaves the machine.
 *
 * `preview` is masked on the Rust side and must stay that way: the whole point
 * is to stop the value spreading, so putting it in a tooltip would defeat it.
 */
export interface SecretFinding {
  kind: SecretKind;
  label: string;
  preview: string;
}

/** What Shotshelf worked out about a capture by reading it. */
export interface Enrichment {
  text: string | null;
  secrets: SecretFinding[];
}
