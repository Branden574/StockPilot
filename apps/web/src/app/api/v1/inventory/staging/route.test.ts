import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_MODULE_IDS, type ModuleId } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { makeSupabaseStub, type MockCall } from '@/test/supabase-mock';

import { GET } from './route';

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, remaining: 59, resetAt: Date.now() + 60_000 })),
}));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const ORDER = '0f0f0f0f-0000-4000-8000-000000000001';

function ctx(client: unknown, role: 'admin' | 'staff' | 'viewer' = 'admin', modules?: Set<ModuleId>) {
  return {
    organizationId: 'org-1',
    userId: 'u-1',
    role,
    supabase: client as never,
    mfaRequired: false,
    mfaSatisfied: true,
    enabledModules: modules ?? new Set<ModuleId>(DEFAULT_MODULE_IDS),
  };
}

function inItemIds(call: MockCall): string[] {
  const k = call.methods.findIndex((m, j) => m === 'in' && call.args[j]?.[0] === 'item_id');
  return k === -1 ? [] : (call.args[k]![1] as string[]);
}

/** One Staging row per id the levels request asked for. */
function levels(call: MockCall) {
  return {
    data: inItemIds(call).map((itemId) => ({
      id: `lvl-${itemId}`,
      item_id: itemId,
      location_id: 'stg-1',
      quantity: 3,
      locations: { id: 'stg-1', kind: 'staging', warehouse_id: 'wh-1' },
      inventory_items: { id: itemId, name: 'Thing', sku: 'SKU', item_type: 'product', deleted_at: null },
    })),
    error: null,
  };
}

function stub(extra: Record<string, unknown> = {}) {
  return makeSupabaseStub({
    'item_stock_levels.select': levels,
    'stock_movements.select': { data: [], error: null },
    ...extra,
  } as never);
}

function get(query: string) {
  return GET(new NextRequest(`http://localhost/api/v1/inventory/staging${query}`));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/v1/inventory/staging: itemIds and orderId (F2-3)', () => {
  it('400 for an itemIds value that is not a uuid, and for an empty one', async () => {
    for (const q of [`?itemIds=${id(1)},nope`, '?itemIds=', `?itemIds=${id(1)},,${id(2)}`]) {
      const s = stub();
      vi.mocked(withApiContext).mockResolvedValueOnce(ctx(s.client));
      const res = await get(q);
      expect(res.status, q).toBe(400);
      expect((await res.json()).error).toBe('validation_error');
      expect(s.fromCalls, q).toEqual([]);
    }
  });

  it('400 for 201 ids; 200 are read in two batches of 100', async () => {
    const s201 = stub();
    vi.mocked(withApiContext).mockResolvedValueOnce(ctx(s201.client));
    const many = Array.from({ length: 201 }, (_, i) => id(i + 1));
    const res = await get(`?itemIds=${many.join(',')}`);
    expect(res.status).toBe(400);
    expect((await res.json()).message).toBe('At most 200 item ids');
    expect(s201.fromCalls).toEqual([]);

    const s200 = stub();
    vi.mocked(withApiContext).mockResolvedValueOnce(ctx(s200.client));
    const ok = await get(`?itemIds=${many.slice(0, 200).join(',')}`);
    expect(ok.status).toBe(200);
    const calls = (s200.chainArgsAll.get('item_stock_levels.select') ?? []).map((args, k) =>
      inItemIds({ table: 'item_stock_levels', op: 'select', methods: s200.chainsAll.get('item_stock_levels.select')![k]!, args }),
    );
    expect(calls.map((c) => c.length)).toEqual([100, 100]);
    expect((await ok.json()).rows).toHaveLength(200);
  });

  it('removes duplicates BEFORE the 200 cap, as core and the service do (201 ids, 200 distinct: 200)', async () => {
    const many = Array.from({ length: 200 }, (_, i) => id(i + 1));
    const s = stub();
    vi.mocked(withApiContext).mockResolvedValueOnce(ctx(s.client));
    // The same list the web page accepts (core parseStagingItemFilter), with
    // one id repeated in another case: 201 values, 200 items.
    const res = await get(`?itemIds=${[...many, id(7).toUpperCase()].join(',')}`);
    expect(res.status).toBe(200);
    expect((await res.json()).rows).toHaveLength(200);
    // And 201 DISTINCT ids are still refused, before any read.
    const s201 = stub();
    vi.mocked(withApiContext).mockResolvedValueOnce(ctx(s201.client));
    const over = await get(`?itemIds=${[...many, id(201)].join(',')}`);
    expect(over.status).toBe(400);
    expect(s201.fromCalls).toEqual([]);
  });

  it('400 for an orderId that is not a uuid', async () => {
    const s = stub();
    vi.mocked(withApiContext).mockResolvedValueOnce(ctx(s.client));
    const res = await get(`?itemIds=${id(1)}&orderId=SO-000123`);
    expect(res.status).toBe(400);
  });

  it('filters in the service query and ignores warehouseId when itemIds is set', async () => {
    const s = stub();
    vi.mocked(withApiContext).mockResolvedValueOnce(ctx(s.client));
    const res = await get(`?itemIds=${id(1)},${id(2)}&warehouseId=${id(99)}`);
    expect(res.status).toBe(200);
    const [methods] = s.chainsAll.get('item_stock_levels.select')!;
    const [args] = s.chainArgsAll.get('item_stock_levels.select')!;
    const pairs = methods!.map((m, k) => [m, ...(args![k] ?? [])]);
    expect(pairs).toContainEqual(['in', 'item_id', [id(1), id(2)]]);
    expect(pairs).toContainEqual(['eq', 'organization_id', 'org-1']);
    expect(pairs.some((p) => p[0] === 'eq' && p[1] === 'locations.warehouse_id')).toBe(false);
    const body = await res.json();
    expect(body.rows.map((r: { itemId: string }) => r.itemId)).toEqual([id(1), id(2)]);
    expect(body.order).toBeNull();
  });

  it('accepts repeated itemIds params as one list, deduped', async () => {
    const s = stub();
    vi.mocked(withApiContext).mockResolvedValueOnce(ctx(s.client));
    const res = await get(`?itemIds=${id(1)}&itemIds=${id(2)},${id(1).toUpperCase()}`);
    expect(res.status).toBe(200);
    const [methods] = s.chainsAll.get('item_stock_levels.select')!;
    const [args] = s.chainArgsAll.get('item_stock_levels.select')!;
    expect(methods!.map((m, k) => [m, ...(args![k] ?? [])])).toContainEqual(['in', 'item_id', [id(1), id(2)]]);
  });

  it('orderId answers the order number for the chip, read beside the worklist', async () => {
    const s = stub({ 'order_requests.select': { data: { id: ORDER, order_number: 123, warehouse_id: 'wh-1' }, error: null } });
    vi.mocked(withApiContext).mockResolvedValueOnce(ctx(s.client));
    const res = await get(`?itemIds=${id(1)}&orderId=${ORDER}`);
    expect(res.status).toBe(200);
    expect((await res.json()).order).toEqual({ id: ORDER, orderNumber: 'SO-000123', found: true, elsewhere: 0 });
    const [methods] = s.chainsAll.get('order_requests.select')!;
    const [args] = s.chainArgsAll.get('order_requests.select')!;
    const pairs = methods!.map((m, k) => [m, ...(args![k] ?? [])]);
    expect(pairs).toContainEqual(['eq', 'organization_id', 'org-1']);
    expect(pairs).toContainEqual(['eq', 'id', ORDER]);
  });

  // Readiness counts Staging at the order's warehouse and at locations with no
  // warehouse (0377); the phone gets the same narrowed list as the web page.
  it("with the order read: only its warehouse's rows and warehouse-less ones, and how many were left out", async () => {
    const mixed = (call: MockCall) => ({
      data: inItemIds(call).flatMap((itemId, k) => [
        {
          id: `lvl-h-${k}`,
          item_id: itemId,
          location_id: 'stg-home',
          quantity: 3,
          locations: { id: 'stg-home', kind: 'staging', warehouse_id: 'wh-1' },
          inventory_items: { id: itemId, name: 'Thing', sku: 'SKU', item_type: 'product', deleted_at: null },
        },
        {
          id: `lvl-o-${k}`,
          item_id: itemId,
          location_id: 'stg-other',
          quantity: 5,
          locations: { id: 'stg-other', kind: 'staging', warehouse_id: 'wh-2' },
          inventory_items: { id: itemId, name: 'Thing', sku: 'SKU', item_type: 'product', deleted_at: null },
        },
        {
          id: `lvl-n-${k}`,
          item_id: itemId,
          location_id: 'stg-org',
          quantity: 1,
          locations: { id: 'stg-org', kind: 'staging', warehouse_id: null },
          inventory_items: { id: itemId, name: 'Thing', sku: 'SKU', item_type: 'product', deleted_at: null },
        },
      ]),
      error: null,
    });
    const s = makeSupabaseStub({
      'item_stock_levels.select': mixed,
      'stock_movements.select': { data: [], error: null },
      'order_requests.select': { data: { id: ORDER, order_number: 123, warehouse_id: 'wh-1' }, error: null },
    } as never);
    vi.mocked(withApiContext).mockResolvedValueOnce(ctx(s.client));
    const body = await (await get(`?itemIds=${id(1)},${id(2)}&orderId=${ORDER}`)).json();
    expect(body.rows.map((r: { warehouseId: string | null }) => r.warehouseId).sort()).toEqual(['wh-1', 'wh-1', null, null].sort());
    expect(body.order).toEqual({ id: ORDER, orderNumber: 'SO-000123', found: true, elsewhere: 2 });

    // The order not read (failed): nothing narrowed, nothing claimed.
    const f = makeSupabaseStub({
      'item_stock_levels.select': mixed,
      'stock_movements.select': { data: [], error: null },
      'order_requests.select': { data: null, error: { message: 'boom' } },
    } as never);
    vi.mocked(withApiContext).mockResolvedValueOnce(ctx(f.client));
    const failed = await (await get(`?itemIds=${id(1)}&orderId=${ORDER}`)).json();
    expect(failed.rows).toHaveLength(3);
    expect(failed.order).toEqual({ id: ORDER, orderNumber: null, found: true, elsewhere: 0 });
  });

  it('an order that is not there: found false (no link back); a failed read: found true, no number, and the list still loads', async () => {
    const gone = stub({ 'order_requests.select': { data: null, error: null } });
    vi.mocked(withApiContext).mockResolvedValueOnce(ctx(gone.client));
    expect((await (await get(`?itemIds=${id(1)}&orderId=${ORDER}`)).json()).order).toEqual({
      id: ORDER,
      orderNumber: null,
      found: false,
      elsewhere: 0,
    });

    const failed = stub({ 'order_requests.select': { data: null, error: { message: 'boom' } } });
    vi.mocked(withApiContext).mockResolvedValueOnce(ctx(failed.client));
    const res = await get(`?itemIds=${id(1)}&orderId=${ORDER}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.order).toEqual({ id: ORDER, orderNumber: null, found: true, elsewhere: 0 });
    expect(body.rows).toHaveLength(1);
  });

  it('orders module off: no order read, found false', async () => {
    const s = stub({ 'order_requests.select': { data: { id: ORDER, order_number: 1 }, error: null } });
    const modules = new Set<ModuleId>(DEFAULT_MODULE_IDS);
    modules.delete('orders');
    vi.mocked(withApiContext).mockResolvedValueOnce(ctx(s.client, 'admin', modules));
    const body = await (await get(`?itemIds=${id(1)}&orderId=${ORDER}`)).json();
    expect(body.order).toEqual({ id: ORDER, orderNumber: null, found: false, elsewhere: 0 });
    expect(s.fromCalls).not.toContain('order_requests');
  });

  it('keeps canPlace = stock:transfer (a viewer reads the list, cannot place)', async () => {
    const s = stub();
    vi.mocked(withApiContext).mockResolvedValueOnce(ctx(s.client, 'viewer'));
    const body = await (await get(`?itemIds=${id(1)}`)).json();
    expect(body.canPlace).toBe(false);
    const s2 = stub();
    vi.mocked(withApiContext).mockResolvedValueOnce(ctx(s2.client, 'staff'));
    expect((await (await get(`?itemIds=${id(1)}`)).json()).canPlace).toBe(true);
  });

  it('without itemIds: unchanged (the warehouse filter applies, no order key read)', async () => {
    const s = makeSupabaseStub({ 'item_stock_levels.select': { data: [], error: null } });
    vi.mocked(withApiContext).mockResolvedValueOnce(ctx(s.client));
    const res = await get(`?warehouseId=${id(99)}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ rows: [], canPlace: true, order: null });
    const [methods] = s.chainsAll.get('item_stock_levels.select')!;
    const [args] = s.chainArgsAll.get('item_stock_levels.select')!;
    expect(methods!.map((m, k) => [m, ...(args![k] ?? [])])).toContainEqual(['eq', 'locations.warehouse_id', id(99)]);
  });

  it('401 without a session; 403 without items:read (before any read)', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(null);
    expect((await get(`?itemIds=${id(1)}`)).status).toBe(401);
    const s = stub();
    vi.mocked(withApiContext).mockResolvedValueOnce({ ...ctx(s.client, 'viewer'), permissions: new Set() } as never);
    expect((await get(`?itemIds=${id(1)}`)).status).toBe(403);
    expect(s.fromCalls).toEqual([]);
  });
});
