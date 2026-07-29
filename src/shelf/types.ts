/**
 * The vocabulary the shelf is built from.
 *
 * Deliberately free of DOM types. The store and the column queue reason about
 * captures without ever touching an element, which is what lets them be tested
 * in Node with no browser at all — and what stops view state from leaking into
 * the data it is showing.
 */

export type CaptureKind = "image" | "video";

/**
 * What was in front when a capture landed.
 *
 * Read at catch time, not when a card is drawn: by then the answer is
 * "Shotshelf". Absent on platforms that cannot say without asking for a
 * permission the app promises not to need.
 */
interface CaptureContext {
  /**
   * The app and the window title as one line, composed in Rust so there is
   * only one answer.
   *
   * The only field. `app` and `title` were declared here too, mirroring two
   * Rust fields that nothing read on either side — so every capture carried
   * two extra strings of whatever was on screen across the IPC boundary for
   * no reader at all.
   */
  label?: string;
}

/** Payload of the Rust `capture://new` event. */
export interface Capture {
  path: string;
  kind: CaptureKind;
  /** Unix milliseconds. */
  ts: number;
  context?: CaptureContext;
}

/**
 * Whether a capture can be marked up or looked at full size.
 *
 * A recording can be neither: a still frame blown up is not a preview of a
 * video, playing one makes this a media player rather than a shelf, and there
 * is nothing to annotate on a clip.
 *
 * Named because the rule was written out at five sites — the Edit control, the
 * keyboard path, `openEditor`, `showPreview` and the card — as
 * `kind === "video"`, plus one inverted `kind === "image"` that is equivalent
 * only because `CaptureKind` happens to have exactly two members. Add a third
 * and the Edit control hides itself, reading "not an image", while `openEditor`
 * accepts it. That is the same defect `allowed_pins` was extracted to fix on
 * the Rust side: one rule, several copies, and a fix that lands in some of
 * them.
 */
export function isEditable(item: Pick<ShelfItem, "kind">): boolean {
  return item.kind === "image";
}

/** Same rule, different question — see {@link isEditable}. */
export function canPreview(item: Pick<ShelfItem, "kind">): boolean {
  return item.kind === "image";
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
 * `preview` is masked on the Rust side and must stay that way. What that buys
 * is the opposite of a prohibition: because it is masked, it is the one part of
 * a finding that *can* be shown, and `view/secrets.ts` puts it in the card's
 * tooltip so "a token is in this screenshot" can be answered with "which one".
 *
 * This used to say that putting it in a tooltip would defeat the point, which
 * described the raw value rather than this field and forbade the only thing any
 * consumer does with it. The rule that actually holds: nothing on this side may
 * reconstruct or transmit an unmasked value, and nothing here ever receives one
 * — `enrich::Findings` carries no recognised text, and a Rust test pins its key
 * set so it cannot start.
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
