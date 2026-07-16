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
});
