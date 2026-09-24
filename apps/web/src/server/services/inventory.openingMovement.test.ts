import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub, type MockCall } from '@/test/supabase-mock';

/**
 * THE LEDGER INVARIANT IS ABSOLUTE: for every item,
 * SUM(stock_movements.quantity_change) = quantity_on_hand.
 *
 * bulkCreateSizedVariants already enforces it (compensate, then fail loudly).
 * Its two siblings did not: create() never even destructured the insert result
 * (`await …from('stock_movements').insert(…)`) and bulkCreate() console.warn'd
 * "the audit gap is recoverable" and returned success — pattern #26, a fix
 * applied to one of three copies.
 *
 * By the time either insert runs, `trg_seed_initial_level` (0199, AFTER INSERT
 * on inventory_items) has ALREADY seeded an item_stock_levels row at the full
 * quantity, so the failure leaves on-hand = Σlevels = N with zero movements:
 * the item Activity feed, the 14-day sparklines and every reconciliation that
 * sums the ledger are wrong for that item, forever, with nothing logged.
 *
 * Not merely transient: the two RLS floors differ. inventory_items_insert
 * (0212) admits `items:create`; stock_movements_insert (0321) requires staff or
 * `stock:adjust`. A viewer granted items:create through configurable
 * permissions creates stocked items whose ledger row RLS refuses EVERY time.
 */
vi.mock('@/lib/auth/warehouse', () => ({
  getWarehouseAccess: vi.fn(async () => ({ hasAllAccess: true, readableIds: [], writableIds: [] })),
  forcedWarehouseId: vi.fn(async () => null),
  assertWarehouseAccess: vi.fn(async () => undefined),
  ForbiddenError: class extends Error {},
}));
vi.mock('./audit', () => ({
  audit: vi.fn(async () => undefined),
  auditMany: vi.fn(async (payloads: readonly unknown[]) => ({ written: payloads.length, lost: 0 })),
}));
vi.mock('@/lib/ai/embeddings', () => ({ embedInventoryItem: vi.fn(async () => undefined) }));

import { InventoryService } from './inventory';

const RLS_REFUSAL = { message: 'new row violates row-level security policy for table "stock_movements"' };

const CREATE_BASE = {
  name: 'Chromebook',
  unitCost: 0,
  retailPrice: 0,
  quantityOnHand: 40,
  reorderPoint: 0,
  reorderQuantity: 0,
  trackingType: 'none' as const,
  itemType: 'product' as const,
  customFields: {},
  status: 'active' as const,
  expiryPolicy: 'warn' as const,
  warehouseId: 'wh-1',
};

function compensationStub(over: Record<string, unknown> = {}) {
  return makeSupabaseStub({
    'inventory_items.select': { data: null, error: null, count: 0 },
    'organizations.select': { data: { plan: 'enterprise' }, error: null },
    'custom_field_definitions.select': { data: [], error: null },
    'inventory_items.insert': { data: { id: 'itm-new', quantity_on_hand: 40 }, error: null },
    'stock_movements.insert': { data: null, error: RLS_REFUSAL },
    // The compensation RPC (0359) returns the ids it rolled back, then the
    // re-read proves no placement survived.
    'rpc:compensate_opening_stock': (call: MockCall) => ({
      data: (call.args[0]?.[0] as { p_item_ids: string[] }).p_item_ids,
      error: null,
    }),
    'item_stock_levels.select': { data: [], error: null },
    ...over,
  });
}

/** The ids handed to compensate_opening_stock, across every batch. */
function compensatedIds(stub: ReturnType<typeof compensationStub>) {
  return stub.rpcCalls
    .filter((c) => c.name === 'compensate_opening_stock')
    .flatMap((c) => (c.args as { p_item_ids: string[] }).p_item_ids);
}

/** Since 0359 neither table is written directly: the RPC does both. */
function directLedgerWrites(stub: ReturnType<typeof compensationStub>) {
  return [...stub.chains.keys()].filter((k) =>
    /^(item_stock_levels|inventory_items)\.(update|upsert|delete)$/.test(k),
  );
}

beforeEach(() => vi.clearAllMocks());

describe('InventoryService.create — a failed opening movement compensates and throws', () => {
  it('does not return success with stock that no movement explains', async () => {
    const stub = compensationStub();
    const svc = new InventoryService(makeServiceContext(stub.client));

    await expect(svc.create({ ...CREATE_BASE })).rejects.toMatchObject({
      code: 'internal_error',
    });

    // Both invariants restored — the 0199-seeded placement AND the row qty —
    // by the one RPC, never by direct writes.
    expect(compensatedIds(stub)).toEqual(['itm-new']);
    expect(directLedgerWrites(stub)).toEqual([]);
  });

  it('leaves a ZERO-quantity create untouched (no movement, nothing to compensate)', async () => {
    const stub = compensationStub({
      'inventory_items.insert': { data: { id: 'itm-new', quantity_on_hand: 0 }, error: null },
    });
    const svc = new InventoryService(makeServiceContext(stub.client));

    await expect(svc.create({ ...CREATE_BASE, quantityOnHand: 0 })).resolves.toMatchObject({
      id: 'itm-new',
    });
    expect(stub.chains.has('stock_movements.insert')).toBe(false);
  });

  it('throws the harder message when the compensation itself cannot be proved', async () => {
    const stub = compensationStub({
      // The rollback compensated nothing and a placement survives — the
      // phantom-stock state.
      'rpc:compensate_opening_stock': { data: [], error: null },
      'item_stock_levels.select': { data: [{ id: 'lvl-1' }], error: null },
    });
    const svc = new InventoryService(makeServiceContext(stub.client));

    // `internal_error` sanitizes the PUBLIC message (S13); the operator-facing
    // copy lives on internalDetail.
    await expect(svc.create({ ...CREATE_BASE })).rejects.toMatchObject({
      code: 'internal_error',
      internalDetail: expect.stringMatching(/Contact support/),
    });
  });
});

describe('InventoryService.bulkCreate — a failed opening movement compensates and throws', () => {
  const ITEMS = [
    { name: 'A', barcode: 'B-1', itemType: 'product' as const, quantityOnHand: 10, unitCost: 0, retailPrice: 0 },
    { name: 'B', barcode: 'B-2', itemType: 'product' as const, quantityOnHand: 5, unitCost: 0, retailPrice: 0 },
  ];

  it('no longer console.warns a broken ledger and reports created: 2', async () => {
    const stub = compensationStub({
      'inventory_items.insert': {
        data: [
          { id: 'itm-1', quantity_on_hand: 10 },
          { id: 'itm-2', quantity_on_hand: 5 },
        ],
        error: null,
      },
    });
    const svc = new InventoryService(makeServiceContext(stub.client));

    await expect(
      svc.bulkCreate({ warehouseId: 'wh-1', items: ITEMS }),
    ).rejects.toMatchObject({ code: 'internal_error' });

    expect(compensatedIds(stub).sort()).toEqual(['itm-1', 'itm-2']);
    expect(directLedgerWrites(stub)).toEqual([]);
  });

  it('a batch with no stocked rows still succeeds (no movement is written at all)', async () => {
    const stub = compensationStub({
      'inventory_items.insert': {
        data: [{ id: 'itm-1', quantity_on_hand: 0 }],
        error: null,
      },
    });
    const svc = new InventoryService(makeServiceContext(stub.client));

    const res = await svc.bulkCreate({
      warehouseId: 'wh-1',
      items: [{ ...ITEMS[0]!, quantityOnHand: 0 }],
    });
    expect(res.created).toBe(1);
    expect(stub.chains.has('stock_movements.insert')).toBe(false);
  });
});
