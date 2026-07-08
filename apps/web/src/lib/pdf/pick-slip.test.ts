import { describe, expect, it } from 'vitest';

import { renderPickSlipPdf } from './pick-slip';

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
});
