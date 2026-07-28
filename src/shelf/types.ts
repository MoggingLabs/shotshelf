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
/**
 * What was in front when a capture landed.
 *
 * Read at catch time, not when a card is drawn: by then the answer is
 * "Shotshelf". Absent on platforms that cannot say without asking for a
 * permission the app promises not to need.
 */
interface CaptureContext {
  app?: string;
  title?: string;
  /** The two as one line, composed in Rust so there is only one answer. */
  label?: string;
}

export interface Capture {
  path: string;
  kind: CaptureKind;
  /** Unix milliseconds. */
  ts: number;
  context?: CaptureContext;
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

/**
 * How alarming a finding is. Mirrors `enrich::secrets::SecretKind`.
 *
 * A value rather than a bare type, so the mirroring can be asserted: both
 * sides check this list against `tests/fixtures/secret-kinds.json`. It was a
 * type alone, which meant a rename in Rust type-checked here perfectly and
 * only showed up as a warning badge in the wrong colour.
 */
export const SECRET_KINDS = [
  "privateKey",
  "serviceToken",
  "jwt",
  "assignment",
  "personalData",
] as const;

type SecretKind = (typeof SECRET_KINDS)[number];

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
  /** How alarming this is. Higher is worse. */
  severity: number;
}

/**
 * The part of an enrichment that crosses into the webview.
 *
 * Deliberately not the recognised text. That is the capture's full contents in
 * characters — every token, verbatim — and sending it alongside a masked
 * preview would defeat the masking. It stays in Rust.
 */
export interface Findings {
  secrets: SecretFinding[];
  /**
   * Whether the capture was actually read.
   *
   * False means "could not look", which is a different answer from "looked and
   * found nothing" and must never be shown as the same thing.
   */
  scanned: boolean;
}
