import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub, type MockCall } from '@/test/supabase-mock';

// 2026-09-24 (owner DC4 report, on the Duplicate button). duplicate_inventory_item
// copies the original's primary location (a SITE such as "DC4") and the seed
// trigger puts the copy's stock AT that site. The dialog requires a rack, so the
// copy's stock must end on that rack, through the same placement helper a
// manual create uses.

vi.mock('@/lib/auth/warehouse', () => ({
  getWarehouseAccess: vi.fn(async () => ({ hasAllAccess: true, readableIds: [] })),
  forcedWarehouseId: vi.fn(async () => null),
  assertWarehouseAccess: vi.fn(async () => undefined),
  ForbiddenError: class extends Error {},
}));
vi.mock('./audit', () => ({
  audit: vi.fn(async () => undefined),
  auditMany: vi.fn(async (payloads: readonly unknown[]) => ({ written: payloads.length, lost: 0 })),
}));
vi.mock('@/lib/ai/embeddings', () => ({ embedInventoryItem: vi.fn(async () => undefined) }));
const { reportError } = vi.hoisted(() => ({ reportError: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError }));

import { InventoryService } from './inventory';

function buildStub() {
  return makeSupabaseStub({
    'inventory_items.select': { data: { sku: 'SP-POLO', warehouse_id: 'wh-1' }, error: null },
    'rpc:duplicate_inventory_item': { data: 'dup-1', error: null },
    'locations.select': { data: [{ id: 'rack-31c', name: '31-C' }], error: null },
    'item_stock_levels.select': {
      data: [{ item_id: 'dup-1', location_id: 'site-dc4', quantity: 4 }],
      error: null,
    },
    'rpc:transfer_stock': { data: null, error: null },
  });
}

const BASE = {
  originalId: '00000000-0000-0000-0000-000000000001',
  itemType: 'product' as const,
  rackNumber: '31',
  rackRow: 'C',
  quantity: 4,
};

describe('InventoryService.duplicateItem puts the copy on the dialog rack', () => {
  beforeEach(() => vi.clearAllMocks());

  it('moves the stock the trigger seeded at the SITE onto the typed rack', async () => {
    const stub = buildStub();
    const svc = new InventoryService(makeServiceContext(stub.client));

    await expect(svc.duplicateItem(BASE as never)).resolves.toEqual({
      id: 'dup-1',
      placementFailed: null,
    });

    const transfer = stub.rpcCalls.find((c) => c.name === 'transfer_stock');
    expect(transfer?.args).toMatchObject({
      p_item_id: 'dup-1',
      p_from_location_id: 'site-dc4',
      p_to_location_id: 'rack-31c',
      p_quantity: 4,
    });
  });

  it('a copy with no stock moves nothing', async () => {
    const stub = buildStub();
    const svc = new InventoryService(makeServiceContext(stub.client));
    await svc.duplicateItem({ ...BASE, quantity: 0 } as never);
    expect(stub.rpcCalls.find((c) => c.name === 'transfer_stock')).toBeUndefined();
  });

  it('never moves a product copy to Unplaced: its stock goes onto the rack', async () => {
    const stub = buildStub();
    const svc = new InventoryService(makeServiceContext(stub.client));
    await svc.duplicateItem(BASE as never);
    const targets = stub.rpcCalls
      .filter((c) => c.name === 'transfer_stock')
      .map((c) => (c.args as { p_to_location_id: string }).p_to_location_id);
    expect(targets).toEqual(['rack-31c']);
  });
});

// B28 (2026-10-25): a duplicated BOOK is never placed by the duplicate (its
// crate is chosen at put-away), so its stock stayed where the seed trigger put
// it: AT the original's primary location, a site such as "DC4". Counted as
// placed, never on the put-away list, shown as "No rack": the owner's DC4
// report, still open on a book's Duplicate. The owner's no-rack rule (#253):
// stock nobody placed waits in the warehouse's Unplaced bucket, awaiting
// put-away, and the primary location stays a label.
describe('InventoryService.duplicateItem: a book copy waits in Unplaced', () => {
  beforeEach(() => vi.clearAllMocks());

  const BOOK = {
    originalId: '00000000-0000-0000-0000-000000000002',
    itemType: 'book' as const,
    rackNumber: '40',
    rackRow: 'B',
    crateColor: 'blue',
    crateNumber: '4',
    quantity: 3,
  };
  const SITE_HOLDING = {
    item_id: 'dup-b',
    location_id: 'site-dc4',
    quantity: 3,
    locations: { name: 'DC4', kind: null, type: 'warehouse' },
  };

  /** Answers the Unplaced-bucket lookup by its own filters, never a rack. */
  function bucketLookup(call: MockCall) {
    const eqs = call.methods.flatMap((m, i) =>
      m === 'eq' ? [call.args[i] as [string, unknown]] : [],
    );
    const scoped =
      eqs.some(([c, v]) => c === 'organization_id' && v === 'org-test') &&
      eqs.some(([c, v]) => c === 'warehouse_id' && v === 'wh-1') &&
      eqs.some(([c, v]) => c === 'kind' && v === 'unplaced') &&
      call.methods.includes('is');
    return { data: scoped ? [{ id: 'unplaced-wh1' }] : [], error: null };
  }

  function bookStub(over: Record<string, unknown> = {}) {
    return makeSupabaseStub({
      'inventory_items.select': {
        data: { sku: 'SP-MAUS', warehouse_id: 'wh-1', charter_id: null, item_type: 'book' },
        error: null,
      },
      'rpc:duplicate_inventory_item': { data: 'dup-b', error: null },
      'item_stock_levels.select': { data: [SITE_HOLDING], error: null },
      'locations.select': bucketLookup,
      'rpc:transfer_stock': { data: null, error: null },
      ...over,
    } as never);
  }

  const transfers = (stub: ReturnType<typeof bookStub>) =>
    stub.rpcCalls.filter((c) => c.name === 'transfer_stock').map((c) => c.args);

  it('moves the stock seeded at the SITE to the warehouse Unplaced bucket, never onto the typed rack', async () => {
    const stub = bookStub();
    const svc = new InventoryService(makeServiceContext(stub.client));

    await expect(svc.duplicateItem(BOOK as never)).resolves.toEqual({
      id: 'dup-b',
      placementFailed: null,
    });

    expect(transfers(stub)).toEqual([
      expect.objectContaining({
        p_item_id: 'dup-b',
        p_from_location_id: 'site-dc4',
        p_to_location_id: 'unplaced-wh1',
        p_quantity: 3,
      }),
    ]);
    // The rack and crate the dialog named stay the copy's label; nothing is
    // looked up or created by name.
    expect(stub.fromCalls).not.toContain('warehouses');
    expect(stub.chainsAll.get('locations.insert')).toBeUndefined();
  });

  it('leaves stock the trigger already seeded in Unplaced where it is', async () => {
    const stub = bookStub({
      'item_stock_levels.select': {
        data: [
          {
            ...SITE_HOLDING,
            location_id: 'unplaced-wh1',
            locations: { name: 'Unplaced', kind: 'unplaced', type: 'other' },
          },
        ],
        error: null,
      },
    });
    const svc = new InventoryService(makeServiceContext(stub.client));

    await expect(svc.duplicateItem(BOOK as never)).resolves.toEqual({
      id: 'dup-b',
      placementFailed: null,
    });
    expect(transfers(stub)).toEqual([]);
  });

  it('keeps the copy and says where its stock was left when the move is refused', async () => {
    const stub = bookStub({
      'rpc:transfer_stock': { data: null, error: { message: 'forbidden', code: '42501' } },
    });
    const svc = new InventoryService(makeServiceContext(stub.client));

    await expect(svc.duplicateItem(BOOK as never)).resolves.toEqual({
      id: 'dup-b',
      placementFailed: null,
      stockLeftAt: { locationName: 'DC4' },
    });
  });

  it('says where the stock was left when the warehouse has no Unplaced bucket in reach', async () => {
    const stub = bookStub({ 'locations.select': { data: [], error: null } });
    const svc = new InventoryService(makeServiceContext(stub.client));

    await expect(svc.duplicateItem(BOOK as never)).resolves.toEqual({
      id: 'dup-b',
      placementFailed: null,
      stockLeftAt: { locationName: 'DC4' },
    });
    expect(transfers(stub)).toEqual([]);
  });

  it('says so, without a name, when the holdings cannot be read', async () => {
    const stub = bookStub({
      'item_stock_levels.select': { data: null, error: { message: 'timeout' } },
    });
    const svc = new InventoryService(makeServiceContext(stub.client));

    await expect(svc.duplicateItem(BOOK as never)).resolves.toEqual({
      id: 'dup-b',
      placementFailed: null,
      stockLeftAt: { locationName: null },
    });
    expect(transfers(stub)).toEqual([]);
  });

  it('reads and moves nothing for a copy with no stock', async () => {
    const stub = bookStub();
    const svc = new InventoryService(makeServiceContext(stub.client));

    await svc.duplicateItem({ ...BOOK, quantity: 0 } as never);
    expect(stub.fromCalls).not.toContain('item_stock_levels');
    expect(transfers(stub)).toEqual([]);
  });

  // Integrator decision (B28, 2026-10-25): the copy's holdings are read through
  // the caller's own client. Since 0371 a member below manager reads holdings
  // only in the warehouses they are assigned to (staff with the all-warehouses
  // setting too), so the copy's seeded holding can be out of view; and an inner
  // join on locations dropped a holding whose location row the caller could not
  // read. Both came back as "nothing outside Unplaced", and the dialog said the
  // stock was in Unplaced while it was still at the site. Stock the caller's
  // reads do not account for is now reported, without a place name.
  describe('stock the reads do not account for is reported, never read as in Unplaced', () => {
    const asStaff = (stub: ReturnType<typeof bookStub>) =>
      new InventoryService(makeServiceContext(stub.client, { role: 'staff' }));
    const reported = () =>
      expect(reportError).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          tag: 'inventory.duplicate.book_to_unplaced',
          level: 'warning',
          organizationId: 'org-test',
        }),
      );
    /** item_holdings_elsewhere's row for the copy: what sits out of view. */
    const elsewhere = (h: { staged?: number; unplaced?: number; placed?: number }) => ({
      data: [
        {
          item_id: 'dup-b',
          staged: h.staged ?? 0,
          unplaced: h.unplaced ?? 0,
          placed: h.placed ?? 0,
          placed_location_ids: h.placed ? ['site-elsewhere'] : [],
          placed_rack_locations: 0,
        },
      ],
      error: null,
    });

    it('a seeded holding hidden from the caller: an empty answer for a quantity of 3', async () => {
      const stub = bookStub({ 'item_stock_levels.select': { data: [], error: null } });

      await expect(asStaff(stub).duplicateItem(BOOK as never)).resolves.toEqual({
        id: 'dup-b',
        placementFailed: null,
        stockLeftAt: { locationName: null },
      });
      expect(transfers(stub)).toEqual([]);
      reported();
    });

    it('stock placed in a warehouse the caller cannot see', async () => {
      const stub = bookStub({
        'item_stock_levels.select': { data: [], error: null },
        'rpc:item_holdings_elsewhere': elsewhere({ placed: 3 }),
      });

      await expect(asStaff(stub).duplicateItem(BOOK as never)).resolves.toMatchObject({
        stockLeftAt: { locationName: null },
      });
      expect(stub.rpcCalls.find((c) => c.name === 'item_holdings_elsewhere')?.args).toEqual({
        p_item_ids: ['dup-b'],
      });
      expect(transfers(stub)).toEqual([]);
      reported();
    });

    it('stock in other warehouses that cannot be read', async () => {
      const stub = bookStub({
        'item_stock_levels.select': { data: [], error: null },
        'rpc:item_holdings_elsewhere': { data: null, error: { message: 'timeout' } },
      });

      await expect(asStaff(stub).duplicateItem(BOOK as never)).resolves.toMatchObject({
        stockLeftAt: { locationName: null },
      });
      reported();
    });

    it('a holding whose location row cannot be read is reported, not dropped', async () => {
      const stub = bookStub({
        'item_stock_levels.select': { data: [{ ...SITE_HOLDING, locations: null }], error: null },
      });

      await expect(asStaff(stub).duplicateItem(BOOK as never)).resolves.toMatchObject({
        stockLeftAt: { locationName: null },
      });
      // Its place is unknown, so it is not moved: it could be Staging.
      expect(transfers(stub)).toEqual([]);
      reported();
    });

    it('reads the place with a left embed, so a holding at an unreadable location still arrives', async () => {
      const stub = bookStub();
      await asStaff(stub).duplicateItem(BOOK as never);

      const select = stub.chainArgsAll.get('item_stock_levels.select')?.[0]?.[0]?.[0];
      expect(select).toMatch(/\blocations\(/);
      expect(select).not.toMatch(/!inner/);
    });

    it('a holding the reads see moves, and the stock they do not see is still reported', async () => {
      const stub = bookStub({
        'item_stock_levels.select': {
          data: [{ ...SITE_HOLDING, quantity: 2 }],
          error: null,
        },
        'rpc:item_holdings_elsewhere': elsewhere({ placed: 1 }),
      });

      await expect(asStaff(stub).duplicateItem(BOOK as never)).resolves.toMatchObject({
        stockLeftAt: { locationName: null },
      });
      expect(transfers(stub)).toEqual([
        expect.objectContaining({
          p_from_location_id: 'site-dc4',
          p_to_location_id: 'unplaced-wh1',
          p_quantity: 2,
        }),
      ]);
      reported();
    });

    it('stock out of view that sits in Unplaced is in Unplaced: nothing to move or report', async () => {
      const stub = bookStub({
        'item_stock_levels.select': { data: [], error: null },
        'rpc:item_holdings_elsewhere': elsewhere({ unplaced: 3 }),
      });

      await expect(asStaff(stub).duplicateItem(BOOK as never)).resolves.toEqual({
        id: 'dup-b',
        placementFailed: null,
      });
      expect(transfers(stub)).toEqual([]);
      expect(reportError).not.toHaveBeenCalled();
    });

    it('holdings that add up to the copy need no question about other warehouses', async () => {
      const stub = bookStub({
        'rpc:item_holdings_elsewhere': { data: null, error: { message: 'timeout' } },
      });

      // The visible holding is all 3 units: the failed read of other warehouses
      // changes nothing, and the move runs as for a manager.
      await expect(asStaff(stub).duplicateItem(BOOK as never)).resolves.toEqual({
        id: 'dup-b',
        placementFailed: null,
      });
      expect(transfers(stub)).toHaveLength(1);
      expect(reportError).not.toHaveBeenCalled();
    });

    it('a manager sees every holding: an empty answer is still not all 3 units', async () => {
      // No hidden stock to ask about (managers skip the call), and the seed
      // trigger can fail without failing the copy (0199): no holding at all.
      const stub = bookStub({ 'item_stock_levels.select': { data: [], error: null } });
      const svc = new InventoryService(makeServiceContext(stub.client));

      await expect(svc.duplicateItem(BOOK as never)).resolves.toMatchObject({
        stockLeftAt: { locationName: null },
      });
      expect(stub.rpcCalls.find((c) => c.name === 'item_holdings_elsewhere')).toBeUndefined();
      reported();
    });
  });

  // The dialog sends the record's own type; a request that names the other
  // type would run the product branch over a book (onto a bare rack, its crate
  // fields dropped by 0299's book branch) or the reverse. Refused before the
  // copy is made.
  it.each([
    ['a book sent as a product', 'book', { ...BASE }],
    ['a product sent as a book', 'product', { ...BOOK }],
  ])('refuses %s before anything is written', async (_label, originalType, input) => {
    const stub = bookStub({
      'inventory_items.select': {
        data: { sku: 'SP-X', warehouse_id: 'wh-1', charter_id: null, item_type: originalType },
        error: null,
      },
    });
    const svc = new InventoryService(makeServiceContext(stub.client));

    await expect(svc.duplicateItem(input as never)).rejects.toMatchObject({
      code: 'validation_error',
    });
    expect(stub.rpcCalls).toEqual([]);
  });
});
