import { describe, expect, it } from 'vitest';

import {
  CART_COLUMN_WIDTH,
  MIN_TAP,
  SHEET_MAX_WIDTH,
  itemRowStacked,
  stepperCountWidth,
  storefrontLayout,
  storefrontLayoutKind,
} from './layout';

/**
 * The storefront's shape, over the widths the app runs at (iPhone SE-width
 * 375, iPhone 17 393, Pro Max 430, iPad mini 744, iPad Air 820, iPad 13-inch
 * 1032; portrait only) and the text sizes that matter (default, just under
 * and at the 1.4 threshold, AX1-ish 1.5, AX5 3.57).
 */
const WIDTHS = [375, 393, 430, 744, 820, 1032];
const SCALES = [1.0, 1.35, 1.4, 1.5, 3.57];

describe('split or phone', () => {
  for (const width of WIDTHS) {
    for (const fontScale of SCALES) {
      const expected = width >= 700 && fontScale <= 1.4 ? 'split' : 'phone';
      it(`${width} pt at ${fontScale}x is ${expected}`, () => {
        expect(storefrontLayoutKind({ width, fontScale })).toBe(expected);
        const layout = storefrontLayout({ width, fontScale });
        expect(layout.kind).toBe(expected);
        expect(layout.cartColumnWidth).toBe(expected === 'split' ? CART_COLUMN_WIDTH : 0);
        expect(layout.catalogWidth + layout.cartColumnWidth).toBe(width);
        expect(layout.sheetWidth).toBe(Math.min(width, SHEET_MAX_WIDTH));
        expect(layout.readingWidth).toBeLessThanOrEqual(640);
        expect(layout.readingWidth).toBe(Math.min(width - 40, 640));
      });
    }
  }

  it('a width or scale it cannot read is the phone layout', () => {
    expect(storefrontLayoutKind({ width: Number.NaN, fontScale: 1 })).toBe('phone');
    expect(storefrontLayoutKind({ width: 1032, fontScale: Number.NaN })).toBe('split');
    expect(storefrontLayout({ width: 0, fontScale: 1 }).readingWidth).toBe(0);
  });
});

describe('rows and steppers', () => {
  it('an item row stacks its control past the 1.4 threshold', () => {
    expect(itemRowStacked(1.4)).toBe(false);
    expect(itemRowStacked(1.5)).toBe(true);
    expect(itemRowStacked(3.57)).toBe(true);
  });

  it('the stepper count is at least 44 pt and grows with the digits available', () => {
    expect(stepperCountWidth(5)).toBeGreaterThanOrEqual(MIN_TAP);
    expect(stepperCountWidth(10_000)).toBeGreaterThan(stepperCountWidth(5));
    expect(stepperCountWidth(-3)).toBeGreaterThanOrEqual(MIN_TAP);
  });
});
