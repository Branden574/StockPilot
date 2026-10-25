import { describe, expect, it } from 'vitest';

import {
  FOOTER_CLEARANCE,
  ITEM_TAB_WIDEST_LABEL_EM,
  LONGEST_STOCK_PILL_CHARS,
  ROW_STACK_FONT_SCALE,
  TRAILING_COLUMN_MAX_WIDTH,
  footerReservation,
  itemTabLabelRoom,
  itemTabLabelSize,
  itemTabStackedLabelRoom,
  pillWidth,
  shouldStackItemTabs,
  shouldStackRow,
} from './dynamic-type-layout';

describe('shouldStackRow', () => {
  it('keeps a multi-column row side-by-side at default text size', () => {
    expect(shouldStackRow(1)).toBe(false);
  });

  it('keeps it side-by-side through the non-accessibility sizes', () => {
    // iOS Larger Text tops out at 1.35x before the AX sizes begin.
    for (const scale of [0.882, 0.941, 1, 1.118, 1.235, 1.35]) {
      expect(shouldStackRow(scale)).toBe(false);
    }
  });

  it('stacks once past the threshold', () => {
    expect(shouldStackRow(ROW_STACK_FONT_SCALE + 0.01)).toBe(true);
    // The iOS accessibility ramp: AX1 1.643 … AX5 3.571.
    for (const scale of [1.643, 1.929, 2.286, 2.643, 3.571]) {
      expect(shouldStackRow(scale)).toBe(true);
    }
  });

  it('treats the threshold itself as "still fits" (strictly greater, per plan)', () => {
    expect(shouldStackRow(ROW_STACK_FONT_SCALE)).toBe(false);
  });

  it('sits between the last non-accessibility size and AX1, so ONE threshold serves every screen', () => {
    // Follow-ups 1-2 (viewfinder chrome, and long item names breaking per
    // character) both reuse this single threshold rather than adding a second
    // breakpoint. That only holds while it stays in the gap: raise it past
    // 1.643 and the Items/Books rows silently stop stacking at AX1-AX2, which
    // is exactly where `Sunglasse/s` was reported.
    expect(ROW_STACK_FONT_SCALE).toBeGreaterThan(1.35);
    expect(ROW_STACK_FONT_SCALE).toBeLessThan(1.643);
  });

  it('stacks at both reported repro sizes', () => {
    // AX3 — the Items/Books row where `Sunglasses` broke mid-word.
    expect(shouldStackRow(2.286)).toBe(true);
    // AX5 — the size-count viewfinder chrome that overlapped its hint copy.
    expect(shouldStackRow(3.571)).toBe(true);
  });

  it('honours a caller-supplied threshold', () => {
    expect(shouldStackRow(1.2, 1.1)).toBe(true);
    expect(shouldStackRow(1.2, 1.3)).toBe(false);
  });

  it('falls back to "does not stack" for a missing or nonsense scale', () => {
    // useWindowDimensions().fontScale is always a number on device, but a
    // stacked layout appearing because of a NaN would be a silent regression
    // for every default-size user, so the degenerate cases pin to false.
    expect(shouldStackRow(undefined)).toBe(false);
    expect(shouldStackRow(null)).toBe(false);
    expect(shouldStackRow(Number.NaN)).toBe(false);
    expect(shouldStackRow(0)).toBe(false);
    expect(shouldStackRow(-1)).toBe(false);
    expect(shouldStackRow(Number.POSITIVE_INFINITY)).toBe(false);
  });
});

describe('footerReservation', () => {
  it('uses the hand-tuned fallback until the footer has been measured', () => {
    expect(footerReservation(null, 140)).toBe(140);
    expect(footerReservation(0, 140)).toBe(140);
  });

  it('never reserves less than the fallback', () => {
    // A measured 95pt footer + clearance is still under the old constant; the
    // constant was correct at default size, so it stays the floor and this
    // change can only ever ADD room, never take it away.
    expect(footerReservation(95, 140)).toBe(140);
  });

  it('grows past the fallback once the footer outgrows it', () => {
    expect(footerReservation(160, 140)).toBe(160 + FOOTER_CLEARANCE);
    // The reported AX5 case: a 3-line "Sync pending edits to post" footer.
    expect(footerReservation(170, 140)).toBeGreaterThan(170);
  });

  it('clears the footer by the full clearance at every measured height', () => {
    for (let h = 1; h <= 400; h += 1) {
      expect(footerReservation(h, 140)).toBeGreaterThanOrEqual(h + FOOTER_CLEARANCE);
    }
  });

  it('ignores a nonsense measurement rather than reserving NaN', () => {
    expect(footerReservation(Number.NaN, 140)).toBe(140);
    expect(footerReservation(Number.POSITIVE_INFINITY, 140)).toBe(140);
    expect(footerReservation(-20, 140)).toBe(140);
  });

  it('honours a caller-supplied clearance', () => {
    expect(footerReservation(200, 140, 0)).toBe(200);
    expect(footerReservation(200, 140, 50)).toBe(250);
  });
});

describe('pillWidth', () => {
  it('measures the longest stock pill at default text size', () => {
    // `ARCHIVED` / `EXPECTED`: 32pt of fixed chrome (1pt border + 9pt padding a
    // side, a 6pt dot and the 6pt gap after it) plus 8 monospace advances of
    // 0.6em at 10.5pt with 0.4pt of tracking each.
    expect(pillWidth(LONGEST_STOCK_PILL_CHARS, 1)).toBeCloseTo(85.6, 5);
  });

  it('scales only the glyph advances — tracking, padding, dot and border are points', () => {
    // letterSpacing is applied in UNSCALED points on iOS (NSKernAttributeName),
    // and none of the box chrome scales with text either.
    const fixed = 32 + LONGEST_STOCK_PILL_CHARS * 0.4;
    // 1.4 rather than 2: past 1.904 the Pill's own label cap binds instead.
    expect(pillWidth(LONGEST_STOCK_PILL_CHARS, 1.4) - fixed).toBeCloseTo(
      1.4 * (pillWidth(LONGEST_STOCK_PILL_CHARS, 1) - fixed),
      5,
    );
  });

  it('stops growing at the Pill label’s own chrome ceiling', () => {
    // ui/pill.tsx caps its label at capTo(10.5, TYPE_CEILING.chrome) = 1.904x,
    // so reserving width for AX5 would reserve width the pill can never use.
    expect(pillWidth(8, 3.571)).toBeCloseTo(pillWidth(8, 20 / 10.5), 5);
  });

  it('is monotonic in both characters and scale', () => {
    for (let chars = 1; chars <= 16; chars += 1) {
      expect(pillWidth(chars + 1, 1)).toBeGreaterThan(pillWidth(chars, 1));
    }
    for (let scale = 1; scale <= 1.9; scale += 0.05) {
      expect(pillWidth(8, scale + 0.01)).toBeGreaterThan(pillWidth(8, scale));
    }
  });

  it('treats a missing or nonsense scale as default size, never smaller', () => {
    const atDefault = pillWidth(8, 1);
    for (const scale of [undefined, null, Number.NaN, 0, -1, 0.5]) {
      expect(pillWidth(8, scale)).toBe(atDefault);
    }
  });
});

describe('TRAILING_COLUMN_MAX_WIDTH', () => {
  it('is a point ceiling, not a percentage', () => {
    // The whole defect: `maxWidth: '40%'` resolves against whatever box the
    // column is currently parented to, so wrapping the name and the trailing
    // column in a `bodyRow` silently re-based it.
    expect(typeof TRAILING_COLUMN_MAX_WIDTH).toBe('number');
    expect(Number.isInteger(TRAILING_COLUMN_MAX_WIDTH)).toBe(true);
  });

  it('holds the longest stock pill on ONE line at every unstacked size', () => {
    // Past ROW_STACK_FONT_SCALE the row stacks and `trailingColStacked` hands
    // the column the full width, so this ceiling only has to survive up to and
    // including the threshold itself (shouldStackRow is strictly greater).
    for (let scale = 1; scale <= ROW_STACK_FONT_SCALE; scale += 0.01) {
      expect(TRAILING_COLUMN_MAX_WIDTH).toBeGreaterThanOrEqual(
        pillWidth(LONGEST_STOCK_PILL_CHARS, scale),
      );
    }
    expect(TRAILING_COLUMN_MAX_WIDTH).toBeGreaterThanOrEqual(
      pillWidth(LONGEST_STOCK_PILL_CHARS, ROW_STACK_FONT_SCALE),
    );
  });

  it('clears every measured percentage ceiling that fractured the badge', () => {
    // Measured against the real files. `maxWidth: '40%'` of the bodyRow box:
    //   Books   393pt device -> 87pt, 375pt -> 80pt
    //   Items   393pt device -> 100pt, 84pt in select mode; 375pt -> 92pt / 77pt
    // An 8-character pill needs 85.6pt at DEFAULT size, so 84, 80 and 77 all
    // clamped it, and `ARCHIVED` has no break opportunity: iOS broke the glyph
    // run inside the badge.
    for (const brokenCeiling of [77, 80, 84, 87, 92, 100]) {
      expect(TRAILING_COLUMN_MAX_WIDTH).toBeGreaterThan(brokenCeiling);
    }
  });

  it('never gives the trailing column more room than the pre-wrapper ceiling did', () => {
    // The ceilings this replaces, measured as 40% of the ROW's content box:
    // 128pt (Items, 393pt), 122pt (Items and Books, 375pt), 129pt (Books,
    // 393pt). Staying under the tightest of them means the item NAME — which
    // section 3 keeps uncapped and reflowing — gains width at every size
    // rather than losing it.
    expect(TRAILING_COLUMN_MAX_WIDTH).toBeLessThanOrEqual(122);
  });
});

/**
 * The item screen's tabs (docket B10): Movements was cut to "MOVEMEN…" at
 * larger text, then (redesign) shrunk below the user's size to fit. Neither is
 * allowed: past the width the label needs, the tabs stack.
 *
 * iOS text sizes as RN's fontScale: Large (default) 1, xLarge 1.118, xxLarge
 * 1.235, xxxLarge 1.353, AX1 1.786 and up. Phone widths in points: 320
 * (Display Zoom on a small phone), 375, 390, 393, 402, 430, 440; iPad mini
 * portrait 744.
 */
describe('shouldStackItemTabs', () => {
  const PHONES = [320, 375, 390, 393, 402, 430, 440];

  it('keeps the tabs side by side at the default size on every phone', () => {
    for (const width of PHONES) expect(shouldStackItemTabs(width, 1), `${width}pt`).toBe(false);
  });

  it('keeps them side by side through xLarge and xxLarge on a 375pt phone and wider', () => {
    for (const width of PHONES.filter((w) => w >= 375)) {
      for (const scale of [1.118, 1.235]) {
        expect(shouldStackItemTabs(width, scale), `${width}pt at ${scale}`).toBe(false);
      }
    }
  });

  it('stacks them at the ceiling on every phone, where Movements needs about 117pt', () => {
    for (const width of PHONES) {
      for (const scale of [1.786, 2.143, 3.571]) {
        expect(shouldStackItemTabs(width, scale), `${width}pt at ${scale}`).toBe(true);
      }
    }
  });

  it('keeps them side by side on an iPad at every size', () => {
    for (const scale of [1, 1.353, 1.786, 3.571])
      expect(shouldStackItemTabs(744, scale)).toBe(false);
  });

  it('stacks exactly when the label is wider than its segment', () => {
    // 390pt at xxxLarge: Movements needs 93.8pt of a 93.3pt segment.
    expect(itemTabLabelRoom(390)).toBeCloseTo(93.333, 3);
    expect(ITEM_TAB_WIDEST_LABEL_EM * itemTabLabelSize(1.353)).toBeCloseTo(93.77, 2);
    expect(shouldStackItemTabs(390, 1.353)).toBe(true);
    // 393pt at the same size: a 94.3pt segment holds it.
    expect(shouldStackItemTabs(393, 1.353)).toBe(false);
  });

  it('a stacked label has room for Movements at the ceiling on the narrowest screen', () => {
    expect(itemTabStackedLabelRoom(320)).toBe(254);
    expect(ITEM_TAB_WIDEST_LABEL_EM * itemTabLabelSize(99)).toBeLessThanOrEqual(
      itemTabStackedLabelRoom(320),
    );
  });

  it('the label grows with the text and stops at 22pt', () => {
    expect(itemTabLabelSize(1)).toBe(13);
    expect(itemTabLabelSize(1.5)).toBeCloseTo(19.5, 10);
    expect(itemTabLabelSize(1.786)).toBeCloseTo(22, 10);
    expect(itemTabLabelSize(3.571)).toBeCloseTo(22, 10);
    expect(itemTabLabelSize(0.823)).toBeCloseTo(10.699, 3);
  });

  it('treats a bad measurement as the default size and a side-by-side row', () => {
    for (const bad of [Number.NaN, 0, -1, Number.POSITIVE_INFINITY, null, undefined]) {
      expect(itemTabLabelSize(bad)).toBe(13);
      expect(shouldStackItemTabs(bad, 3.571)).toBe(false);
    }
  });
});
