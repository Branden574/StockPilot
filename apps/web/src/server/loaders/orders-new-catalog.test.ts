import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub } from '@/test/supabase-mock';

const { createAdminClientMock } = vi.hoisted(() => ({
  createAdminClientMock: vi.fn(),
}));

vi.mock('next/cache', () => ({
  revalidateTag: vi.fn(),
  unstable_cache: vi.fn((fn: unknown) => fn),
}));

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: createAdminClientMock,
}));

import { loadCatalogItems } from './orders-new-catalog';

// Expected-items visibility (mig 0277): the storefront/new-order catalog
// loader must exclude items awaiting their first receipt AT THE QUERY —
// a phantom auto-created from an inbound PO is not orderable until stock
// arrives. (Server-side order-line validation is the second gate; this
// keeps them out of the picker in the first place.)
describe('loadCatalogItems — expected-items exclusion (mig 0277)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('applies eq(awaiting_first_receipt, false) alongside the existing active/non-rental predicates', async () => {
    const stub = makeSupabaseStub({
      // accessKey resolution: non-viewer role → 'ALL' (no category filter).
      'organization_members.select': { data: [{ role: 'admin' }], error: null },
      'inventory_items.select': {
        data: [
          {
            id: 'i-1',
            name: 'Dell XPS',
            sku: 'SKU-1',
            quantity_on_hand: 0,
            warehouse_id: 'wh-1',
            item_type: 'product',
            bin_location: null,
            category_id: null,
            charter_id: null,
            retail_price: 900,
            unit_cost: 700,
            reorder_point: 2,
            rack_number: null,
            rack_row: null,
            book_rack_number: null,
            book_rack_row: null,
          },
        ],
        error: null,
      },
      'stock_reservations.select': { data: [], error: null },
    });
    createAdminClientMock.mockReturnValue(stub.client);

    const items = await loadCatalogItems('org-1', 'wh-1', 'user-1');

    // The unflagged (established, even zero-stock) item still lists.
    expect(items.map((i) => i.id)).toEqual(['i-1']);

    // The items query carries the mig-0277 exclusion, next to the
    // existing predicates — asserted on the recorded builder chain.
    const chains = stub.chainsAll.get('inventory_items.select') ?? [];
    const argsAll = stub.chainArgsAll.get('inventory_items.select') ?? [];
    expect(chains.length).toBe(1);
    const eqCalls = chains[0]!
      .map((m, idx) => ({ m, args: argsAll[0]![idx] }))
      .filter((c) => c.m === 'eq')
      .map((c) => c.args);
    expect(eqCalls).toContainEqual(['awaiting_first_receipt', false]);
    expect(eqCalls).toContainEqual(['status', 'active']);
    expect(eqCalls).toContainEqual(['is_rental', false]);
    expect(eqCalls).toContainEqual(['organization_id', 'org-1']);
    expect(eqCalls).toContainEqual(['warehouse_id', 'wh-1']);
  });
});
