import { describe, expect, it } from 'vitest';

import {
  formatPlacementLabel,
  partitionPlacementHoldings,
  placementPhysicalNames,
  resolvePlacement,
  type PlacedHoldingLike,
  type PlacementInput,
} from './placement-resolution';

const label = (input: PlacementInput) => formatPlacementLabel(resolvePlacement(input));

/** A holding on a SITE as a reader returns it: a NULL kind and a site type. */
const site = (
  name: string,
  quantity: number,
  type: string | null = 'warehouse',
): PlacedHoldingLike => ({
  name,
  quantity,
  kind: null,
  type,
});

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

describe('resolvePlacement — rule 0c: stock that sits only on a SITE names the Site (B37)', () => {
  // A Site is a NULL-kind location with a site type (core isSiteLocation; the
  // kind is never backfilled). Stock reaches one through a web Transfer to a
  // Site, and through Place back onto the warehouse's Site from Staging, which
  // keeps the item's rack label on purpose. So the label can name a rack the
  // stock has left, and before this rule every surface printed it: the rack
  // and crate rules never see a Site row.

  it('prints the SITE, not the departed rack, for a non-book', () => {
    const input: PlacementInput = {
      itemType: 'product',
      customFields: { rack_number: '38', rack_row: 'A' },
      binLocation: '38-A',
      siteName: 'DC4',
      otherHoldings: [site('DC4', 12)],
    };
    expect(resolvePlacement(input)).toEqual({
      source: 'holdings',
      reason: 'site',
      holdings: [site('DC4', 12)],
    });
    expect(label(input)).toBe('DC4 ×12');
    expect(label(input)).not.toContain('38-A');
  });

  it('prints the SITE for a book whose rack and crate keys still name its old shelf', () => {
    const input: PlacementInput = {
      itemType: 'book',
      customFields: {
        book_rack_number: '39',
        book_rack_row: 'C',
        book_crate_color: 'red',
        book_crate_number: '5',
      },
      binLocation: '39-C',
      siteName: 'DC4',
      otherHoldings: [site('DC4', 7)],
    };
    expect(label(input)).toBe('DC4 ×7');
    // The exact pair a pick slip printed for such a book before this rule.
    expect(label(input)).not.toBe('Rack 39-C · Crate Red 5');
  });

  it('outranks bin_location too, not only the structured keys', () => {
    expect(
      label({
        itemType: 'product',
        customFields: {},
        binLocation: '38-A',
        otherHoldings: [site('DC4', 3)],
      }),
    ).toBe('DC4 ×3');
  });

  it('names EVERY Site when the stock sits on more than one', () => {
    const res = resolvePlacement({
      itemType: 'product',
      customFields: { rack_number: '38', rack_row: 'A' },
      otherHoldings: [site('DC4', 5), site('Annex', 3, 'room')],
    });
    expect(res).toMatchObject({ source: 'holdings', reason: 'site' });
    expect(formatPlacementLabel(res)).toBe('Annex ×3 · DC4 ×5');
  });

  it('every site TYPE counts: warehouse, room, vehicle, job site, other, and a NULL type', () => {
    for (const type of ['warehouse', 'room', 'vehicle', 'jobsite', 'other', null]) {
      expect(
        resolvePlacement({
          itemType: 'product',
          customFields: { rack_number: '38', rack_row: 'A' },
          otherHoldings: [site('Van 3', 2, type)],
        }),
        String(type),
      ).toMatchObject({ source: 'holdings', reason: 'site' });
    }
  });

  describe('KEEPS the rack and crate rules exactly as they were', () => {
    it('a single RACK holding beside Site stock still keeps the structured label', () => {
      expect(
        resolvePlacement({
          itemType: 'product',
          customFields: { rack_number: '38', rack_row: 'A' },
          holdings: [{ name: '38-A', quantity: 8, kind: 'rack' }],
          otherHoldings: [site('DC4', 4)],
        }),
      ).toEqual({ source: 'structured', rackLabel: '38-A', crateLabel: null });
    });

    it('a CRATE-ONLY item beside Site stock is still the crate rule', () => {
      const res = resolvePlacement({
        itemType: 'product',
        customFields: { rack_number: '38', rack_row: 'A' },
        holdings: [{ name: 'Blue Shelf', quantity: 4, kind: 'crate' }],
        otherHoldings: [site('DC4', 6)],
      });
      expect(res).toMatchObject({ source: 'holdings', reason: 'crate' });
      expect(formatPlacementLabel(res)).toBe('Blue Shelf ×4');
    });

    it('a SPLIT across racks beside Site stock is still the split rule', () => {
      const res = resolvePlacement({
        itemType: 'product',
        customFields: {},
        holdings: [
          { name: '5-A', quantity: 5, kind: 'rack' },
          { name: '2-C', quantity: 20, kind: 'rack' },
        ],
        otherHoldings: [site('DC4', 6)],
      });
      expect(res).toMatchObject({ source: 'holdings', reason: 'split' });
      expect(formatPlacementLabel(res)).toBe('2-C ×20 · 5-A ×5');
    });

    it('a holding of UNKNOWN kind in `holdings` is not read as an absence of racks', () => {
      // The pre-B37 promise: a caller that did not carry kinds gets the old
      // precedence. Rule 0c needs NO rack or crate holding at all, and an
      // unclassified row could be either.
      expect(
        resolvePlacement({
          itemType: 'product',
          customFields: { rack_number: '38', rack_row: 'A' },
          holdings: [{ name: 'Somewhere', quantity: 2 }],
          otherHoldings: [site('DC4', 6)],
        }),
      ).toEqual({ source: 'structured', rackLabel: '38-A', crateLabel: null });
    });
  });

  describe('fires ONLY when every other placed holding is a Site', () => {
    it('an AREA beside the Site keeps the old precedence (the area is not a Site)', () => {
      expect(
        resolvePlacement({
          itemType: 'product',
          customFields: { rack_number: '38', rack_row: 'A' },
          otherHoldings: [
            site('DC4', 6),
            { name: 'Overflow', quantity: 2, kind: 'area', type: 'other' },
          ],
        }),
      ).toEqual({ source: 'structured', rackLabel: '38-A', crateLabel: null });
    });

    it('a NULL-kind SHELF or BIN is a placement, not a Site (isSiteLocation)', () => {
      // A NULL kind is also how a legacy shelf is stored; its TYPE says it is
      // a rack-shelf place. Treating it as a Site would name a shelf as "the
      // site" and, beside a real Site, leave its stock behind.
      for (const type of ['shelf', 'bin']) {
        expect(
          resolvePlacement({
            itemType: 'product',
            customFields: { rack_number: '38', rack_row: 'A' },
            otherHoldings: [{ name: 'Aisle A - Shelf 1', quantity: 2, kind: null, type }],
          }),
          type,
        ).toEqual({ source: 'structured', rackLabel: '38-A', crateLabel: null });
      }
    });

    it('ABSENCE OF EVIDENCE: a row whose kind or type was not carried is never a Site', () => {
      // `undefined` means the reader did not say. Reading it as NULL would make
      // every unclassified row a Site and suppress a true rack label.
      const rows = [
        { name: 'DC4', quantity: 6, type: 'warehouse' },
        { name: 'DC4', quantity: 6, kind: null },
        { name: 'DC4', quantity: 6, kind: undefined, type: undefined },
      ] as unknown as PlacedHoldingLike[];
      for (const row of rows) {
        expect(
          resolvePlacement({
            itemType: 'product',
            customFields: { rack_number: '38', rack_row: 'A' },
            otherHoldings: [row],
          }),
        ).toEqual({ source: 'structured', rackLabel: '38-A', crateLabel: null });
      }
    });

    it('no other holdings at all is the old precedence, label then site name', () => {
      for (const otherHoldings of [undefined, []]) {
        expect(
          resolvePlacement({
            itemType: 'product',
            customFields: { rack_number: '38', rack_row: 'A' },
            siteName: 'DC4',
            otherHoldings,
          }),
        ).toEqual({ source: 'structured', rackLabel: '38-A', crateLabel: null });
      }
    });

    it('a Staging or Unplaced row is never a placement (partitionPlacementHoldings drops it)', () => {
      // A caller that hands one over anyway does not get a Site answer from it.
      expect(
        resolvePlacement({
          itemType: 'product',
          customFields: { rack_number: '38', rack_row: 'A' },
          otherHoldings: [
            site('DC4', 6),
            { name: 'Unplaced', quantity: 1, kind: 'unplaced', type: 'other' },
          ],
        }),
      ).toEqual({ source: 'structured', rackLabel: '38-A', crateLabel: null });
    });
  });
});

describe('partitionPlacementHoldings — which rows feed which rule', () => {
  it('rack and crate rows become `holdings` exactly as the rack readers return them', () => {
    const { holdings, otherHoldings } = partitionPlacementHoldings([
      { name: '38-A', quantity: 8, kind: 'rack', type: 'shelf' },
      { name: 'Blue Shelf', quantity: 4, kind: 'crate', type: 'bin' },
    ]);
    // No `type` on them: byte-identical to fetchRackHoldingsByItem's rows, so
    // every rule and consumer that reads `holdings` sees what it always saw.
    expect(holdings).toEqual([
      { name: '38-A', quantity: 8, kind: 'rack' },
      { name: 'Blue Shelf', quantity: 4, kind: 'crate' },
    ]);
    expect(otherHoldings).toEqual([]);
  });

  it('Sites, areas and NULL-kind shelves become `otherHoldings`, carrying kind AND type', () => {
    const { holdings, otherHoldings } = partitionPlacementHoldings([
      { name: 'DC4', quantity: 6, kind: null, type: 'warehouse' },
      { name: 'Overflow', quantity: 2, kind: 'area', type: 'other' },
      { name: 'Aisle A - Shelf 1', quantity: 1, kind: null, type: 'shelf' },
    ]);
    expect(holdings).toEqual([]);
    expect(otherHoldings).toEqual([
      { name: 'DC4', quantity: 6, kind: null, type: 'warehouse' },
      { name: 'Overflow', quantity: 2, kind: 'area', type: 'other' },
      { name: 'Aisle A - Shelf 1', quantity: 1, kind: null, type: 'shelf' },
    ]);
  });

  it('drops the Staging and Unplaced buckets: stock awaiting put-away is no place to send a picker', () => {
    expect(
      partitionPlacementHoldings([
        { name: 'Staging', quantity: 3, kind: 'staging', type: 'other' },
        { name: 'Unplaced', quantity: 2, kind: 'unplaced', type: 'other' },
      ]),
    ).toEqual({ holdings: [], otherHoldings: [] });
  });

  it('feeds rule 0c end to end: a Site-only item resolves to its Site', () => {
    const parts = partitionPlacementHoldings([
      { name: 'DC4', quantity: 6, kind: null, type: 'warehouse' },
      { name: 'Unplaced', quantity: 2, kind: 'unplaced', type: 'other' },
    ]);
    expect(
      label({
        itemType: 'book',
        customFields: { book_rack_number: '39', book_rack_row: 'C' },
        ...parts,
      }),
    ).toBe('DC4 ×6');
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
        resolvePlacement({
          itemType: 'product',
          customFields: { rack_number: '38', rack_row: 'A' },
        }),
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

  it('a SITE resolution names each Site once, as it is called, never parsed for a rack', () => {
    // A Site is its own place. Its name is not a crate's "… on rack X" and is
    // never read as one, whatever it happens to say.
    expect(
      placementPhysicalNames(
        resolvePlacement({
          itemType: 'book',
          customFields: { book_rack_number: '39', book_rack_row: 'C' },
          otherHoldings: [site('DC4', 4), site('Annex on rack 5-A', 2, 'room'), site('DC4', 1)],
        }),
      ),
    ).toEqual(['Annex on rack 5-A', 'DC4']);
  });
});
