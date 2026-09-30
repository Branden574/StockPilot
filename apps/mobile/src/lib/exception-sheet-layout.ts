/**
 * THE SIZE OF THE EXCEPTION SHEETS (Acknowledge, Add note, Confirm this
 * count; review 2026-09-29. Add a photo and Remove this photo? since the R1
 * walk, where a fixed 460 pt body ran them off the top at AX5 with the
 * keyboard up).
 *
 * The sheet is pinned to the bottom of the screen, so anything taller than the
 * space it has runs off the TOP, taking the title, Close and the confirm's
 * numbers with it. A fixed 420 pt body did exactly that on a 375 x 667 iPhone
 * SE at AX5, and on any phone with the keyboard up. So:
 *
 *   - the sheet is never taller than the space the keyboard-avoiding wrapper
 *     leaves (`availableHeight`, measured), below the status bar or Dynamic
 *     Island (`topInset`) and a small gap;
 *   - the body, the one part that scrolls, is at most 45% of that space (the
 *     approve-partial sheet's share of the window), and it also shrinks
 *     (flexShrink) whenever the title, the reason lines and the buttons need
 *     the room, so they stay on screen.
 *
 * Fixed pixel sizes off the window, never percentages: percentage sizing
 * collapsed layouts under Fabric (edit-order-line-sheet.tsx). Pure, so it is
 * tested without a device.
 */

/** Space kept between the status bar (or Dynamic Island) and the sheet. */
export const EXCEPTION_SHEET_TOP_GAP = 12;
/** The smallest the sheet is sized to, so the header and the buttons always
 *  fit even in a window too short for the rest. */
export const EXCEPTION_SHEET_MIN_HEIGHT = 200;
/** The smallest body cap, so the note field never collapses to nothing. */
const MIN_BODY = 80;
/** The body's share of the space (approve-partial-sheet.tsx uses 0.45). */
const BODY_SHARE = 0.45;

function finite(n: number | null): number | null {
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

export function exceptionSheetLayout(input: {
  /** useWindowDimensions().height. */
  windowHeight: number;
  /** The measured height the keyboard-avoiding wrapper leaves; null before
   *  the first layout pass. */
  availableHeight: number | null;
  /** The safe-area top inset. */
  topInset: number;
}): { sheetMaxHeight: number; bodyMaxHeight: number } {
  const space = Math.max(0, finite(input.availableHeight) ?? finite(input.windowHeight) ?? 0);
  const top = Math.max(0, finite(input.topInset) ?? 0);
  const sheetMaxHeight = Math.round(Math.max(EXCEPTION_SHEET_MIN_HEIGHT, space - top - EXCEPTION_SHEET_TOP_GAP));
  const bodyMaxHeight = Math.round(Math.min(sheetMaxHeight, Math.max(MIN_BODY, space * BODY_SHARE)));
  return { sheetMaxHeight, bodyMaxHeight };
}
