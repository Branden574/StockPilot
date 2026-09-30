import { describe, expect, it } from 'vitest';

import { EXCEPTION_SHEET_MIN_HEIGHT, EXCEPTION_SHEET_TOP_GAP, exceptionSheetLayout } from './exception-sheet-layout';

/**
 * The Acknowledge / Add note / Confirm this count sheet's size (review
 * 2026-09-29). The body was a fixed 420 pt; with the title, the reason lines
 * and two 52 pt buttons outside it, a 375 x 667 iPhone SE at AX5, or any
 * phone with the keyboard up, pushed the sheet off the top of the screen and
 * took the title, Close and the numbers with it. Now the sheet is never taller
 * than the space the keyboard leaves, below the status bar, and the body (the
 * part that scrolls) gives way first.
 */

describe('exceptionSheetLayout', () => {
  it('keyboard down: the sheet may use the screen below the status bar; the body takes at most 45% of the window', () => {
    // iPhone SE (375 x 667, 20 pt status bar).
    expect(exceptionSheetLayout({ windowHeight: 667, availableHeight: 667, topInset: 20 })).toEqual({
      sheetMaxHeight: 667 - 20 - EXCEPTION_SHEET_TOP_GAP,
      bodyMaxHeight: Math.round(667 * 0.45),
    });
  });

  it('keyboard up: the sheet shrinks to the space above it, and the body with it', () => {
    // The keyboard-avoiding wrapper leaves 667 - 260 = 407 pt.
    const l = exceptionSheetLayout({ windowHeight: 667, availableHeight: 407, topInset: 20 });
    expect(l.sheetMaxHeight).toBe(407 - 20 - EXCEPTION_SHEET_TOP_GAP);
    expect(l.bodyMaxHeight).toBeLessThanOrEqual(l.sheetMaxHeight);
    expect(l.bodyMaxHeight).toBe(Math.round(407 * 0.45));
  });

  it('before the first layout pass it uses the window', () => {
    expect(exceptionSheetLayout({ windowHeight: 844, availableHeight: null, topInset: 47 })).toEqual({
      sheetMaxHeight: 844 - 47 - EXCEPTION_SHEET_TOP_GAP,
      bodyMaxHeight: Math.round(844 * 0.45),
    });
  });

  it('never collapses: a floor keeps the header and the buttons', () => {
    const l = exceptionSheetLayout({ windowHeight: 320, availableHeight: 90, topInset: 20 });
    expect(l.sheetMaxHeight).toBe(EXCEPTION_SHEET_MIN_HEIGHT);
    expect(l.bodyMaxHeight).toBeGreaterThan(0);
    expect(l.bodyMaxHeight).toBeLessThanOrEqual(l.sheetMaxHeight);
  });

  it('a tall window: the body is its share of the window, inside the sheet', () => {
    // An iPad-sized window.
    const l = exceptionSheetLayout({ windowHeight: 1366, availableHeight: 1366, topInset: 24 });
    expect(l.bodyMaxHeight).toBe(Math.round(1366 * 0.45));
    expect(l.sheetMaxHeight).toBe(1366 - 24 - EXCEPTION_SHEET_TOP_GAP);
  });

  it('whole points, never NaN', () => {
    for (const [w, a, t] of [
      [667.5, 407.3, 20.2],
      [0, 0, 0],
      [Number.NaN, null, 20],
    ] as [number, number | null, number][]) {
      const l = exceptionSheetLayout({ windowHeight: w, availableHeight: a, topInset: t });
      expect(Number.isInteger(l.sheetMaxHeight)).toBe(true);
      expect(Number.isInteger(l.bodyMaxHeight)).toBe(true);
    }
  });
});
