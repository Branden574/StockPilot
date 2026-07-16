import { describe, expect, it } from 'vitest';

import { renderWarehousePackingSlipPdf } from './packing-slip-warehouse';

const baseInput = {
  detail: {
    request: {
      id: 'f3d77cda-68aa-43a3-bb6b-09fce21291e4',
      order_number: 14,
      organization_id: 'org-1',
      warehouse_id: 'wh-1',
      requester_user_id: null,
      requester_email: 'branden.walker@cvsouth.org',
      requester_name: 'Doua Vang',
      requester_org_label: 'Clovis',
      source: 'internal' as const,
      status: 'packing_slip_generated' as const,
      notes: 'Delivery for Doua Vang to Clovis',
      internal_notes: null,
      requester_phone: null,
      delivery_charter_id: null,
      pickup_location_notes: null,
      fulfillment_type: 'delivery' as const,
      assigned_picker_id: null,
      packing_slip_generated_at: '2026-05-20T18:00:00.000Z',
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
        quantity_picked: 30,
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
    ],
  },
  warehouse: {
    name: 'DC4',
    code: 'DC4',
    address: null,
    contactName: null,
    contactEmail: null,
    contactPhone: null,
  },
  charterName: null,
  imageUrlByItemId: new Map<string, string>(),
  qrDataUrl: null,
  orgTimezone: 'UTC',
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

describe('renderWarehousePackingSlipPdf', () => {
  it('renders a non-empty PDF buffer without a holdings map (label fallback)', async () => {
    const buf = await renderWarehousePackingSlipPdf(baseInput);
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.byteLength).toBeGreaterThan(2000);
    // PDF files always start with the magic header %PDF
    expect(buf.subarray(0, 4).toString('ascii')).toBe('%PDF');
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
    const buf = await renderWarehousePackingSlipPdf({
      ...baseInput,
      rackHoldingsByItemId,
    });
    expect(buf.byteLength).toBeGreaterThan(2000);
  }, 30000);
});
