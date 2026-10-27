import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  resolveScanMatches,
  sanitizeScanCode,
  scanCandidatePlacementLabel,
  scanHoldingsByItem,
  SCAN_PICKER_COPY,
  scanPickerSubtitle,
} from './scan-resolve';

interface Row {
  id: string;
  barcode: string | null;
  sku: string;
  charterId: string | null;
}

const ROW_A: Row = { id: 'item-a', barcode: null, sku: 'SKU-1', charterId: 'charter-a' };
const ROW_B: Row = { id: 'item-b', barcode: null, sku: 'SKU-1', charterId: 'charter-b' };

describe('resolveScanMatches', () => {
  it('returns not_found for an empty result set', () => {
    expect(resolveScanMatches([], 'SKU-1')).toEqual({ kind: 'not_found' });
  });

  it('resolves a single row directly — the common, unambiguous case', () => {
    expect(resolveScanMatches([ROW_A], 'SKU-1')).toEqual({ kind: 'single', match: ROW_A });
  });

  /**
   * The core Model B bug: the same SKU legitimately exists as two placement
   * rows (different charters/racks). Scanning that SKU must surface BOTH so
   * the caller can put up a picker — never silently pick an arbitrary one.
   */
  it('two same-sku placements → the multiple branch with both rows, none dropped', () => {
    const resolution = resolveScanMatches([ROW_A, ROW_B], 'SKU-1');
    expect(resolution.kind).toBe('multiple');
    if (resolution.kind === 'multiple') {
      expect(resolution.matches).toHaveLength(2);
      expect(resolution.matches).toEqual([ROW_A, ROW_B]);
    }
  });

  it('an exact barcode match is unambiguous and wins over a same-code sku-only row', () => {
    const barcodeRow: Row = { id: 'item-barcode', barcode: 'BC123', sku: 'SKU-9', charterId: null };
    const skuCollisionRow: Row = { id: 'item-sku', barcode: null, sku: 'BC123', charterId: null };
    const resolution = resolveScanMatches([barcodeRow, skuCollisionRow], 'BC123');
    expect(resolution).toEqual({ kind: 'single', match: barcodeRow });
  });

  it('multiple exact barcode matches still surface a picker (rare, but never guess)', () => {
    const dup1: Row = { id: 'item-1', barcode: 'DUPE', sku: 'SKU-A', charterId: 'charter-a' };
    const dup2: Row = { id: 'item-2', barcode: 'DUPE', sku: 'SKU-B', charterId: 'charter-b' };
    const resolution = resolveScanMatches([dup1, dup2], 'DUPE');
    expect(resolution.kind).toBe('multiple');
  });
});

describe('sanitizeScanCode', () => {
  /**
   * A scanned value is interpolated directly into a PostgREST
   * `.or('barcode.eq.X,sku.eq.X')` filter string. Left unsanitized, a `%`,
   * `,`, `(`, or `)` in the scanned code would be parsed as PostgREST filter
   * syntax (an extra clause, a wildcard, a grouping) instead of a literal
   * character to match — mirrors the web lookup route's sanitization
   * (apps/web/src/app/api/v1/items/lookup/route.ts).
   */
  it('strips %, comma, and parens together from a single scanned code', () => {
    expect(sanitizeScanCode('SKU%1,(2)')).toBe('SKU12');
  });

  it('strips % from a scanned code', () => {
    expect(sanitizeScanCode('SKU%1')).toBe('SKU1');
  });

  it('strips a comma that would inject an extra .or() clause', () => {
    expect(sanitizeScanCode('SKU-1,sku.eq.OTHER')).toBe('SKU-1sku.eq.OTHER');
  });

  it('strips parentheses that would break PostgREST grouping', () => {
    expect(sanitizeScanCode('SKU(1)')).toBe('SKU1');
  });

  it('leaves an ordinary alphanumeric barcode/SKU untouched', () => {
    expect(sanitizeScanCode('SKU-1234-ABC')).toBe('SKU-1234-ABC');
  });
});

// Ungroup test stage, orchestrator decision R3-1 (a): after an Ungroup the
// split record keeps its barcode/ISBN, so scanning that code matches records
// with DIFFERENT SKUs. The picker then must not say "This SKU", and each row
// shows its SKU so the person can tell the records apart.
describe('the placement picker words (R3-1)', () => {
  it('matches that share one SKU keep the placement sentence', () => {
    expect(scanPickerSubtitle([{ sku: 'SKU-1' }, { sku: 'SKU-1' }])).toBe(
      'This SKU is stocked in more than one place. Choose which one to adjust.',
    );
    expect(SCAN_PICKER_COPY.sameSku).toBe(
      'This SKU is stocked in more than one place. Choose which one to adjust.',
    );
  });

  it('matches that carry more than one SKU say the code matches more than one record', () => {
    expect(scanPickerSubtitle([{ sku: 'SP-PAIR' }, { sku: 'SP-NEW1' }])).toBe(
      'This code matches more than one record. Choose which one.',
    );
    // A SKU differing only by surrounding spaces is the same SKU.
    expect(scanPickerSubtitle([{ sku: 'SKU-1' }, { sku: ' SKU-1 ' }])).toBe(
      SCAN_PICKER_COPY.sameSku,
    );
  });

  it("the scan screen uses these words and shows each row's SKU (source pin: the screen is not rendered under vitest)", () => {
    const src = readFileSync(resolve(__dirname, '../../app/(drawer)/(tabs)/scan.tsx'), 'utf8');
    expect(src).toContain('scanPickerSubtitle(placementChoices)');
    expect(src).not.toContain('This SKU is stocked in more than one place');
    expect(src).toMatch(/SKU \{c\.sku\}/);
  });
});

// B26: the picker's line under each record said the raw rack text
// (`c.binLocation ?? 'No bin set'`), which named one rack for stock split
// across two, a rack the stock had left for crated stock, and no rack at all
// for a book whose rack lives in its rack keys. It now says where the stock is
// by the one placement rule, as the web lookup API and the Items list do.
describe('the placement picker line (B26)', () => {
  const none = { itemType: 'product', customFields: {}, binLocation: null, holdings: [] };

  it("names a book's rack from its rack keys when it has no rack text", () => {
    expect(
      scanCandidatePlacementLabel({
        ...none,
        itemType: 'book',
        customFields: { book_rack_number: '37', book_rack_row: 'B' },
      }),
    ).toBe('Rack 37-B');
  });

  it('names every rack of split stock, not the one the rack text names', () => {
    expect(
      scanCandidatePlacementLabel({
        ...none,
        binLocation: '1-A',
        holdings: [
          { name: '5-A', quantity: 5, kind: 'rack' },
          { name: '2-C', quantity: 20, kind: 'rack' },
        ],
      }),
    ).toBe('2-C ×20 · 5-A ×5');
  });

  it('names the crate when all of the stock is in a crate', () => {
    expect(
      scanCandidatePlacementLabel({
        ...none,
        binLocation: '38-A',
        holdings: [{ name: 'Blue Shelf', quantity: 12, kind: 'crate' }],
      }),
    ).toBe('Blue Shelf ×12');
  });

  it('keeps the rack text when that is all there is, and says nothing when nothing is known', () => {
    expect(scanCandidatePlacementLabel({ ...none, binLocation: ' 14-D ' })).toBe('14-D');
    expect(scanCandidatePlacementLabel(none)).toBeNull();
  });

  // B37: a record whose stock all sits on a Site (a NULL kind with a site
  // type) was named by the rack its keys still name, because the picker's read
  // handed the rule its rack and crate rows only.
  it('names the Site when all of the stock sits on one, not the rack its keys still name (B37)', () => {
    expect(
      scanCandidatePlacementLabel({
        ...none,
        itemType: 'book',
        customFields: { book_rack_number: '38', book_rack_row: 'A' },
        binLocation: '38-A',
        otherHoldings: [{ name: 'DC4', quantity: 7, kind: null, type: 'warehouse' }],
      }),
    ).toBe('DC4 ×7');
    // Stock on a rack beside the Site keeps naming the rack, as before.
    expect(
      scanCandidatePlacementLabel({
        ...none,
        itemType: 'book',
        customFields: { book_rack_number: '38', book_rack_row: 'A' },
        holdings: [{ name: '38-A', quantity: 5, kind: 'rack' }],
        otherHoldings: [{ name: 'DC4', quantity: 2, kind: null, type: 'warehouse' }],
      }),
    ).toBe('Rack 38-A');
  });

  it('groups the holdings read by record, from either embed shape, skips a row with no location, and splits the racks and crates from the rest', () => {
    const { rack, other } = scanHoldingsByItem([
      { item_id: 'item-a', quantity: 20, locations: { name: '2-C', kind: 'rack', type: 'shelf' } },
      {
        item_id: 'item-a',
        quantity: '5',
        locations: [{ name: '5-A', kind: 'rack', type: 'shelf' }],
      },
      { item_id: 'item-b', quantity: 3, locations: null },
      {
        item_id: 'item-b',
        quantity: 7,
        locations: { name: 'Blue Shelf', kind: 'crate', type: 'bin' },
      },
      { item_id: 'item-c', quantity: 4, locations: { name: 'DC4', kind: null, type: 'warehouse' } },
      {
        item_id: 'item-c',
        quantity: 1,
        locations: { name: 'Staging', kind: 'staging', type: 'other' },
      },
      {
        item_id: 'item-d',
        quantity: 2,
        locations: { name: 'Unplaced', kind: 'unplaced', type: 'other' },
      },
    ]);
    expect(rack.get('item-a')).toEqual([
      { name: '2-C', quantity: 20, kind: 'rack' },
      { name: '5-A', quantity: 5, kind: 'rack' },
    ]);
    expect(rack.get('item-b')).toEqual([{ name: 'Blue Shelf', quantity: 7, kind: 'crate' }]);
    // The Site row goes to the rule's other holdings with its kind AND type;
    // stock awaiting put-away goes to neither.
    expect(rack.has('item-c')).toBe(false);
    expect(other.get('item-c')).toEqual([
      { name: 'DC4', quantity: 4, kind: null, type: 'warehouse' },
    ]);
    expect(other.has('item-a')).toBe(false);
    expect(rack.has('item-d')).toBe(false);
    expect(other.has('item-d')).toBe(false);
  });

  it('the scan screen shows that line (source pin: the screen is not rendered under vitest)', () => {
    const src = readFileSync(resolve(__dirname, '../../app/(drawer)/(tabs)/scan.tsx'), 'utf8');
    expect(src).toMatch(/\{c\.placementLabel \?\? 'No bin set'\} · \{c\.quantityOnHand\} on hand/);
    expect(src).not.toMatch(/\{c\.binLocation \?\?/);
    expect(src).toContain('scanCandidatePlacementLabel(');
    // B37: the picker's read carries every placed kind with its type, and the
    // line is given the Site rows (a NOT IN on the kinds would drop the
    // NULL-kind Sites, the 0292 trap).
    expect(src).toContain("select('item_id, quantity, locations!inner(name, kind, type)')");
    expect(src).toContain('otherHoldings: holdings.other.get(r.id)');
  });
});
