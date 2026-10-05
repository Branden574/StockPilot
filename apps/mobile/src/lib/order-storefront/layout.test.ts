import { describe, expect, it } from 'vitest';

import {
  CART_COLUMN_WIDTH,
  MIN_TAP,
  SHEET_MAX_WIDTH,
  catalogTitleInList,
  itemRowStacked,
  kitRowStacked,
  NOTES_FIELD_HEIGHT,
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

// iPhone 17 simulator walk, 2026-10-05: at the default text size a kit in the
// cart put its stepper and Details beside the text, which was left about
// 88 pt wide: the kit's name and "Limited by ..." broke one word per line.
describe('a kit row stacks its controls under the text when the text would be squeezed (simulator walk D1)', () => {
  const rowOn = (width: number, fontScale = 1) => storefrontLayout({ width, fontScale }).catalogWidth - 40;
  it('every iPhone width stacks a kit in the cart; Add kit and Details stay beside the text only on the widest', () => {
    for (const width of [375, 393, 402, 430]) {
      expect(kitRowStacked({ fontScale: 1, rowWidth: rowOn(width), inCart: 1, maxInCart: 3 })).toBe(true);
    }
    for (const width of [375, 393, 402]) {
      expect(kitRowStacked({ fontScale: 1, rowWidth: rowOn(width), inCart: 0, maxInCart: 3 })).toBe(true);
    }
    expect(kitRowStacked({ fontScale: 1, rowWidth: rowOn(430), inCart: 0, maxInCart: 3 })).toBe(false);
  });
  it('the 13-inch iPad catalog column keeps the controls beside the text; the iPad mini column stacks', () => {
    expect(kitRowStacked({ fontScale: 1, rowWidth: rowOn(1032), inCart: 1, maxInCart: 3 })).toBe(false);
    expect(kitRowStacked({ fontScale: 1, rowWidth: rowOn(1032), inCart: 0, maxInCart: 3 })).toBe(false);
    expect(kitRowStacked({ fontScale: 1, rowWidth: rowOn(744), inCart: 1, maxInCart: 3 })).toBe(true);
  });
  it('past the row threshold it always stacks; a width it cannot read stacks', () => {
    expect(kitRowStacked({ fontScale: 1.5, rowWidth: 2000, inCart: 0, maxInCart: 1 })).toBe(true);
    expect(kitRowStacked({ fontScale: 1, rowWidth: Number.NaN, inCart: 0, maxInCart: 1 })).toBe(true);
  });
  it('more digits in the stepper need more room', () => {
    const at = (rowWidth: number, maxInCart: number) => kitRowStacked({ fontScale: 1, rowWidth, inCart: 1, maxInCart });
    const w = 30 + 2 * MIN_TAP + stepperCountWidth(9) + 8 + 88 + 160;
    expect(at(w, 9)).toBe(false);
    expect(at(w, 99_999)).toBe(true);
  });
});

describe('Manager notes are a fixed height (simulator walk D5)', () => {
  it('taller than the old minimum, short enough that its block shows above the keyboard on an SE-width phone', () => {
    expect(NOTES_FIELD_HEIGHT).toBeGreaterThanOrEqual(96);
    expect(NOTES_FIELD_HEIGHT).toBeLessThanOrEqual(160);
  });
});

// PO-4 review / desk check F8.4 (walk shot M23-iphone-iphone-ax5-search-
// keyboard.png): at AX5 the title and the search were pinned above the list,
// and with the keyboard up less than one row of results showed.
describe('the catalog’s title scrolls with the list past the row threshold (PO-4 review, F8.4)', () => {
  it('pinned at the usual sizes; in the list at the accessibility sizes', () => {
    expect(catalogTitleInList(1)).toBe(false);
    expect(catalogTitleInList(1.4)).toBe(false);
    expect(catalogTitleInList(1.6)).toBe(true);
    expect(catalogTitleInList(3.1)).toBe(true);
  });
});
