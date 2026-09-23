import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Quick-add strip's availability. The items and reservations reads ignored
 * their errors: a failed reservations read was "nothing reserved", so the
 * strip overstated what could be ordered. Both now fail the request. (The id
 * lists are the RPC's top items, clamped to 12, so they stay one request.)
 */

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));
vi.mock('@/server/services/item-images', () => ({
  ItemImagesService: vi.fn().mockImplementation(function () {
    return { primaryImagesForBrowserDisplay: vi.fn(async () => new Map()) };
  }),
}));

import { withApiContext } from '@/lib/auth/api-context';
import { makeSupabaseStub } from '@/test/supabase-mock';

import { GET } from './route';

function ctxWith(results: Parameters<typeof makeSupabaseStub>[0]) {
  const stub = makeSupabaseStub({
    'rpc:order_request_top_skus_for_warehouse': {
      data: [{ item_id: 'i1', request_count: 4 }],
      error: null,
    },
    'inventory_items.select': {
      data: [{ id: 'i1', sku: 'S1', name: 'Item', quantity_on_hand: 5, category_id: null, item_type: 'product' }],
      error: null,
    },
    'stock_reservations.select': { data: [{ item_id: 'i1', quantity: 2 }], error: null },
    ...results,
  });
  vi.mocked(withApiContext).mockResolvedValue({
    organizationId: 'org-1',
    userId: 'u1',
    role: 'staff',
    supabase: stub.client,
  } as never);
}
const req = () => new NextRequest('https://test.local/api/orders/freq?warehouseId=wh-1');

beforeEach(() => vi.clearAllMocks());

describe('GET /api/orders/freq', () => {
  it('nets reservations out of what is available', async () => {
    ctxWith({});
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect((await res.json()).items[0]).toMatchObject({ itemId: 'i1', available: 3 });
  });

  it('a failed reservations read is a 500, never "nothing reserved"', async () => {
    ctxWith({ 'stock_reservations.select': { data: null, error: { message: 'fetch failed' } } });
    expect((await GET(req())).status).toBe(500);
  });

  it('a failed items read is a 500, never an empty strip', async () => {
    ctxWith({ 'inventory_items.select': { data: null, error: { message: 'fetch failed' } } });
    expect((await GET(req())).status).toBe(500);
  });
});
