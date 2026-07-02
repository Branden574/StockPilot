import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./context', () => ({
  withContext: vi.fn(),
  ServiceError: class extends Error {
    constructor(public code: string, message: string) { super(message); }
  },
  assertPermission: vi.fn(),
  assertPlanLimit: vi.fn(),
}));

vi.mock('@/lib/auth/warehouse', () => ({
  getWarehouseAccess: vi.fn(async () => ({ hasAllAccess: true, readableIds: [] })),
}));

import { InventoryService } from './inventory';

function buildSupabaseStub(rows: Array<{ id: string; barcode: string }>) {
  const eqCalls: Array<[string, unknown]> = [];
  const chain: any = {
    select: () => chain,
    eq: (col: string, val: unknown) => { eqCalls.push([col, val]); return chain; },
    is: () => chain,
    order: () => chain,
    range: () => chain,
    in: () => chain,
    or: () => chain,
    // list() now follows up with an item_stock_levels read that chains
    // .gt('quantity', 0) (placement breakdown) — the stub predates it.
    gt: () => chain,
    then: (cb: (r: { data: unknown; count: number; error: null }) => unknown) =>
      cb({ data: rows, count: rows.length, error: null }),
  };
  return { from: () => chain, _eqCalls: eqCalls };
}

describe('InventoryService.list barcode filter', () => {
  beforeEach(() => vi.clearAllMocks());

  it('adds a barcode .eq filter when filters.barcode is set', async () => {
    const stub = buildSupabaseStub([{ id: 'i1', barcode: '9780140449136' }]);
    const svc = new InventoryService({
      supabase: stub as any,
      organizationId: 'org-1',
      userId: 'u1',
      email: 'a@b.c',
      role: 'admin',
    } as any);

    await svc.list({ barcode: '9780140449136' });

    expect(stub._eqCalls).toContainEqual(['barcode', '9780140449136']);
  });

  it('does not add the barcode filter when omitted', async () => {
    const stub = buildSupabaseStub([]);
    const svc = new InventoryService({
      supabase: stub as any,
      organizationId: 'org-1',
      userId: 'u1',
      email: 'a@b.c',
      role: 'admin',
    } as any);

    await svc.list({});
    expect(stub._eqCalls.find((c) => c[0] === 'barcode')).toBeUndefined();
  });
});
