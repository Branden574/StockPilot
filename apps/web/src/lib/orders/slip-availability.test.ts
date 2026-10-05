import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

import { closedOrderSlipAnswer } from './slip-availability';

/**
 * L132 (owner decision Q17: wording only, no change to who may print): the
 * three slip routes told someone opening a cancelled, denied or backordered
 * order's slip to "Generate ... first", which they could never do. They now
 * say why: a closed order's slips are no longer available; a backordered
 * order's slips print again once it is resumed. Statuses before generation
 * keep "Generate ... first".
 */

describe('closedOrderSlipAnswer', () => {
  it('cancelled and denied: 409 order_closed, naming the status', () => {
    expect(closedOrderSlipAnswer('cancelled')).toEqual({
      error: 'order_closed',
      message: 'This order is cancelled, so its slips are no longer available.',
    });
    expect(closedOrderSlipAnswer('denied')).toEqual({
      error: 'order_closed',
      message: 'This order is denied, so its slips are no longer available.',
    });
  });

  it('backordered: 409 order_backordered', () => {
    expect(closedOrderSlipAnswer('backordered')).toEqual({
      error: 'order_backordered',
      message: 'This order is on backorder; its slips print again when it is resumed.',
    });
  });

  it('every other status: null (the route answers as before)', () => {
    for (const s of ['pending_approval', 'approved', 'pick_slip_generated', 'completed', 'in_transit']) {
      expect(closedOrderSlipAnswer(s)).toBeNull();
    }
  });
});

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/export-rate-limit', () => ({ exportRateLimited: vi.fn(async () => null) }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn() }));
vi.mock('@/lib/dashboard/cached-org', () => ({ getCachedOrgTimezone: vi.fn(async () => 'UTC') }));
vi.mock('@/lib/pdf/image-prefetch', () => ({ prefetchImagesAsDataUris: vi.fn(async () => new Map()) }));
vi.mock('@/lib/pdf/packing-slip-customer', () => ({ renderCustomerPackingSlipPdf: vi.fn() }));
vi.mock('@/lib/pdf/pick-slip', () => ({ renderPickSlipPdf: vi.fn() }));
vi.mock('@/server/services/item-images', () => ({ ItemImagesService: class {} }));
vi.mock('@/server/services/rack-holdings', () => ({ fetchRackHoldingsByItem: vi.fn() }));
const get = vi.fn();
vi.mock('@/server/services/order-requests', () => ({
  OrderRequestsService: class {
    get = get;
  },
}));

import { withApiContext } from '@/lib/auth/api-context';
import { exportRateLimited } from '@/lib/export-rate-limit';

import { GET as customerSlip } from '@/app/api/orders/[id]/packing-slip-customer.pdf/route';
import { GET as pickSlip } from '@/app/api/orders/[id]/pick-slip.pdf/route';

const ORDER_ID = '0a000000-0000-4000-8000-000000000132';

async function call(route: typeof pickSlip, status: string) {
  get.mockResolvedValue({ request: { id: ORDER_ID, status, warehouse_id: 'wh-1' }, lines: [] });
  const res = await route(new NextRequest(`https://test.local/api/orders/${ORDER_ID}/x.pdf`), {
    params: Promise.resolve({ id: ORDER_ID }),
  });
  return { status: res.status, body: (await res.json()) as { error: string; message: string } };
}

describe('the customer packing slip and pick slip routes (L132)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(withApiContext).mockResolvedValue(
      makeServiceContext(makeSupabaseStub().client, { role: 'manager' }) as never,
    );
    vi.mocked(exportRateLimited).mockResolvedValue(null);
  });

  for (const [name, route] of [
    ['customer packing slip', customerSlip],
    ['pick slip', pickSlip],
  ] as const) {
    it(`${name}: a cancelled order is 409 order_closed, before the export budget is spent`, async () => {
      const res = await call(route, 'cancelled');
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('order_closed');
      expect(exportRateLimited).not.toHaveBeenCalled();
    });

    it(`${name}: a backordered order is 409 order_backordered`, async () => {
      const res = await call(route, 'backordered');
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('order_backordered');
    });

    it(`${name}: an order before its slip keeps "Generate ... first"`, async () => {
      const res = await call(route, 'pending_approval');
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('not_yet_generated');
      expect(res.body.message).toMatch(/^Generate .* first\.$/);
    });
  }
});
