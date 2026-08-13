import { describe, expect, it } from 'vitest';

import {
  formatPlacementLabel,
  placementPhysicalNames,
  resolvePlacement,
  type PlacementInput,
} from './placement-resolution';

const label = (input: PlacementInput) => formatPlacementLabel(resolvePlacement(input));

describe('resolvePlacement — the precedence', () => {
  it('falls through to the structured rack when nothing contradicts it', () => {
    expect(
      resolvePlacement({
        itemType: 'product',
        customFields: { rack_number: '38', rack_row: 'A' },
        binLocation: '38-A',
        siteName: 'DC4',
      }),
    ).toEqual({ source: 'structured', rackLabel: '38-A', crateLabel: null });
  });

  it('reads the BOOK key family for books and the neutral pair for everything else', () => {
    const cf = {
      book_rack_number: '39',
      book_rack_row: 'B',
      book_crate_color: 'red',
      book_crate_number: '5',
      rack_number: '2',
      rack_row: 'C',
    };
    expect(resolvePlacement({ itemType: 'book', customFields: cf })).toEqual({
      source: 'structured',
      rackLabel: '39-B',
      crateLabel: 'Red 5',
    });
    expect(resolvePlacement({ itemType: 'product', customFields: cf })).toEqual({
      source: 'structured',
      rackLabel: '2-C',
      // A non-book has no crate SUMMARY — book_crate_* are book-scoped keys,
      // so reading them for a Chromebook would invent a crate it never had.
      crateLabel: null,
    });
  });

  it('falls to bin_location, then the site, then nothing', () => {
    const base = { itemType: 'product', customFields: {} } as const;
    expect(resolvePlacement({ ...base, binLocation: 'Blue Shelf', siteName: 'DC4' })).toEqual({
      source: 'bin',
      binLocation: 'Blue Shelf',
    });
    expect(resolvePlacement({ ...base, siteName: 'DC4' })).toEqual({
      source: 'site',
      siteName: 'DC4',
    });
    expect(resolvePlacement(base)).toEqual({ source: 'none' });
  });

  it('treats a whitespace-only bin_location or site as absent', () => {
    expect(
      resolvePlacement({
        itemType: 'product',
        customFields: {},
        binLocation: '   ',
        siteName: '\t',
      }),
    ).toEqual({ source: 'none' });
  });
});

describe('resolvePlacement — rule 0a: SPLIT stock outranks the label', () => {
  it('prefers the breakdown when stock sits on more than one holding', () => {
    const res = resolvePlacement({
      itemType: 'product',
      customFields: { rack_number: '2', rack_row: 'C' },
      holdings: [
        { name: '5-A', quantity: 5, kind: 'rack' },
        { name: '2-C', quantity: 20, kind: 'rack' },
      ],
    });
    expect(res.source).toBe('holdings');
    expect(res).toMatchObject({ reason: 'split' });
    expect(formatPlacementLabel(res)).toBe('2-C ×20 · 5-A ×5');
  });

  it('splits on holdings the caller carried NO kind for — the split rule never needed it', () => {
    const res = resolvePlacement({
      itemType: 'product',
      customFields: { rack_number: '2', rack_row: 'C' },
      holdings: [
        { name: '5-A', quantity: 5 },
        { name: '2-C', quantity: 20 },
      ],
    });
    expect(formatPlacementLabel(res)).toBe('2-C ×20 · 5-A ×5');
  });
});

describe('resolvePlacement — rule 0b: a CRATE outranks the item rack keys (0335)', () => {
  // The defect this module was extracted to kill. A put-away into a
  // position-less crate PRESERVES book_rack_*/rack_* on purpose, so those keys
  // outlive the stock: a Chromebook whose units have all moved into "Blue
  // Shelf" still carries rack 38-A, and every formatter that preferred the
  // pair walked a picker to an aisle the stock had left.

  it('prints the CRATE, not the departed rack, for a non-book', () => {
    const input: PlacementInput = {
      itemType: 'product',
      customFields: { rack_number: '38', rack_row: 'A' },
      binLocation: 'Blue Shelf',
      siteName: 'DC4',
      holdings: [{ name: 'Blue Shelf', quantity: 12, kind: 'crate' }],
    };
    expect(resolvePlacement(input)).toMatchObject({ source: 'holdings', reason: 'crate' });
    expect(label(input)).toBe('Blue Shelf ×12');
    expect(label(input)).not.toContain('38-A');
  });

  it('prints the CRATE for a book whose rack keys still name its previous rack', () => {
    const input: PlacementInput = {
      itemType: 'book',
      customFields: {
        book_rack_number: '40',
        book_rack_row: 'B',
        book_crate_color: 'gray',
        book_crate_number: 'BIN',
      },
      binLocation: 'Gray #BIN',
      siteName: 'DC4',
      holdings: [{ name: 'Gray #BIN', quantity: 5, kind: 'crate' }],
    };
    expect(label(input)).toBe('Gray #BIN ×5');
    // The exact string the regression printed on a pick slip.
    expect(label(input)).not.toBe('Rack 40-B · Crate Gray BIN');
  });

  it('a POSITIONED crate loses NOTHING — the holding name carries the rack', () => {
    // Do not over-correct: the position is not dropped, it is carried by
    // formatCrateLocationName inside the holding's own name.
    expect(
      label({
        itemType: 'book',
        customFields: { book_rack_number: '43', book_rack_row: 'B' },
        binLocation: 'Gray #BIN on rack 43-B',
        siteName: 'DC4',
        holdings: [{ name: 'Gray #BIN on rack 43-B', quantity: 5, kind: 'crate' }],
      }),
    ).toBe('Gray #BIN on rack 43-B ×5');
  });

  it('a single RACK holding keeps the structured label — the narrowing is crates only', () => {
    expect(
      resolvePlacement({
        itemType: 'product',
        customFields: { rack_number: '38', rack_row: 'A' },
        holdings: [{ name: '38-A', quantity: 12, kind: 'rack' }],
      }),
    ).toEqual({ source: 'structured', rackLabel: '38-A', crateLabel: null });
  });

  it('a holding with an UNKNOWN kind keeps the old precedence rather than guessing', () => {
    // `kind === 'crate'` is a positive assertion. A caller that did not carry
    // kinds must not have a rack label suppressed on the strength of missing
    // data — that is how "additive" stays true.
    for (const kind of [undefined, null, '']) {
      expect(
        resolvePlacement({
          itemType: 'product',
          customFields: { rack_number: '38', rack_row: 'A' },
          holdings: [{ name: 'Blue Shelf', quantity: 12, kind }],
        }),
      ).toEqual({ source: 'structured', rackLabel: '38-A', crateLabel: null });
    }
  });

  it('a crate alongside a rack is the SPLIT rule, not the crate rule', () => {
    expect(
      label({
        itemType: 'product',
        customFields: { rack_number: '38', rack_row: 'A' },
        holdings: [
          { name: 'Blue Shelf', quantity: 4, kind: 'crate' },
          { name: '38-A', quantity: 8, kind: 'rack' },
        ],
      }),
    ).toBe('38-A ×8 · Blue Shelf ×4');
  });

  it('a crate wins even when the item carries no structured rack at all', () => {
    expect(
      label({
        itemType: 'product',
        customFields: {},
        binLocation: 'Blue Shelf',
        siteName: 'DC4',
        holdings: [{ name: 'Blue Shelf', quantity: 12, kind: 'crate' }],
      }),
    ).toBe('Blue Shelf ×12');
  });
});

describe('placementPhysicalNames — what the guard compares', () => {
  it('strips quantities and prose down to the names a picker walks to', () => {
    expect(
      placementPhysicalNames(
        resolvePlacement({
          itemType: 'product',
          customFields: {},
          holdings: [
            { name: '5-A', quantity: 5, kind: 'rack' },
            { name: '2-C', quantity: 20, kind: 'rack' },
          ],
        }),
      ),
    ).toEqual(['2-C', '5-A']);
    expect(
      placementPhysicalNames(
        resolvePlacement({ itemType: 'product', customFields: { rack_number: '38', rack_row: 'A' } }),
      ),
    ).toEqual(['38-A']);
    expect(
      placementPhysicalNames(
        resolvePlacement({ itemType: 'product', customFields: {}, binLocation: 'Blue Shelf' }),
      ),
    ).toEqual(['Blue Shelf']);
    expect(
      placementPhysicalNames(resolvePlacement({ itemType: 'product', customFields: {} })),
    ).toEqual([]);
  });

  it('does not treat a book CRATE SUMMARY as a location', () => {
    // "Crate Red 5" says which box, not which aisle. Two formatters that
    // disagree on whether to render it are not disagreeing about geography.
    expect(
      placementPhysicalNames(
        resolvePlacement({
          itemType: 'book',
          customFields: { book_rack_number: '39', book_rack_row: 'B', book_crate_number: '5' },
        }),
      ),
    ).toEqual(['39-B']);
  });
});
