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
// pickers, /api/items/search), return ONLY them under `expected: true`
// (the "Expected" chip view), and apply NO predicate under
// `expected: 'any'` (PO create/edit/recurring pickers, vendor mappings,
// ids-narrowed exports, AI search). countExpected backs the chip's badge.

function buildSupabaseStub(rows: Array<Record<string, unknown>>, count?: number) {
  const eqCalls: Array<[string, unknown]> = [];
  const inCalls: Array<[string, unknown]> = [];
  const orCalls: string[] = [];
  const filterCalls: Array<[string, string, unknown]> = [];
  const chain: any = {
    select: () => chain,
    eq: (col: string, val: unknown) => { eqCalls.push([col, val]); return chain; },
    is: () => chain,
    order: () => chain,
    range: () => chain,
    in: (col: string, val: unknown) => { inCalls.push([col, val]); return chain; },
    or: (clause: string) => { orCalls.push(clause); return chain; },
    gt: () => chain,
    filter: (col: string, op: string, val: unknown) => {
      filterCalls.push([col, op, val]);
      return chain;
    },
    then: (cb: (r: { data: unknown; count: number; error: null }) => unknown) =>
      cb({ data: rows, count: count ?? rows.length, error: null }),
  };
  return { from: () => chain, _eqCalls: eqCalls, _inCalls: inCalls, _orCalls: orCalls, _filterCalls: filterCalls };
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

  it("expected: 'any' applies NO awaiting_first_receipt predicate — both populations return", async () => {
    const stub = buildSupabaseStub([]);
    await makeSvc(stub).list({ expected: 'any' });
    const awaitingCalls = stub._eqCalls.filter((c) => c[0] === 'awaiting_first_receipt');
    expect(awaitingCalls).toEqual([]);
  });

  it("expected: 'any' returns flagged AND unflagged rows untouched (no post-filtering)", async () => {
    const rows = [
      { id: 'a', quantity_on_hand: 0, reorder_point: 0, awaiting_first_receipt: true },
      { id: 'b', quantity_on_hand: 5, reorder_point: 0, awaiting_first_receipt: false },
    ];
    const stub = buildSupabaseStub(rows);
    const result = await makeSvc(stub).list({ expected: 'any' });
    expect(result.items.map((i) => i.id).sort()).toEqual(['a', 'b']);
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

  it('counts flagged rows of the view item_type ACROSS lifecycles (no status filter) and returns the head count', async () => {
    const stub = buildSupabaseStub([], 3);
    const n = await makeSvc(stub).countExpected({ itemType: 'product' });
    expect(n).toBe(3);
    expect(stub._eqCalls).toContainEqual(['awaiting_first_receipt', true]);
    // The Expected view spans lifecycles (mobile listStatusPredicate
    // lifecycle:null) — a manually-archived flagged row must be counted.
    expect(stub._eqCalls.map((c) => c[0])).not.toContain('status');
    expect(stub._eqCalls).toContainEqual(['is_rental', false]);
    expect(stub._eqCalls).toContainEqual(['item_type', 'product']);
    expect(stub._eqCalls).toContainEqual(['organization_id', 'org-1']);
  });

  it('applies the view\'s active q / category / location / charter / rack filters so the badge N matches the rows', async () => {
    const stub = buildSupabaseStub([], 1);
    const n = await makeSvc(stub).countExpected({
      itemType: 'product',
      q: 'sticker',
      categoryIds: ['cat-1'],
      locationIds: ['loc-1'],
      charterIds: ['generic'],
      rack: '38-A',
    });
    expect(n).toBe(1);
    // q → the same 4-field ilike .or() clause list() builds.
    expect(
      stub._orCalls.some((c) => c.includes('name.ilike.%sticker%') && c.includes('model_number.ilike.%sticker%')),
    ).toBe(true);
    expect(stub._inCalls).toContainEqual(['category_id', ['cat-1']]);
    expect(stub._inCalls).toContainEqual(['primary_location_id', ['loc-1']]);
    // rack "38-A" → the neutral rack keys for non-book item types.
    // REWRITTEN 2026-07-23 (rack-shape incident): a number+row rack now emits
    // ONE tolerant .or() (decomposed pair OR the whole label in the number key)
    // instead of two .filter() calls, shared verbatim with list() so the badge
    // count can never disagree with the rows it counts.
    expect(stub._orCalls).toContain(
      'and(custom_fields->>rack_number.eq.38,custom_fields->>rack_row.eq.A),' +
        'custom_fields->>rack_number.eq.38-A',
    );
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
