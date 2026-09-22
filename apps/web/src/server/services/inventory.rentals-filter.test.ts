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

// Rentals are their own inventory class. Every regular list call must list
// NON-rentals only, and `rentalsOnly: true` (the web Rentals -> Items page)
// must list rentals ONLY, in the query. Until 2026-09-22 the rentals page
// passed `includeRentals`, which merely dropped the filter: it fetched the
// first 50 of every item and kept the rentals among them, so an organization
// whose two rentals were the 76th and 160th most recently updated of 404
// items saw "No rental items yet".

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

describe('InventoryService.list — rentals are filtered in the query', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getWarehouseAccess).mockResolvedValue({
      hasAllAccess: true,
      readableIds: [],
    } as never);
  });

  const rentalCalls = (stub: ReturnType<typeof buildSupabaseStub>) =>
    stub._eqCalls.filter((c) => c[0] === 'is_rental');

  it('a default call lists non-rentals only, in the page AND the value sum', async () => {
    const stub = buildSupabaseStub([]);
    await makeSvc(stub).list({});
    expect(rentalCalls(stub)).toEqual([
      ['is_rental', false],
      ['is_rental', false],
    ]);
  });

  it('rentalsOnly lists rentals ONLY — the database pages them, so page one is rentals', async () => {
    const stub = buildSupabaseStub([]);
    await makeSvc(stub).list({ rentalsOnly: true, itemType: 'all' });
    expect(rentalCalls(stub)).toEqual([
      ['is_rental', true],
      ['is_rental', true],
    ]);
    // Any type: a rental can be a product or a book.
    expect(stub._eqCalls.map((c) => c[0])).not.toContain('item_type');
  });

  it('rentalsOnly: false is the default, not "everything"', async () => {
    const stub = buildSupabaseStub([]);
    await makeSvc(stub).list({ rentalsOnly: false });
    expect(rentalCalls(stub)).toEqual([
      ['is_rental', false],
      ['is_rental', false],
    ]);
  });

  it('total is the count the database reports for rentals, not the rows on the page', async () => {
    const stub = buildSupabaseStub(
      [{ id: 'r1', quantity_on_hand: 1, reorder_point: 0, is_rental: true }],
      7,
    );
    const result = await makeSvc(stub).list({ rentalsOnly: true, itemType: 'all', limit: 1 });
    expect(result.total).toBe(7);
  });
});
