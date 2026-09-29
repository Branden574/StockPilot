import { TYPE_CEILING, capTo } from './theme';

/**
 * The digital pick's quantity field (components/digital-pick.tsx).
 *
 * It was a fixed 84pt box whose 16pt text was not capped, so at the largest
 * accessibility text size (AX5, about 3.57x) "30" showed as "3" (F2-2 walk).
 * The typed quantity is a TextInput in a bordered box, so it stops growing at
 * the input ceiling (TYPE_CEILING.input, 24pt; the same cap ui/field.tsx
 * uses), and the box is at least as wide as three digits at that size.
 */

/** The typed quantity's size (JetBrains Mono) before Dynamic Type. */
export const PICK_QTY_FONT_SIZE = 16;

/** Stops the typed quantity at the input ceiling: 16pt grows to 24pt, no further. */
export const PICK_QTY_MAX_FONT_SIZE_MULTIPLIER = capTo(PICK_QTY_FONT_SIZE, TYPE_CEILING.input);

/** Digits the field shows in full at every text size. */
export const PICK_QTY_DIGITS = 3;

// JetBrains Mono advances every glyph 0.6em.
const MONO_ADVANCE_EM = 0.6;
// The field's horizontal padding and border (each side), and room for the caret.
const PADDING_X = 12;
const BORDER = 1;
const CARET = 2;
// The field's width before this change; it never gets narrower.
const FLOOR = 84;

/** The field's width for `digits` digits at the largest the text renders (the cap). */
export function pickQtyFieldWidthFor(digits: number): number {
  const largest = PICK_QTY_FONT_SIZE * PICK_QTY_MAX_FONT_SIZE_MULTIPLIER;
  const needed = 2 * (PADDING_X + BORDER) + CARET + digits * MONO_ADVANCE_EM * largest;
  return Math.max(FLOOR, Math.ceil(needed));
}

/**
 * The field's minimum width: three digits at the capped size (84pt, the width
 * it always had, which holds them once the text is capped). A minimum, not a
 * fixed width, so a longer quantity can widen the field.
 */
export const PICK_QTY_FIELD_MIN_WIDTH = pickQtyFieldWidthFor(PICK_QTY_DIGITS);

/** The field's horizontal padding, as the width above assumes it. */
export const PICK_QTY_PADDING_X = PADDING_X;
