import { describe, expect, it } from 'vitest';

import { locationFor } from './packing-slip-shared';

describe('locationFor', () => {
  const productLine = {
    id: 'L1',
    order_request_id: 'req-1',
    item_id: 'i1',
    quantity_requested: 1,
    quantity_fulfilled: 0,
    quantity_picked: null,
    unit_cost_at_request: 0,
    notes: null,
    item: {
      id: 'i1',
      name: 'Widget',
      sku: 'SKU-1',
      quantity_on_hand: 10,
      barcode: null,
      model_number: null,
      item_type: 'product',
      custom_fields: { rack_number: '2', rack_row: 'C' },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  it('falls back to the bin_location-derived label when no holdings map is passed', () => {
    expect(locationFor(productLine)).toEqual({ primary: 'Rack 2-C', secondary: null });
  });

  it('falls back to the label when the item has zero holdings', () => {
    const holdings = new Map();
    expect(locationFor(productLine, holdings)).toEqual({ primary: 'Rack 2-C', secondary: null });
  });

  it('falls back to the label when the item has exactly one holding (not split)', () => {
    const holdings = new Map([['i1', [{ name: '9-Z', quantity: 3 }]]]);
    // Single-holding items keep the (possibly differently-named) label —
    // only >1 holding is ambiguous enough to need the breakdown.
    expect(locationFor(productLine, holdings)).toEqual({ primary: 'Rack 2-C', secondary: null });
  });

  it('prefers the holdings breakdown over the label when the item is split (>1 holding)', () => {
    const holdings = new Map([
      [
        'i1',
        [
          { name: '5-A', quantity: 5 },
          { name: '2-C', quantity: 20 },
        ],
      ],
    ]);
    expect(locationFor(productLine, holdings)).toEqual({
      primary: '2-C ×20 · 5-A ×5',
      secondary: null,
    });
  });

  it('returns nulls when the line has no joined item', () => {
    const noItem = { ...productLine, item: null };
    expect(locationFor(noItem)).toEqual({ primary: null, secondary: null });
  });

  it('a book with NO holdings data keeps its rack+crate custom_fields', () => {
    const bookLine = {
      ...productLine,
      item: {
        ...productLine.item,
        item_type: 'book',
        custom_fields: {
          book_rack_number: '39',
          book_rack_row: 'B',
          book_crate_color: 'red',
          book_crate_number: '5',
        },
      },
    };
    expect(locationFor(bookLine)).toEqual({ primary: 'Rack 39-B', secondary: 'Crate Red 5' });
  });

  // ═══ THE 0335 REGRESSION — a crate outranks the item's rack keys ═══
  //
  // A put-away into a POSITION-LESS crate preserves book_rack_*/rack_* on
  // purpose (a partial put-away leaves the rest of the stock on a rack nobody
  // mentioned), so those keys outlive the stock. This slip used to prefer them
  // and walk a picker to an aisle the stock had left — worse than blank on a
  // document someone carries through the warehouse.

  it('prints the CRATE, not the departed rack, for a non-book in a position-less crate', () => {
    const holdings = new Map([['i1', [{ name: 'Blue Shelf', quantity: 12, kind: 'crate' }]]]);
    expect(locationFor(productLine, holdings)).toEqual({
      primary: 'Blue Shelf ×12',
      secondary: null,
    });
  });

  it('prints the CRATE for a book whose rack keys still name its previous rack', () => {
    const bookLine = {
      ...productLine,
      item: {
        ...productLine.item,
        item_type: 'book',
        custom_fields: {
          book_rack_number: '40',
          book_rack_row: 'B',
          book_crate_color: 'gray',
          book_crate_number: 'BIN',
        },
      },
    };
    const holdings = new Map([['i1', [{ name: 'Gray #BIN', quantity: 5, kind: 'crate' }]]]);
    // The verbatim string the regression printed.
    expect(locationFor(bookLine, holdings)).not.toEqual({
      primary: 'Rack 40-B',
      secondary: 'Crate Gray BIN',
    });
    expect(locationFor(bookLine, holdings)).toEqual({
      primary: 'Gray #BIN ×5',
      secondary: null,
    });
  });

  it('a POSITIONED crate keeps its position — the holding name carries the rack', () => {
    const bookLine = {
      ...productLine,
      item: {
        ...productLine.item,
        item_type: 'book',
        custom_fields: { book_rack_number: '43', book_rack_row: 'B' },
      },
    };
    const holdings = new Map([
      ['i1', [{ name: 'Gray #BIN on rack 43-B', quantity: 5, kind: 'crate' }]],
    ]);
    expect(locationFor(bookLine, holdings)).toEqual({
      primary: 'Gray #BIN on rack 43-B ×5',
      secondary: null,
    });
  });

  it('a single RACK holding still keeps the structured label — the narrowing is crates only', () => {
    const holdings = new Map([['i1', [{ name: '9-Z', quantity: 3, kind: 'rack' }]]]);
    expect(locationFor(productLine, holdings)).toEqual({ primary: 'Rack 2-C', secondary: null });
  });
});
