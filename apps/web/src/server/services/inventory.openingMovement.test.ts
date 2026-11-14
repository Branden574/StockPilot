import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub, type MockCall } from '@/test/supabase-mock';

/**
 * Opening stock goes through the stock ledger.
 *
 * create() and bulkCreate() insert their items with nothing on hand and then
 * open the quantity each item asked for through open_item_stock, which writes
 * the holding, on-hand and the 'initial' movement in one transaction. Neither
 * writes stock_movements, item_stock_levels or on-hand directly. A refused
 * opening leaves the items at 0 with nothing written, and the caller reads the
 * "saved with zero on hand" sentence. bulkCreate keys each opening on the
 * quantity its SKU asked for, never on the inserted row (which is 0).
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
vi.spyOn(console, 'error').mockImplementation(() => {});

import { InventoryService } from './inventory';

const STOCK_REFUSAL = { message: 'forbidden', code: '42501', hint: 'stock:adjust' };

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

function openingStub(over: Record<string, unknown> = {}) {
  return makeSupabaseStub({
    'inventory_items.select': { data: null, error: null, count: 0 },
    'organizations.select': { data: { plan: 'enterprise' }, error: null },
    'custom_field_definitions.select': { data: [], error: null },
    'inventory_items.insert': { data: { id: 'itm-new', quantity_on_hand: 0 }, error: null },
    'rpc:open_item_stock': (call: MockCall) => ({
      data: ((call.args[0]?.[0] as { p_lines: Array<{ itemId: string }> }).p_lines ?? []).map((l) => ({
        opened_item_id: l.itemId,
        opened_location_id: 'loc-unplaced',
        opened_movement_id: `mv-${l.itemId}`,
      })),
      error: null,
    }),
    ...over,
  });
}

/** Every line handed to open_item_stock, across every call. */
function openedLines(stub: ReturnType<typeof openingStub>) {
  return stub.rpcCalls
    .filter((c) => c.name === 'open_item_stock')
    .flatMap((c) => (c.args as { p_lines: Array<{ itemId: string; quantity: number }> }).p_lines);
}

/** No ledger table, and no on-hand, is written directly. */
function directLedgerWrites(stub: ReturnType<typeof openingStub>) {
  return [...stub.chains.keys()].filter(
    (k) =>
      /^(item_stock_levels|stock_movements)\.(insert|update|upsert|delete)$/.test(k) ||
      /^inventory_items\.(update|upsert|delete)$/.test(k),
  );
}

/** The payload of the first inventory_items insert. */
function insertedPayload(stub: ReturnType<typeof openingStub>) {
  const args = stub.chainArgsAll.get('inventory_items.insert')?.[0];
  return args?.[0]?.[0] as Record<string, unknown> | Array<Record<string, unknown>>;
}

beforeEach(() => vi.clearAllMocks());

describe('InventoryService.create: opening stock through open_item_stock', () => {
  it('inserts the item at 0, opens the requested quantity in the organization, and returns it', async () => {
    const stub = openingStub();
    const svc = new InventoryService(makeServiceContext(stub.client));

    const item = await svc.create({ ...CREATE_BASE });

    expect((insertedPayload(stub) as Record<string, unknown>).quantity_on_hand).toBe(0);
    const calls = stub.rpcCalls.filter((c) => c.name === 'open_item_stock');
    expect(calls).toHaveLength(1);
    expect((calls[0]!.args as { p_org_id: string }).p_org_id).toBe('org-test');
    expect(openedLines(stub)).toEqual([{ itemId: 'itm-new', quantity: 40 }]);
    expect(directLedgerWrites(stub)).toEqual([]);
    expect(item).toMatchObject({ id: 'itm-new', quantity_on_hand: 40 });
  });

  it('a refused opening leaves the item at 0 and says so, writing nothing else', async () => {
    const stub = openingStub({ 'rpc:open_item_stock': { data: null, error: STOCK_REFUSAL } });
    const svc = new InventoryService(makeServiceContext(stub.client));

    await expect(svc.create({ ...CREATE_BASE })).rejects.toMatchObject({
      code: 'conflict',
      message:
        'This item was saved with zero on hand: you do not have permission to add stock. Someone who can adjust stock must set its quantity.',
      details: expect.objectContaining({ reason: 'opening_stock_not_recorded', itemIds: ['itm-new'] }),
    });
    expect(directLedgerWrites(stub)).toEqual([]);
  });

  it('a ZERO-quantity create opens nothing', async () => {
    const stub = openingStub();
    const svc = new InventoryService(makeServiceContext(stub.client));

    await expect(svc.create({ ...CREATE_BASE, quantityOnHand: 0 })).resolves.toMatchObject({
      id: 'itm-new',
    });
    expect(stub.rpcCalls.filter((c) => c.name === 'open_item_stock')).toEqual([]);
  });

  it('a negative quantity is refused before anything is written', async () => {
    const stub = openingStub();
    const svc = new InventoryService(makeServiceContext(stub.client));

    await expect(svc.create({ ...CREATE_BASE, quantityOnHand: -3 })).rejects.toMatchObject({
      code: 'validation_error',
      message: 'Enter 0 or more.',
    });
    expect(stub.chains.has('inventory_items.insert')).toBe(false);
    expect(stub.rpcCalls.filter((c) => c.name === 'open_item_stock')).toEqual([]);
  });
});

describe('InventoryService.bulkCreate: opening stock through open_item_stock', () => {
  const ITEMS = [
    { name: 'A', barcode: 'B-1', sku: 'SKU-A', itemType: 'product' as const, quantityOnHand: 10, unitCost: 0, retailPrice: 0 },
    { name: 'B', barcode: 'B-2', sku: 'SKU-B', itemType: 'product' as const, quantityOnHand: 5, unitCost: 0, retailPrice: 0 },
    { name: 'C', barcode: 'B-3', sku: 'SKU-C', itemType: 'product' as const, quantityOnHand: 0, unitCost: 0, retailPrice: 0 },
  ];

  it('inserts every row at 0 and opens each SKU with its own quantity (mapped by SKU, whatever the row order)', async () => {
    const stub = openingStub({
      'inventory_items.select': { data: [], error: null, count: 0 },
      // Rows come back in a different order from the request.
      'inventory_items.insert': {
        data: [
          { id: 'itm-c', sku: 'SKU-C' },
          { id: 'itm-b', sku: 'SKU-B' },
          { id: 'itm-a', sku: 'SKU-A' },
        ],
        error: null,
      },
    });
    const svc = new InventoryService(makeServiceContext(stub.client));

    const res = await svc.bulkCreate({ warehouseId: 'wh-1', items: ITEMS });

    expect(res.created).toBe(3);
    const payload = insertedPayload(stub) as Array<Record<string, unknown>>;
    expect(payload.map((r) => r.quantity_on_hand)).toEqual([0, 0, 0]);
    expect(stub.chainArgsAll.get('inventory_items.insert')?.[0]).toBeDefined();
    expect(openedLines(stub).sort((a, b) => a.itemId.localeCompare(b.itemId))).toEqual([
      { itemId: 'itm-a', quantity: 10 },
      { itemId: 'itm-b', quantity: 5 },
    ]);
    expect(directLedgerWrites(stub)).toEqual([]);
  });

  it('a refused opening throws the zero-on-hand sentence for the batch', async () => {
    const stub = openingStub({
      'inventory_items.select': { data: [], error: null, count: 0 },
      'inventory_items.insert': {
        data: [
          { id: 'itm-a', sku: 'SKU-A' },
          { id: 'itm-b', sku: 'SKU-B' },
        ],
        error: null,
      },
      'rpc:open_item_stock': { data: null, error: STOCK_REFUSAL },
    });
    const svc = new InventoryService(makeServiceContext(stub.client));

    await expect(
      svc.bulkCreate({ warehouseId: 'wh-1', items: ITEMS.slice(0, 2) }),
    ).rejects.toMatchObject({
      code: 'conflict',
      message: expect.stringMatching(/^These items were saved with zero on hand: you do not have permission to add stock\./),
    });
    expect(directLedgerWrites(stub)).toEqual([]);
  });

  it('a row whose SKU is not one the request asked for is never opened at 0 in silence: the person is told', async () => {
    const stub = openingStub({
      'inventory_items.select': { data: [], error: null, count: 0 },
      // The database hands back a SKU this request did not send.
      'inventory_items.insert': {
        data: [
          { id: 'itm-a', sku: 'SKU-A' },
          { id: 'itm-x', sku: 'SKU-UNKNOWN' },
        ],
        error: null,
      },
    });
    const svc = new InventoryService(makeServiceContext(stub.client));

    const err = (await svc
      .bulkCreate({ warehouseId: 'wh-1', items: ITEMS.slice(0, 2) })
      .catch((e: unknown) => e)) as { code: string; message: string; details: { itemIds: string[] } };
    expect(openedLines(stub)).toEqual([{ itemId: 'itm-a', quantity: 10 }]);
    expect(err).toMatchObject({
      code: 'conflict',
      message: expect.stringMatching(/^These items were saved, but 1 of 2 have zero on hand/),
    });
    expect(err.details.itemIds).toEqual(['itm-x']);
  });

  it('an insert that hands back fewer rows than were sent opens nothing and says the quantities could not be confirmed', async () => {
    const stub = openingStub({
      'inventory_items.select': { data: [], error: null, count: 0 },
      'inventory_items.insert': { data: [{ id: 'itm-a', sku: 'SKU-A' }], error: null },
    });
    const svc = new InventoryService(makeServiceContext(stub.client));

    const err = (await svc
      .bulkCreate({ warehouseId: 'wh-1', items: ITEMS.slice(0, 2) })
      .catch((e: unknown) => e)) as { code: string; message: string; details: { itemIds: string[]; outcome: string } };
    expect(stub.rpcCalls.filter((c) => c.name === 'open_item_stock')).toEqual([]);
    expect(err.code).toBe('conflict');
    expect(err.message).toBe(
      'These items were saved, but their opening quantities could not be confirmed. Open each one and check its quantity on hand before receiving, picking or counting against it.',
    );
    expect(err.details.itemIds).toEqual(['itm-a']);
    expect(err.details.outcome).toBe('unchecked');
  });

  it('a stocked SKU missing from the rows, with no row left to account for it, says could not be confirmed', async () => {
    const stub = openingStub({
      'inventory_items.select': { data: [], error: null, count: 0 },
      // Two rows for two sent, but both under SKU-A: SKU-B (asked for 5) is unaccounted for.
      'inventory_items.insert': {
        data: [
          { id: 'itm-a', sku: 'SKU-A' },
          { id: 'itm-a2', sku: 'SKU-A' },
        ],
        error: null,
      },
    });
    const svc = new InventoryService(makeServiceContext(stub.client));

    const err = (await svc
      .bulkCreate({ warehouseId: 'wh-1', items: ITEMS.slice(0, 2) })
      .catch((e: unknown) => e)) as { message: string; details: { itemIds: string[] } };
    expect(stub.rpcCalls.filter((c) => c.name === 'open_item_stock')).toEqual([]);
    expect(err.message).toMatch(/^These items were saved, but their opening quantities could not be confirmed\./);
    expect(err.details.itemIds).toEqual(['itm-a', 'itm-a2']);
  });

  it('a batch with no stocked rows opens nothing', async () => {
    const stub = openingStub({
      'inventory_items.select': { data: [], error: null, count: 0 },
      'inventory_items.insert': { data: [{ id: 'itm-c', sku: 'SKU-C' }], error: null },
    });
    const svc = new InventoryService(makeServiceContext(stub.client));

    const res = await svc.bulkCreate({ warehouseId: 'wh-1', items: [ITEMS[2]!] });
    expect(res.created).toBe(1);
    expect(stub.rpcCalls.filter((c) => c.name === 'open_item_stock')).toEqual([]);
  });

  it('a negative quantity is refused before anything is read or written', async () => {
    const stub = openingStub();
    const svc = new InventoryService(makeServiceContext(stub.client));

    await expect(
      svc.bulkCreate({ warehouseId: 'wh-1', items: [{ ...ITEMS[0]!, quantityOnHand: -1 }] }),
    ).rejects.toMatchObject({ code: 'validation_error', message: 'Enter 0 or more.' });
    expect(stub.chains.has('inventory_items.insert')).toBe(false);
  });
});
