/**
 * Card metrics, and the one sum that depends on them.
 *
 * These numbers are mirrored in the CSS, and the mirror is load-bearing: the
 * auto-popup column is a window sized to exactly the cards it holds, so if the
 * stylesheet and this file disagree the window stops matching its contents —
 * either clipping the last card or trailing empty space below it.
 *
 * The popover is 225 wide with 12px of padding either side and a 1px border,
 * so a card is 199 across; at 16:9 that is 112 tall.
 */

/** Rendered height of one card, in CSS pixels. */
export const CARD_HEIGHT = 112;
/** Vertical space between cards — the grid gap, on the 4px spacing grid. */
export const CARD_GAP = 8;
/** The column's padding plus the panel border, top and bottom together:
 *  12px of padding each way plus the 1px border each way. */
export const COLUMN_PADDING = 26;
/** Beyond this the column scrolls rather than growing off the screen. */
export const COLUMN_MAX_CARDS = 5;


/**
 * Window height the column needs for a given number of cards.
 *
 * Always sized for at least one card: the column is only ever on screen
 * because something landed in it, and a request for zero is a race between a
 * card expiring and the resize that follows, not a real empty column.
 *
 * `alsoShowing` is the height of anything in the column that is not a card —
 * today only the alert strip. It is *measured* by the caller rather than being
 * a constant here, because the strip's height depends on how far its message
 * wraps, and no number in this file can know that.
 *
 * Without the term, making the strip visible in the column took its space out
 * of the cards: `.shelf__alert` is `flex: none` and `.shelf__body` is
 * `flex: 1`, inside a window still sized to 136px for one card. The message
 * became readable and clipped the capture it was about, which is a poor trade
 * for a message that is usually about that capture.
 */
export function columnHeight(cards: number, alsoShowing = 0): number {
  // Zero cards is a real answer now, not a race.
  //
  // The floor used to be one, justified by "the column is only ever on screen
  // because something landed in it". `Popover.showProblem` made that false: a
  // capture that was *lost* raises a column with a message and no card, and the
  // floor put that message at the bottom of 136px of nothing.
  //
  // Still floored at one when there is nothing else to show, because a window
  // of pure padding is not a window anyone wants either.
  if (cards <= 0 && alsoShowing > 0) return COLUMN_PADDING + alsoShowing;

  const shown = Math.min(Math.max(cards, 1), COLUMN_MAX_CARDS);
  return shown * CARD_HEIGHT + (shown - 1) * CARD_GAP + COLUMN_PADDING + alsoShowing;
}
