import { describe, expect, it } from 'vitest';

import {
  formatPlacementLabel,
  placementPhysicalNames,
  resolvePlacement,
  type PlacementInput,
  type PlacementResolution,
} from './placement-resolution';
import type { RackHoldingLike } from './rack-holdings';

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

  it('DISTINCT rack positions, once each — a crate ON a rack is that rack (Hunger Games, 2026-08-17)', () => {
    // 97 loose on "38-B" + 20 in crate "Blue #0 on rack 38-B" is ONE rack.
    // The Rack column used to read "38-B, Blue #0 on rack 38-B" — the crate's
    // identity leaking into the rack list — and the header counted two racks
    // for one shelf. The crate's identity is the Crate column's (the summary
    // still says blue 0).
    expect(
      placementPhysicalNames(
        resolvePlacement({
          itemType: 'book',
          customFields: {
            book_rack_number: '38',
            book_rack_row: 'B',
            book_crate_color: 'blue',
            book_crate_number: '0',
          },
          holdings: [
            { name: '38-B', quantity: 97, kind: 'rack' },
            { name: 'Blue #0 on rack 38-B', quantity: 20, kind: 'crate' },
          ],
        }),
      ),
    ).toEqual(['38-B']);
    // Two DIFFERENT racks stay two — the split case the books header counts.
    expect(
      placementPhysicalNames(
        resolvePlacement({
          itemType: 'book',
          customFields: {},
          holdings: [
            { name: '5-A', quantity: 5, kind: 'rack' },
            { name: 'Blue #0 on rack 2-C', quantity: 20, kind: 'crate' },
          ],
        }),
      ),
    ).toEqual(['2-C', '5-A']);
    // A position-less crate is its own place.
    expect(
      placementPhysicalNames(
        resolvePlacement({
          itemType: 'book',
          customFields: {},
          holdings: [
            { name: '5-A', quantity: 5, kind: 'rack' },
            { name: 'Blue Shelf', quantity: 20, kind: 'crate' },
          ],
        }),
      ),
    ).toEqual(['5-A', 'Blue Shelf']);
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

describe('resolvePlacement — the slips\' single-holding check (B21, opt-in)', () => {
  // B21 (2026-11-02): a pick slip printed "No rack set" for an item with no
  // saved rack whose stock sits on one rack, and the saved rack for an item
  // whose one holding had moved off it, while the return's "Get replacement
  // ready" named the holding. Only the two order slips opt in
  // (apps/web/src/lib/pdf/slip-location.ts); every other caller keeps the
  // precedence above.
  const ON_41A: RackHoldingLike[] = [{ name: '41-A', quantity: 3, kind: 'rack' }];
  const cases: Array<{ what: string; input: PlacementInput; withCheck: PlacementResolution; today: PlacementResolution }> = [
    {
      what: 'one rack holding, nothing saved',
      input: { itemType: 'product', customFields: {}, holdings: ON_41A },
      withCheck: { source: 'holdings', reason: 'single', holdings: ON_41A },
      today: { source: 'none' },
    },
    {
      what: 'saved 38-A, the one holding on 41-A',
      input: { itemType: 'product', customFields: { rack_number: '38', rack_row: 'A' }, holdings: ON_41A },
      withCheck: { source: 'holdings', reason: 'single', holdings: ON_41A },
      today: { source: 'structured', rackLabel: '38-A', crateLabel: null },
    },
    {
      what: 'saved 38-A, the one holding on 38-A',
      input: { itemType: 'product', customFields: { rack_number: '38', rack_row: 'A' }, holdings: [{ name: '38-A', quantity: 3, kind: 'rack' }] },
      withCheck: { source: 'structured', rackLabel: '38-A', crateLabel: null },
      today: { source: 'structured', rackLabel: '38-A', crateLabel: null },
    },
    {
      what: 'a book on its saved 39-B with crate Red 5: the crate summary stays',
      input: {
        itemType: 'book',
        customFields: { book_rack_number: '39', book_rack_row: 'B', book_crate_color: 'red', book_crate_number: '5' },
        holdings: [{ name: '39-B', quantity: 4, kind: 'rack' }],
      },
      withCheck: { source: 'structured', rackLabel: '39-B', crateLabel: 'Red 5' },
      today: { source: 'structured', rackLabel: '39-B', crateLabel: 'Red 5' },
    },
    {
      what: 'a rack holding and a crate holding: more than one row is the split rule',
      input: {
        itemType: 'product',
        customFields: {},
        holdings: [
          { name: '41-A', quantity: 3, kind: 'rack' },
          { name: 'Blue Shelf', quantity: 2, kind: 'crate' },
        ],
      },
      withCheck: {
        source: 'holdings',
        reason: 'split',
        holdings: [
          { name: '41-A', quantity: 3, kind: 'rack' },
          { name: 'Blue Shelf', quantity: 2, kind: 'crate' },
        ],
      },
      today: {
        source: 'holdings',
        reason: 'split',
        holdings: [
          { name: '41-A', quantity: 3, kind: 'rack' },
          { name: 'Blue Shelf', quantity: 2, kind: 'crate' },
        ],
      },
    },
    {
      what: 'one crate holding: the crate rule, as before',
      input: { itemType: 'product', customFields: { rack_number: '38', rack_row: 'A' }, holdings: [{ name: 'Blue Shelf', quantity: 2, kind: 'crate' }] },
      withCheck: { source: 'holdings', reason: 'crate', holdings: [{ name: 'Blue Shelf', quantity: 2, kind: 'crate' }] },
      today: { source: 'holdings', reason: 'crate', holdings: [{ name: 'Blue Shelf', quantity: 2, kind: 'crate' }] },
    },
    {
      what: 'one holding the caller carried no kind for: never assumed to be a rack',
      input: { itemType: 'product', customFields: { rack_number: '38', rack_row: 'A' }, holdings: [{ name: '41-A', quantity: 3 }] },
      withCheck: { source: 'structured', rackLabel: '38-A', crateLabel: null },
      today: { source: 'structured', rackLabel: '38-A', crateLabel: null },
    },
    {
      what: 'no holdings known: the saved rack stands',
      input: { itemType: 'product', customFields: { rack_number: '38', rack_row: 'A' }, holdings: [] },
      withCheck: { source: 'structured', rackLabel: '38-A', crateLabel: null },
      today: { source: 'structured', rackLabel: '38-A', crateLabel: null },
    },
  ];

  it.each(cases.map((c) => [c.what, c] as const))('with the check: %s', (_what, c) => {
    expect(resolvePlacement({ ...c.input, singleHoldingCheck: true })).toEqual(c.withCheck);
  });

  it('names the rack and how many are there', () => {
    expect(label({ ...cases[0]!.input, singleHoldingCheck: true })).toBe('41-A ×3');
    expect(label({ ...cases[1]!.input, singleHoldingCheck: true })).toBe('41-A ×3');
  });

  it.each(cases.map((c) => [c.what, c] as const))('without it, today\'s answer: %s', (_what, c) => {
    expect(resolvePlacement(c.input)).toEqual(c.today);
    expect(resolvePlacement({ ...c.input, singleHoldingCheck: false })).toEqual(c.today);
  });

  it("never says 'single' without the opt-in, so the phone's split-or-crate rows never see it", () => {
    // apps/mobile/src/lib/placement-rows.ts and the scan sheet read `reason`
    // as split-or-crate; neither passes the opt-in.
    for (const c of cases) {
      const res = resolvePlacement(c.input);
      expect(res.source === 'holdings' ? res.reason : null, c.what).not.toBe('single');
    }
  });
});
