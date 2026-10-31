import { describe, expect, it, vi } from 'vitest';

import type { OrderRequestDetail } from '@/server/services/order-requests';
import {
  countInPdf,
  embeddedJpeg,
  isWhite,
  rgbAt,
  SEE_THROUGH_SIZE,
  seeThroughImage,
  softMask,
  STORAGE_PHOTO_URL,
  withStoragePhoto,
  type SeeThroughImage,
} from '@/test/see-through-images';

import { prefetchImagesAsDataUris } from './image-prefetch';
import { renderCustomerPackingSlipPdf } from './packing-slip-customer';
import {
  renderWarehousePackingSlipPdf,
  type WarehousePackingSlipInput,
} from './packing-slip-warehouse';
import { renderPickSlipPdf } from './pick-slip';

/**
 * B62: a photo with a see-through background, from storage through the image
 * prefetch the slip routes use, into the printed slip. A WebP thumbnail
 * printed on a black square (a black item vanished on it); it now prints as a
 * JPEG on white. A PNG keeps its transparency, so the slip's paper shows. The
 * customer packing slip shares the line table, and it goes in the box.
 */

// The photo goes through the real image prefetch, whose data-URI cache needs a
// Next request scope; here it calls straight through. The slips do not use
// next/cache.
vi.mock('next/cache', () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
}));

// One order line; its item, i1, gets the photo under test.
const request = {
  id: '0000000f-0000-4000-8000-000000000001',
  order_number: 1,
  organization_id: 'org-1',
  warehouse_id: 'wh-1',
  requester_user_id: null,
  requester_email: 'requester@example.com',
  requester_name: 'Test Requester',
  requester_org_label: null,
  source: 'internal',
  status: 'pick_slip_generated',
  notes: null,
  internal_notes: null,
  requester_phone: null,
  delivery_charter_id: null,
  pickup_location_notes: null,
  fulfillment_type: 'delivery',
  assigned_picker_id: null,
  assigned_delivery_user_id: null,
  pick_slip_generated_at: '2026-05-20T17:41:00.000Z',
  packing_slip_generated_at: null,
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
};

const line = {
  id: 'L1',
  order_request_id: request.id,
  item_id: 'i1',
  quantity_requested: 3,
  quantity_fulfilled: 0,
  quantity_picked: null,
  unit_cost_at_request: 0,
  notes: null,
  item: {
    id: 'i1',
    name: 'Test Item',
    sku: 'TEST-SKU-1',
    quantity_on_hand: 10,
    barcode: null,
    model_number: null,
    item_type: 'product',
    custom_fields: { rack_number: '1', rack_row: 'A' },
  },
};

const pickDetail = {
  request,
  warehouseName: 'Test Warehouse',
  requesterDisplay: 'Test Requester',
  requesterName: 'Test Requester',
  requesterEmail: 'requester@example.com',
  reservations: [],
  lines: [line],
} as unknown as OrderRequestDetail;

const packingInput: WarehousePackingSlipInput = {
  detail: {
    ...pickDetail,
    request: {
      ...request,
      status: 'packing_slip_generated',
      packing_slip_generated_at: '2026-05-20T18:00:00.000Z',
    },
    lines: [{ ...line, quantity_picked: 3 }],
  } as unknown as OrderRequestDetail,
  warehouse: {
    name: 'Test Warehouse',
    code: 'WH1',
    address: null,
    contactName: null,
    contactEmail: null,
    contactPhone: null,
  },
  charterName: null,
  imageUrlByItemId: new Map(),
  qrDataUrl: null,
  orgTimezone: 'UTC',
};

describe('a see-through photo on the pick slip (B62)', () => {
  async function slipWithPhoto(image: SeeThroughImage): Promise<Buffer> {
    return withStoragePhoto(image, async () => {
      const uris = await prefetchImagesAsDataUris([['i1', STORAGE_PHOTO_URL] as const]);
      const uri = uris.get('i1');
      expect(uri).toMatch(/^data:image\/(jpeg|png);base64,/);
      return renderPickSlipPdf(pickDetail, { imageUrlByItemId: new Map([['i1', uri!]]) });
    });
  }

  it('a WebP prints as one JPEG on white, with no soft mask', async () => {
    const pdf = await slipWithPhoto(await seeThroughImage('webp-lossy'));
    expect(countInPdf(pdf, '/DCTDecode')).toBe(1);
    expect(countInPdf(pdf, '/SMask')).toBe(0);
    const corner = await rgbAt(embeddedJpeg(pdf), 0, 0);
    expect(isWhite(corner), `corner of the printed photo: ${corner.join(',')}`).toBe(true);
  }, 30000);

  it('a PNG keeps its soft mask: see-through at the corner (the paper shows), opaque in the middle', async () => {
    const pdf = await slipWithPhoto(await seeThroughImage('png'));
    const mask = softMask(pdf);
    const size = SEE_THROUGH_SIZE;
    expect(mask).toHaveLength(size * size);
    expect(mask[0]).toBe(0);
    expect(mask[(size / 2) * size + size / 2]).toBe(255);
  }, 30000);
});

describe('a see-through photo on the packing slips (B62)', () => {
  it.each([
    ['warehouse', renderWarehousePackingSlipPdf],
    ['customer', renderCustomerPackingSlipPdf],
  ] as const)(
    'the %s slip prints a WebP as one JPEG on white, with no soft mask',
    async (_slip, render) => {
      const pdf = await withStoragePhoto(await seeThroughImage('webp-lossy'), async () => {
        const uris = await prefetchImagesAsDataUris([['i1', STORAGE_PHOTO_URL] as const]);
        expect(uris.get('i1')).toMatch(/^data:image\/jpeg;base64,/);
        return render({ ...packingInput, imageUrlByItemId: new Map([['i1', uris.get('i1')!]]) });
      });
      expect(countInPdf(pdf, '/DCTDecode')).toBe(1);
      expect(countInPdf(pdf, '/SMask')).toBe(0);
      const corner = await rgbAt(embeddedJpeg(pdf), 0, 0);
      expect(isWhite(corner), `corner of the printed photo: ${corner.join(',')}`).toBe(true);
    },
    30000,
  );
});
