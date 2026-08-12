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

// The PO line-item picker's server search. Two guarantees live here:
//
//   1. `itemTypes: ['product','book']` is what makes a BOOK reachable at all —
//      list() otherwise falls back to `item_type = 'product'` and every book in
//      the org is invisible to the picker (the original bug).
//   2. `isbnVariants` folds ISBN-10 ⇄ ISBN-13 equivalence into the SAME `q`
//      OR-clause. A second `.or()` call would AND against the first and match
//      nothing, and a book is stocked under only ONE of its two ISBN forms
//      (barcode = ISBN), so a buyer typing the other form finds nothing
//      without this.
//
// Everything else the picker relies on (org scoping, soft-delete, archived,
// rentals) is list()'s own long-standing behavior; the last test pins that the
// PO filter set does not switch any of it off.

function buildSupabaseStub(rows: Array<Record<string, unknown>> = []) {
  const eqCalls: Array<[string, unknown]> = [];
  const inCalls: Array<[string, unknown]> = [];
  const isCalls: Array<[string, unknown]> = [];
  const orCalls: string[] = [];
  const chain: any = {
    select: () => chain,
    eq: (col: string, val: unknown) => { eqCalls.push([col, val]); return chain; },
    is: (col: string, val: unknown) => { isCalls.push([col, val]); return chain; },
    order: () => chain,
    range: () => chain,
    in: (col: string, val: unknown) => { inCalls.push([col, val]); return chain; },
    or: (clause: string) => { orCalls.push(clause); return chain; },
    gt: () => chain,
    gte: () => chain,
    lt: () => chain,
    lte: () => chain,
    filter: () => chain,
    then: (cb: (r: { data: unknown; count: number; error: null }) => unknown) =>
      cb({ data: rows, count: rows.length, error: null }),
  };
  return {
    from: () => chain,
    _eqCalls: eqCalls,
    _inCalls: inCalls,
    _isCalls: isCalls,
    _orCalls: orCalls,
  };
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

/** The exact filter set the PO create/edit/recurring pages send. */
const PO_PICKER_FILTERS = {
  expected: 'any' as const,
  itemTypes: ['product', 'book'] as Array<'product' | 'book'>,
};

describe('InventoryService.list — the PO picker item-type set', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getWarehouseAccess).mockResolvedValue({
      hasAllAccess: true,
      readableIds: [],
    } as never);
  });

  it("itemTypes ['product','book'] replaces the item_type='product' default, so books are reachable", async () => {
    const stub = buildSupabaseStub();
    await makeSvc(stub).list(PO_PICKER_FILTERS);
    expect(stub._inCalls).toContainEqual(['item_type', ['product', 'book']]);
    // The regression itself: the default equality filter must be GONE.
    expect(stub._eqCalls).not.toContainEqual(['item_type', 'product']);
  });

  it('a default list call (no itemTypes) still narrows to products — the Items page contract is untouched', async () => {
    const stub = buildSupabaseStub();
    await makeSvc(stub).list({});
    expect(stub._eqCalls).toContainEqual(['item_type', 'product']);
    expect(stub._inCalls.filter((c) => c[0] === 'item_type')).toEqual([]);
  });

  it('keeps org scoping, soft-delete, active-only and the rental exclusion under the PO filter set', async () => {
    const stub = buildSupabaseStub();
    await makeSvc(stub).list({ ...PO_PICKER_FILTERS, q: 'charlotte' });
    // Another org's book can never appear.
    expect(stub._eqCalls).toContainEqual(['organization_id', 'org-1']);
    // A deleted book can never appear.
    expect(stub._isCalls).toContainEqual(['deleted_at', null]);
    // An archived book can never appear (no status filter = active only).
    expect(stub._eqCalls).toContainEqual(['status', 'active']);
    // A rental is a separate inventory class and is never offered.
    expect(stub._eqCalls).toContainEqual(['is_rental', false]);
  });

  it("expected:'any' still applies NO awaiting_first_receipt predicate, so an expected book is offerable", async () => {
    const stub = buildSupabaseStub();
    await makeSvc(stub).list(PO_PICKER_FILTERS);
    expect(stub._eqCalls.filter((c) => c[0] === 'awaiting_first_receipt')).toEqual([]);
  });
});

describe('InventoryService.list — ISBN-variant matching (opt-in)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getWarehouseAccess).mockResolvedValue({
      hasAllAccess: true,
      readableIds: [],
    } as never);
  });

  it('appends barcode.in.(…) with BOTH ISBN forms inside the SAME q OR-clause', async () => {
    const stub = buildSupabaseStub();
    await makeSvc(stub).list({
      ...PO_PICKER_FILTERS,
      q: '9780142407332',
      // What isbnVariants('9780142407332') returns: the typed ISBN-13 and its
      // ISBN-10 counterpart 014240733X.
      isbnVariants: ['9780142407332', '014240733X'],
    });
    expect(stub._orCalls).toContain(
      'name.ilike.%9780142407332%,sku.ilike.%9780142407332%,' +
        'barcode.ilike.%9780142407332%,model_number.ilike.%9780142407332%,' +
        'barcode.in.("9780142407332","014240733X")',
    );
  });

  it('without isbnVariants the OR clause is the four-field one, byte for byte', async () => {
    const stub = buildSupabaseStub();
    await makeSvc(stub).list({ q: 'charlotte' });
    expect(stub._orCalls).toContain(
      'name.ilike.%charlotte%,sku.ilike.%charlotte%,' +
        'barcode.ilike.%charlotte%,model_number.ilike.%charlotte%',
    );
    expect(stub._orCalls.some((c) => c.includes('barcode.in.'))).toBe(false);
  });

  it('drops anything that is not a 10/13-character ISBN before it reaches the filter string', async () => {
    const stub = buildSupabaseStub();
    await makeSvc(stub).list({
      q: 'x',
      // A crafted value trying to escape the clause, and a too-short number.
      isbnVariants: ['1,2)or(barcode.is.null', '12345'],
    });
    expect(stub._orCalls).toContain(
      'name.ilike.%x%,sku.ilike.%x%,barcode.ilike.%x%,model_number.ilike.%x%',
    );
    expect(stub._orCalls.some((c) => c.includes('barcode.in.'))).toBe(false);
  });

  it('the parallel value-footer sum query gets the SAME clause (both builders record it)', async () => {
    const stub = buildSupabaseStub();
    await makeSvc(stub).list({
      q: '0142407333',
      isbnVariants: ['0142407333'],
    });
    const withIsbn = stub._orCalls.filter((c) => c.includes('barcode.in.("0142407333")'));
    expect(withIsbn.length).toBeGreaterThanOrEqual(2);
  });
});
