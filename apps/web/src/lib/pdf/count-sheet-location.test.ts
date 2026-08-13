import { describe, expect, it } from 'vitest';

import { countSheetLocationLabel } from './count-sheet-location';

describe('countSheetLocationLabel', () => {
  // The reported bug: every row showed just the site name ("DC4") because the
  // sheet never read the rack/crate out of custom_fields.
  it('book with rack + crate shows both, not the site name', () => {
    expect(
      countSheetLocationLabel({
        item_type: 'book',
        custom_fields: {
          book_rack_number: '39',
          book_rack_row: 'B',
          book_crate_color: 'red',
          book_crate_number: '5',
        },
        bin_location: '',
        primaryLocationName: 'DC4',
      }),
    ).toBe('Rack 39-B · Crate Red 5');
  });

  it('book with a number-only crate still shows the crate', () => {
    expect(
      countSheetLocationLabel({
        item_type: 'book',
        custom_fields: { book_rack_number: '39', book_rack_row: 'B', book_crate_number: '6' },
        bin_location: '',
        primaryLocationName: 'DC4',
      }),
    ).toBe('Rack 39-B · Crate 6');
  });

  it('book with rack only shows the rack', () => {
    expect(
      countSheetLocationLabel({
        item_type: 'book',
        custom_fields: { book_rack_number: '41', book_rack_row: 'C' },
        bin_location: '',
        primaryLocationName: 'DC4',
      }),
    ).toBe('Rack 41-C');
  });

  it('non-book item uses the neutral rack_* keys', () => {
    expect(
      countSheetLocationLabel({
        item_type: 'product',
        custom_fields: { rack_number: '15', rack_row: 'A' },
        bin_location: '',
        primaryLocationName: 'DC4',
      }),
    ).toBe('Rack 15-A');
  });

  it('falls back to bin_location text when no rack is set', () => {
    expect(
      countSheetLocationLabel({
        item_type: 'product',
        custom_fields: {},
        bin_location: 'Aisle 3, top shelf',
        primaryLocationName: 'DC4',
      }),
    ).toBe('Aisle 3, top shelf');
  });

  it('falls back to the site name when nothing else is set', () => {
    expect(
      countSheetLocationLabel({
        item_type: 'book',
        custom_fields: null,
        bin_location: null,
        primaryLocationName: 'DC4',
      }),
    ).toBe('DC4');
  });

  it('returns null when there is no location info at all', () => {
    expect(
      countSheetLocationLabel({
        item_type: 'product',
        custom_fields: {},
        bin_location: '',
        primaryLocationName: null,
      }),
    ).toBeNull();
  });

  // RACK Unit C: stock split across >1 rack/crate HOLDING makes the
  // structured/bin_location/site label misleading — it names one rack
  // while stock actually sits on several. The breakdown must win whenever
  // more than one holding is present, even when the item ALSO has a
  // structured rack label set.
  it('prefers the holdings breakdown over the structured rack label when split (>1 holding)', () => {
    expect(
      countSheetLocationLabel({
        item_type: 'product',
        custom_fields: { rack_number: '38', rack_row: 'A' },
        bin_location: null,
        primaryLocationName: 'DC4',
        rackHoldings: [
          { name: '5-A', quantity: 5 },
          { name: '2-C', quantity: 20 },
        ],
      }),
    ).toBe('2-C ×20 · 5-A ×5');
  });

  it('falls back to the structured rack label when only one holding is present (not split)', () => {
    expect(
      countSheetLocationLabel({
        item_type: 'product',
        custom_fields: { rack_number: '38', rack_row: 'A' },
        bin_location: null,
        primaryLocationName: 'DC4',
        rackHoldings: [{ name: '38-A', quantity: 12 }],
      }),
    ).toBe('Rack 38-A');
  });

  it('falls back to the structured rack label when rackHoldings is empty', () => {
    expect(
      countSheetLocationLabel({
        item_type: 'product',
        custom_fields: { rack_number: '38', rack_row: 'A' },
        bin_location: null,
        primaryLocationName: 'DC4',
        rackHoldings: [],
      }),
    ).toBe('Rack 38-A');
  });

  it('falls back to the structured rack label when rackHoldings is omitted (caller has no holdings data)', () => {
    expect(
      countSheetLocationLabel({
        item_type: 'product',
        custom_fields: { rack_number: '38', rack_row: 'A' },
        bin_location: null,
        primaryLocationName: 'DC4',
      }),
    ).toBe('Rack 38-A');
  });

  // ═══ STOCK IN A CRATE OUTRANKS THE ITEM'S RACK KEYS ═══
  //
  // A put-away into a crate that states no rack position leaves the item's rack
  // keys ALONE on purpose — a PARTIAL put-away leaves the rest of the stock on
  // a rack the operator never mentioned, so clearing them would publish a
  // falsehood. The consequence is that the keys can outlive the stock: a
  // Chromebook whose units have all moved into "Blue Shelf" still carries rack
  // 38-A, and this sheet used to print "Rack 38-A" and walk the counter to an
  // aisle the stock had left.
  it('prints the CRATE, not the stale rack, when a non-book has moved entirely into a crate', () => {
    expect(
      countSheetLocationLabel({
        item_type: 'product',
        custom_fields: { rack_number: '38', rack_row: 'A' },
        bin_location: 'Blue Shelf',
        primaryLocationName: 'DC4',
        rackHoldings: [{ name: 'Blue Shelf', quantity: 12, kind: 'crate' }],
      }),
    ).toBe('Blue Shelf ×12');
  });

  it('prints the CRATE for a book whose rack keys still name its previous rack', () => {
    expect(
      countSheetLocationLabel({
        item_type: 'book',
        custom_fields: {
          book_rack_number: '40',
          book_rack_row: 'B',
          book_crate_color: 'gray',
          book_crate_number: 'BIN',
        },
        bin_location: 'Gray #BIN',
        primaryLocationName: 'DC4',
        rackHoldings: [{ name: 'Gray #BIN', quantity: 5, kind: 'crate' }],
      }),
    ).toBe('Gray #BIN ×5');
  });

  it('a POSITIONED crate loses nothing — the holding name carries the rack', () => {
    expect(
      countSheetLocationLabel({
        item_type: 'book',
        custom_fields: { book_rack_number: '43', book_rack_row: 'B' },
        bin_location: 'Gray #BIN on rack 43-B',
        primaryLocationName: 'DC4',
        rackHoldings: [{ name: 'Gray #BIN on rack 43-B', quantity: 5, kind: 'crate' }],
      }),
    ).toBe('Gray #BIN on rack 43-B ×5');
  });

  it('a single RACK holding keeps the structured label — the narrowing is crates only', () => {
    expect(
      countSheetLocationLabel({
        item_type: 'product',
        custom_fields: { rack_number: '38', rack_row: 'A' },
        bin_location: null,
        primaryLocationName: 'DC4',
        rackHoldings: [{ name: '38-A', quantity: 12, kind: 'rack' }],
      }),
    ).toBe('Rack 38-A');
  });

  it('a crate holding alongside a rack holding is already covered by the split rule', () => {
    expect(
      countSheetLocationLabel({
        item_type: 'product',
        custom_fields: { rack_number: '38', rack_row: 'A' },
        bin_location: 'Blue Shelf',
        primaryLocationName: 'DC4',
        rackHoldings: [
          { name: 'Blue Shelf', quantity: 4, kind: 'crate' },
          { name: '38-A', quantity: 8, kind: 'rack' },
        ],
      }),
    ).toBe('38-A ×8 · Blue Shelf ×4');
  });

  it('a crate holding wins even when the item carries no structured rack at all', () => {
    // Nothing to outrank; the crate breakdown still wins because it is the
    // physical truth, and it names the same crate the label does.
    expect(
      countSheetLocationLabel({
        item_type: 'product',
        custom_fields: {},
        bin_location: 'Blue Shelf',
        primaryLocationName: 'DC4',
        rackHoldings: [{ name: 'Blue Shelf', quantity: 12, kind: 'crate' }],
      }),
    ).toBe('Blue Shelf ×12');
  });
});
