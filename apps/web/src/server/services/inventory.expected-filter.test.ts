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

import { getWarehouseAccess } from '@/lib/auth/warehouse';

import { InventoryService } from './inventory';

// Expected-items visibility (mig 0277): list() must EXCLUDE items awaiting
// their first receipt on every default call (Items/Books pages, order
// pickers, AI search, /api/items/search) and return ONLY them under
// `expected: true` (the "Expected" chip view). countExpected backs the
// chip's badge.

function buildSupabaseStub(rows: Array<Record<string, unknown>>, count?: number) {
  const eqCalls: Array<[string, unknown]> = [];
  const chain: any = {
    select: () => chain,
    eq: (col: string, val: unknown) => { eqCalls.push([col, val]); return chain; },
    is: () => chain,
    order: () => chain,
    range: () => chain,
    in: () => chain,
    or: () => chain,
    gt: () => chain,
    then: (cb: (r: { data: unknown; count: number; error: null }) => unknown) =>
      cb({ data: rows, count: count ?? rows.length, error: null }),
  };
  return { from: () => chain, _eqCalls: eqCalls };
}

function makeSvc(stub: ReturnType<typeof buildSupabaseStub>) {
  return new InventoryService({
    supabase: stub as any,
    organizationId: 'org-1',
    userId: 'u1',
    email: 'a@b.c',
    role: 'admin',
  } as any);
}

describe('InventoryService.list — expected-items predicate (mig 0277)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getWarehouseAccess).mockResolvedValue({
      hasAllAccess: true,
      readableIds: [],
    } as never);
  });

  it('EVERY default list call excludes flagged rows: eq(awaiting_first_receipt, false)', async () => {
    const stub = buildSupabaseStub([]);
    await makeSvc(stub).list({});
    expect(stub._eqCalls).toContainEqual(['awaiting_first_receipt', false]);
    expect(stub._eqCalls).not.toContainEqual(['awaiting_first_receipt', true]);
  });

  it('expected: true flips the SAME predicate to flagged-only (never both)', async () => {
    const stub = buildSupabaseStub([]);
    await makeSvc(stub).list({ expected: true });
    expect(stub._eqCalls).toContainEqual(['awaiting_first_receipt', true]);
    expect(stub._eqCalls).not.toContainEqual(['awaiting_first_receipt', false]);
  });

  it('the parallel value-footer sum query mirrors the exclusion (both builders record it)', async () => {
    const stub = buildSupabaseStub([]);
    await makeSvc(stub).list({});
    // list() builds the main query AND the buildSumPage mirror against the
    // same recording chain — the predicate must appear twice (once each).
    const calls = stub._eqCalls.filter(
      (c) => c[0] === 'awaiting_first_receipt' && c[1] === false,
    );
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe('InventoryService.countExpected — the Expected chip badge (mig 0277)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getWarehouseAccess).mockResolvedValue({
      hasAllAccess: true,
      readableIds: [],
    } as never);
  });

  it('counts ONLY flagged, active rows of the view item_type and returns the head count', async () => {
    const stub = buildSupabaseStub([], 3);
    const n = await makeSvc(stub).countExpected({ itemType: 'product' });
    expect(n).toBe(3);
    expect(stub._eqCalls).toContainEqual(['awaiting_first_receipt', true]);
    expect(stub._eqCalls).toContainEqual(['status', 'active']);
    expect(stub._eqCalls).toContainEqual(['is_rental', false]);
    expect(stub._eqCalls).toContainEqual(['item_type', 'product']);
    expect(stub._eqCalls).toContainEqual(['organization_id', 'org-1']);
  });

  it('returns 0 without querying when a warehouse-scoped user has no readable warehouses (fail closed)', async () => {
    vi.mocked(getWarehouseAccess).mockResolvedValue({
      hasAllAccess: false,
      readableIds: [],
    } as never);
    const stub = buildSupabaseStub([], 99);
    const n = await makeSvc(stub).countExpected();
    expect(n).toBe(0);
  });
});
