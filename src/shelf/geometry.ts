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
/** Vertical space between cards. */
export const CARD_GAP = 9;
/** The column's padding plus the panel border, top and bottom together. */
export const COLUMN_PADDING = 24;
/** Beyond this the column scrolls rather than growing off the screen. */
export const COLUMN_MAX_CARDS = 5;
/** Floor for the window height, so an empty column is never a slit. */
export const MIN_COLUMN_HEIGHT = 80;

/**
 * Window height the column needs for a given number of cards.
 *
 * Always sized for at least one card: the column is only ever on screen
 * because something landed in it, and a request for zero is a race between a
 * card expiring and the resize that follows, not a real empty column.
 */
export function columnHeight(cards: number): number {
  const shown = Math.min(Math.max(cards, 1), COLUMN_MAX_CARDS);
  return shown * CARD_HEIGHT + (shown - 1) * CARD_GAP + COLUMN_PADDING;
}
