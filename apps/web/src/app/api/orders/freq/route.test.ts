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
const { signedFor } = vi.hoisted(() => ({
  signedFor: vi.fn(async (_ids: string[], _size: number) => new Map()),
}));
vi.mock('@/server/services/item-images', () => ({
  ItemImagesService: class {
    primaryImagesForBrowserDisplay = signedFor;
  },
}));

import { withApiContext } from '@/lib/auth/api-context';
import { makeSupabaseStub, servedLikePostgrest } from '@/test/supabase-mock';

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
  return stub;
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

  // Ordering visibility (0413, design 5.1): no ordering endpoint offers an
  // item hidden from new ordering, and no photo is signed for one.
  it('leaves out an item hidden from ordering, and signs photos only for what it returns', async () => {
    const stub = ctxWith({
      'rpc:order_request_top_skus_for_warehouse': {
        data: [
          { item_id: 'i1', request_count: 4 },
          { item_id: 'i2', request_count: 3 },
        ],
        error: null,
      },
      'inventory_items.select': servedLikePostgrest([
        { id: 'i1', organization_id: 'org-1', sku: 'S1', name: 'Shown', quantity_on_hand: 5, category_id: null, item_type: 'product', deleted_at: null, status: 'active', is_rental: false, order_catalog_visible: true },
        { id: 'i2', organization_id: 'org-1', sku: 'S2', name: 'Hidden', quantity_on_hand: 5, category_id: null, item_type: 'product', deleted_at: null, status: 'active', is_rental: false, order_catalog_visible: false },
      ]),
    });
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect((await res.json()).items.map((i: { itemId: string }) => i.itemId)).toEqual(['i1']);
    const methods = stub.chainsAll.get('inventory_items.select')?.[0] ?? [];
    const args = stub.chainArgsAll.get('inventory_items.select')?.[0] ?? [];
    expect(methods.map((m, i) => [m, args[i]])).toContainEqual(['eq', ['order_catalog_visible', true]]);
    expect(signedFor).toHaveBeenCalledWith(['i1'], 200);
  });
});
