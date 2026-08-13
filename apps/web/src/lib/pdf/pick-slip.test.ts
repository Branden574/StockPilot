import { describe, expect, it } from 'vitest';

import { locationFor, renderPickSlipPdf } from './pick-slip';

const baseDetail = {
  request: {
    id: 'f3d77cda-68aa-43a3-bb6b-09fce21291e4',
    organization_id: 'org-1',
    warehouse_id: 'wh-1',
    requester_user_id: null,
    requester_email: 'branden.walker@cvsouth.org',
    requester_name: 'Doua Vang',
    requester_org_label: 'Clovis',
    source: 'internal' as const,
    status: 'pick_slip_generated' as const,
    notes: 'Delivery for Doua Vang to Clovis',
    requester_phone: null,
    delivery_charter_id: null,
    pickup_location_notes: null,
    fulfillment_type: 'delivery' as const,
    assigned_picker_id: null,
    assigned_delivery_user_id: null,
    pick_slip_generated_at: '2026-05-20T17:41:00.000Z',
    delivered_at: null,
    cancelled_at: null,
    created_at: '2026-05-20T00:00:00.000Z',
    updated_at: '2026-05-20T00:00:00.000Z',
    approved_at: null,
    signature_token: null,
    signature_token_expires_at: null,
    signed_by_name: null,
    signed_by_email: null,
    signature_data_url: null,
    signed_at: null,
    completed_at: null,
    completed_by: null,
  },
  warehouseName: 'DC4',
  requesterDisplay: 'Doua Vang',
  // Resolved requester fields the templates now read (see get()).
  requesterName: 'Doua Vang',
  requesterEmail: 'branden.walker@cvsouth.org',
  reservations: [],
  lines: [
    {
      id: 'L1',
      order_request_id: 'f3d77cda',
      item_id: 'i1',
      quantity_requested: 30,
      quantity_fulfilled: 0,
      quantity_picked: null,
      unit_cost_at_request: 0,
      notes: null,
      item: {
        id: 'i1',
        name: 'Google Chrome Book',
        sku: 'SP-BVK31-LH9',
        quantity_on_hand: 50,
        barcode: null,
        model_number: 'Lenovo 100e Gen 4',
        item_type: 'product',
        custom_fields: { rack_number: '2', rack_row: 'A' },
      },
    },
    {
      id: 'L2',
      order_request_id: 'f3d77cda',
      item_id: 'i2',
      quantity_requested: 6,
      quantity_fulfilled: 0,
      quantity_picked: null,
      unit_cost_at_request: 0,
      notes: null,
      item: {
        id: 'i2',
        name: 'Wireless Mouse',
        sku: 'SP-MOUSE-W',
        quantity_on_hand: 100,
        barcode: null,
        model_number: 'Logitech M185',
        item_type: 'product',
        custom_fields: { rack_number: '4', rack_row: 'D' },
      },
    },
  ],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

describe('renderPickSlipPdf', () => {
  it('renders a non-empty PDF buffer with the new layout', async () => {
    const buf = await renderPickSlipPdf(baseDetail, {
      imageUrlByItemId: new Map(),
    });
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.byteLength).toBeGreaterThan(2000);
    // PDF files always start with the magic header %PDF
    expect(buf.subarray(0, 4).toString('ascii')).toBe('%PDF');
  }, 30000);

  // Pre-printed PICKER NAME (owner request 2026-07-22): the claimed picker's
  // name is printed on the slip so they only sign + date by hand. Blank when
  // nobody has claimed — never guess a name on a signed sheet.
  it('pre-prints the claimed picker name (and omits it when unclaimed)', async () => {
    const claimed = await renderPickSlipPdf({
      ...baseDetail,
      assignedPickerName: 'Daniel Hernandez',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    const unclaimed = await renderPickSlipPdf({
      ...baseDetail,
      assignedPickerName: null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    expect(claimed.subarray(0, 4).toString('ascii')).toBe('%PDF');
    expect(unclaimed.subarray(0, 4).toString('ascii')).toBe('%PDF');
    // The name is real embedded content, so the claimed slip carries strictly
    // more bytes than the identical unclaimed one.
    expect(claimed.byteLength).toBeGreaterThan(unclaimed.byteLength);
  }, 30000);

  it('renders even when there are no item images', async () => {
    const buf = await renderPickSlipPdf(baseDetail);
    expect(buf.byteLength).toBeGreaterThan(2000);
  }, 30000);

  it('renders an internal self-submit order (raw requester_name NULL, resolved name present)', async () => {
    // The MAJORITY flow: the buyer placed their own order, so the raw
    // requester_name column is NULL and the name lives on requesterName
    // (resolved from user_profiles in get()). The template must render
    // from the resolved field, not the NULL column.
    const selfSubmit = {
      ...baseDetail,
      request: {
        ...baseDetail.request,
        requester_user_id: 'user-9',
        requester_name: null,
        requester_email: null,
      },
      requesterName: 'Jane Doe',
      requesterEmail: 'jane@cvsouth.org',
    };
    const buf = await renderPickSlipPdf(selfSubmit);
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.byteLength).toBeGreaterThan(2000);
  }, 30000);

  it('renders for a single-line order (overflow tally branch is bounded)', async () => {
    const big = {
      ...baseDetail,
      lines: [
        {
          ...baseDetail.lines[0],
          quantity_requested: 100,
        },
      ],
    };
    const buf = await renderPickSlipPdf(big);
    expect(buf.byteLength).toBeGreaterThan(2000);
  }, 30000);

  it('renders when the caller passes a split-item holdings map', async () => {
    const rackHoldingsByItemId = new Map([
      [
        'i1',
        [
          { name: '2-C', quantity: 20 },
          { name: '5-A', quantity: 5 },
        ],
      ],
    ]);
    const buf = await renderPickSlipPdf(baseDetail, { rackHoldingsByItemId });
    expect(buf.byteLength).toBeGreaterThan(2000);
  }, 30000);
});

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
