import { beforeEach, describe, expect, it, vi } from 'vitest';

import { withApiContext } from '@/lib/auth/api-context';
import { getWarehouseAccess } from '@/lib/auth/warehouse';
import { makeSupabaseStub } from '@/test/supabase-mock';

import { GET } from './route';

vi.mock('@/lib/auth/api-context', () => ({
  withApiContext: vi.fn(),
}));

vi.mock('@/lib/auth/warehouse', () => ({
  getWarehouseAccess: vi.fn(),
}));

const ALL_ACCESS = {
  readableIds: ['wh-1', 'wh-2'],
  writableIds: ['wh-1', 'wh-2'],
  hasAllAccess: true,
  primaryWarehouseId: 'wh-1',
};

function buildCtx(client: unknown) {
  return {
    organizationId: 'org-1',
    userId: 'u-1',
    role: 'admin' as const,
    supabase: client as never,
    mfaRequired: false,
    mfaSatisfied: true,
  };
}

describe('GET /api/search', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 when there is no auth context', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(null);
    const res = await GET(new Request('https://test.local/api/search?q=foo'));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
  });

  it('returns empty arrays when q is shorter than 2 chars', async () => {
    const stub = makeSupabaseStub({});
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx(stub.client));
    vi.mocked(getWarehouseAccess).mockResolvedValueOnce(ALL_ACCESS);

    const res = await GET(new Request('https://test.local/api/search?q=a'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [], purchaseOrders: [], suppliers: [] });
    // Critical: short queries must not hit the DB at all.
    expect(stub.fromCalls).toEqual([]);
  });

  it('builds the items OR query with name/sku/barcode ilike clauses', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': {
        data: [
          { id: 'i-1', name: 'Widget', sku: 'W-1', quantity_on_hand: 10, warehouse_id: 'wh-1' },
        ],
        error: null,
      },
      'purchase_orders.select': { data: [], error: null },
      'suppliers.select': { data: [], error: null },
    });
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx(stub.client));
    vi.mocked(getWarehouseAccess).mockResolvedValueOnce(ALL_ACCESS);

    const res = await GET(new Request('https://test.local/api/search?q=foo'));
    expect(res.status).toBe(200);

    const itemsArgs = stub.chainArgs.get('inventory_items.select') ?? [];
    const orCall = itemsArgs.find((args) => typeof args[0] === 'string' && (args[0] as string).startsWith('name.ilike'));
    expect(orCall?.[0]).toBe('name.ilike.%foo%,sku.ilike.%foo%,barcode.ilike.%foo%');

    const body = await res.json();
    expect(body.items).toEqual([{ id: 'i-1', name: 'Widget', sku: 'W-1', quantity: 10 }]);
  });

  it('hits suppliers + purchase_orders branches and returns mapped shape', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: [], error: null },
      'purchase_orders.select': {
        data: [{ id: 'po-1', po_number: 'PO-FOO-1', status: 'open', supplier_id: 's-1', warehouse_id: 'wh-1' }],
        error: null,
      },
      'suppliers.select': {
        data: [{ id: 's-1', name: 'FooCo' }],
        error: null,
      },
    });
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx(stub.client));
    vi.mocked(getWarehouseAccess).mockResolvedValueOnce(ALL_ACCESS);

    const res = await GET(new Request('https://test.local/api/search?q=foo'));
    expect(res.status).toBe(200);
    expect(stub.fromCalls).toEqual(
      expect.arrayContaining(['inventory_items', 'purchase_orders', 'suppliers']),
    );

    const body = await res.json();
    expect(body.purchaseOrders).toEqual([{ id: 'po-1', poNumber: 'PO-FOO-1', status: 'open' }]);
    expect(body.suppliers).toEqual([{ id: 's-1', name: 'FooCo' }]);
  });

  it('narrows items + purchase_orders queries by readableIds when not hasAllAccess', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: [], error: null },
      'purchase_orders.select': { data: [], error: null },
      'suppliers.select': { data: [], error: null },
    });
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx(stub.client));
    vi.mocked(getWarehouseAccess).mockResolvedValueOnce({
      readableIds: ['wh-9'],
      writableIds: ['wh-9'],
      hasAllAccess: false,
      primaryWarehouseId: 'wh-9',
    });

    const res = await GET(new Request('https://test.local/api/search?q=foo'));
    expect(res.status).toBe(200);

    const itemsChain = stub.chains.get('inventory_items.select') ?? [];
    expect(itemsChain).toContain('in');
    const itemsArgs = stub.chainArgs.get('inventory_items.select') ?? [];
    const itemsInCall = itemsArgs.find((args) => args[0] === 'warehouse_id');
    expect(itemsInCall?.[1]).toEqual(['wh-9']);

    const poChain = stub.chains.get('purchase_orders.select') ?? [];
    expect(poChain).toContain('in');

    const supChain = stub.chains.get('suppliers.select') ?? [];
    // Suppliers are org-scoped; never narrowed by readableIds.
    expect(supChain).not.toContain('in');
  });

  it('does not call .in() when warehouse-scoped user has zero readableIds', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: [], error: null },
      'purchase_orders.select': { data: [], error: null },
      'suppliers.select': { data: [], error: null },
    });
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx(stub.client));
    vi.mocked(getWarehouseAccess).mockResolvedValueOnce({
      readableIds: [],
      writableIds: [],
      hasAllAccess: false,
      primaryWarehouseId: null,
    });

    const res = await GET(new Request('https://test.local/api/search?q=foo'));
    expect(res.status).toBe(200);
    const itemsChain = stub.chains.get('inventory_items.select') ?? [];
    expect(itemsChain).not.toContain('in');
  });

  it('strips % , ( ) characters from the query input', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: [], error: null },
      'purchase_orders.select': { data: [], error: null },
      'suppliers.select': { data: [], error: null },
    });
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx(stub.client));
    vi.mocked(getWarehouseAccess).mockResolvedValueOnce(ALL_ACCESS);

    const res = await GET(new Request('https://test.local/api/search?q=%25foo,(bar)'));
    expect(res.status).toBe(200);

    const itemsArgs = stub.chainArgs.get('inventory_items.select') ?? [];
    const orCall = itemsArgs.find((args) => typeof args[0] === 'string' && (args[0] as string).startsWith('name.ilike'));
    // URL decode -> "%foo,(bar)", then strip [%,()] -> "foobar".
    expect(orCall?.[0]).toBe('name.ilike.%foobar%,sku.ilike.%foobar%,barcode.ilike.%foobar%');
  });
});
