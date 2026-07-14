import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

// Bulk "Set rack" must not only write the rack LABEL — it must PLACE each
// selected item's staging/unplaced stock onto that rack (transfer_stock),
// so stock actually moves out of staging in one action.
vi.mock('./context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./context')>();
  return { ...actual, assertPermission: vi.fn(), assertPlanLimit: vi.fn() };
});
vi.mock('@/lib/auth/warehouse', () => ({
  getWarehouseAccess: vi.fn(async () => ({ hasAllAccess: true, writableIds: [], readableIds: [] })),
  forcedWarehouseId: vi.fn(async () => null),
  assertWarehouseAccess: vi.fn(async () => undefined),
  ForbiddenError: class extends Error {},
}));

import { InventoryService } from './inventory';

beforeEach(() => vi.clearAllMocks());

describe('bulkUpdate set_rack — places stock, not just a label', () => {
  it('transfers each item\'s staging holding onto the named rack', async () => {
    const stub = makeSupabaseStub({
      // allowedIds load AND the placement\'s items load both hit this:
      'inventory_items.select': { data: [{ id: 'item-1', warehouse_id: 'wh-1' }], error: null },
      // the label RPC returns the updated row count:
      'rpc:inventory_set_rack': { data: 1, error: null },
      // the item\'s not-yet-placed (staging) holding:
      'item_stock_levels.select': {
        data: [
          {
            item_id: 'item-1',
            location_id: 'stg-1',
            quantity: 8,
            locations: { kind: 'staging', warehouse_id: 'wh-1' },
          },
        ],
        error: null,
      },
      // an existing rack named "1-A" in wh-1 (so no create needed).
      // findOrCreateRackOrCrate matches on candidates.find(...), so this
      // MUST be array-shaped (not a bare object) with a `name` that matches
      // the composed "1-A" label case-insensitively.
      'locations.select': { data: [{ id: 'rack-1', name: '1-A' }], error: null },
      // the placement transfer:
      'rpc:transfer_stock': { data: null, error: null },
    });
    const svc = new InventoryService(makeServiceContext(stub.client));

    const res = await svc.bulkUpdate({
      ids: ['item-1'],
      op: { kind: 'set_rack', rackNumber: '1', rackRow: 'A' },
    });

    expect(res.ok).toBe(1);
    // The LABEL was still written.
    expect(stub.rpcCalls.some((c) => c.name === 'inventory_set_rack')).toBe(true);
    // AND the staging stock was PLACED onto the rack (the actual fix).
    const transfer = stub.rpcCalls.find((c) => c.name === 'transfer_stock');
    expect(transfer).toBeDefined();
    expect(transfer!.args).toMatchObject({
      p_item_id: 'item-1',
      p_from_location_id: 'stg-1',
      p_to_location_id: 'rack-1',
      p_quantity: 8,
    });
  });

  it('clearing the rack (null) writes the label but moves no stock', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: [{ id: 'item-1', warehouse_id: 'wh-1' }], error: null },
      'rpc:inventory_set_rack': { data: 1, error: null },
      'item_stock_levels.select': {
        data: [
          {
            item_id: 'item-1',
            location_id: 'stg-1',
            quantity: 8,
            locations: { kind: 'staging', warehouse_id: 'wh-1' },
          },
        ],
        error: null,
      },
      'rpc:transfer_stock': { data: null, error: null },
    });
    const svc = new InventoryService(makeServiceContext(stub.client));

    await svc.bulkUpdate({
      ids: ['item-1'],
      op: { kind: 'set_rack', rackNumber: null, rackRow: null },
    });

    expect(stub.rpcCalls.some((c) => c.name === 'transfer_stock')).toBe(false);
  });
});

// Unit B: Set-rack also physically moves stock ALREADY on a rack/crate,
// but ONLY when the item's stock sits on exactly one such holding. A split
// placement (>1 distinct rack/crate holding with qty>0) must never be
// moved — the bulk op carries no fromLocationId, so guessing which
// placement (or how much) to relocate would be wrong. Those items keep
// today's label-only behavior; the client warns the user to use Transfer.
describe('bulkUpdate set_rack — Unit B: moves a single existing rack/crate holding', () => {
  it('single rack holding, different from the target: physically moves it via transfer_stock', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: [{ id: 'item-1', warehouse_id: 'wh-1' }], error: null },
      'rpc:inventory_set_rack': { data: 1, error: null },
      // item-1's WHOLE quantity sits on exactly one rack ("old rack"):
      'item_stock_levels.select': {
        data: [
          {
            item_id: 'item-1',
            location_id: 'rack-old',
            quantity: 5,
            locations: { kind: 'rack', warehouse_id: 'wh-1' },
          },
        ],
        error: null,
      },
      // the NEW target rack "2-B" already exists in wh-1:
      'locations.select': { data: [{ id: 'rack-new', name: '2-B' }], error: null },
      'rpc:transfer_stock': { data: null, error: null },
    });
    const svc = new InventoryService(makeServiceContext(stub.client));

    const res = await svc.bulkUpdate({
      ids: ['item-1'],
      op: { kind: 'set_rack', rackNumber: '2', rackRow: 'B' },
    });

    expect(res.ok).toBe(1);
    expect(stub.rpcCalls.some((c) => c.name === 'inventory_set_rack')).toBe(true);
    const transfer = stub.rpcCalls.find((c) => c.name === 'transfer_stock');
    expect(transfer).toBeDefined();
    expect(transfer!.args).toMatchObject({
      p_item_id: 'item-1',
      p_from_location_id: 'rack-old',
      p_to_location_id: 'rack-new',
      p_quantity: 5,
    });
  });

  it('split across >1 rack/crate holding: NEVER moves stock — label-only', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: [{ id: 'item-1', warehouse_id: 'wh-1' }], error: null },
      'rpc:inventory_set_rack': { data: 1, error: null },
      // item-1's stock is split across TWO holdings — a rack and a crate:
      'item_stock_levels.select': {
        data: [
          {
            item_id: 'item-1',
            location_id: 'rack-a',
            quantity: 3,
            locations: { kind: 'rack', warehouse_id: 'wh-1' },
          },
          {
            item_id: 'item-1',
            location_id: 'crate-b',
            quantity: 2,
            locations: { kind: 'crate', warehouse_id: 'wh-1' },
          },
        ],
        error: null,
      },
      // The target rack CAN resolve (so a would-be move isn't merely
      // blocked by a missing destination) — the assertion below must hold
      // because of the split-detection, not because there's nowhere to go.
      'locations.select': { data: [{ id: 'rack-new', name: '2-B' }], error: null },
      'rpc:transfer_stock': { data: null, error: null },
    });
    const svc = new InventoryService(makeServiceContext(stub.client));

    const res = await svc.bulkUpdate({
      ids: ['item-1'],
      op: { kind: 'set_rack', rackNumber: '2', rackRow: 'B' },
    });

    expect(res.ok).toBe(1);
    // The LABEL is still written...
    expect(stub.rpcCalls.some((c) => c.name === 'inventory_set_rack')).toBe(true);
    // ...but NOTHING is physically moved for the split item.
    expect(stub.rpcCalls.some((c) => c.name === 'transfer_stock')).toBe(false);
  });

  it('single rack holding already on the target: idempotent no-op', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: [{ id: 'item-1', warehouse_id: 'wh-1' }], error: null },
      'rpc:inventory_set_rack': { data: 1, error: null },
      // item-1's single holding is ALREADY on the rack being (re)applied:
      'item_stock_levels.select': {
        data: [
          {
            item_id: 'item-1',
            location_id: 'rack-1',
            quantity: 5,
            locations: { kind: 'rack', warehouse_id: 'wh-1' },
          },
        ],
        error: null,
      },
      // findOrCreateRackOrCrate resolves the SAME location the item is
      // already on:
      'locations.select': { data: [{ id: 'rack-1', name: '1-A' }], error: null },
      'rpc:transfer_stock': { data: null, error: null },
    });
    const svc = new InventoryService(makeServiceContext(stub.client));

    await svc.bulkUpdate({
      ids: ['item-1'],
      op: { kind: 'set_rack', rackNumber: '1', rackRow: 'A' },
    });

    expect(stub.rpcCalls.some((c) => c.name === 'transfer_stock')).toBe(false);
  });

  it('staging/unplaced stock is still auto-placed alongside an unrelated single-rack item', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': {
        data: [
          { id: 'item-staged', warehouse_id: 'wh-1' },
          { id: 'item-racked', warehouse_id: 'wh-1' },
        ],
        error: null,
      },
      'rpc:inventory_set_rack': { data: 2, error: null },
      'item_stock_levels.select': {
        data: [
          {
            item_id: 'item-staged',
            location_id: 'stg-1',
            quantity: 4,
            locations: { kind: 'staging', warehouse_id: 'wh-1' },
          },
          {
            item_id: 'item-racked',
            location_id: 'rack-old',
            quantity: 5,
            locations: { kind: 'rack', warehouse_id: 'wh-1' },
          },
        ],
        error: null,
      },
      'locations.select': { data: [{ id: 'rack-new', name: '2-B' }], error: null },
      'rpc:transfer_stock': { data: null, error: null },
    });
    const svc = new InventoryService(makeServiceContext(stub.client));

    await svc.bulkUpdate({
      ids: ['item-staged', 'item-racked'],
      op: { kind: 'set_rack', rackNumber: '2', rackRow: 'B' },
    });

    const transfers = stub.rpcCalls.filter((c) => c.name === 'transfer_stock');
    expect(transfers).toHaveLength(2);
    expect(transfers).toContainEqual(
      expect.objectContaining({
        args: expect.objectContaining({
          p_item_id: 'item-staged',
          p_from_location_id: 'stg-1',
          p_to_location_id: 'rack-new',
          p_quantity: 4,
        }),
      }),
    );
    expect(transfers).toContainEqual(
      expect.objectContaining({
        args: expect.objectContaining({
          p_item_id: 'item-racked',
          p_from_location_id: 'rack-old',
          p_to_location_id: 'rack-new',
          p_quantity: 5,
        }),
      }),
    );
  });

  // Unit B review, Minor 2: the two loops above (staging/unplaced levels,
  // then singleRackMoves) run over the SAME holdings query and are keyed
  // by item_id independently — a single item can appear in BOTH. Prove
  // that produces exactly two converging transfers (one per holding) for
  // that one item, not a double-move of either holding and not an error.
  it('one item with BOTH a staging holding and a single rack holding: both converge onto the target rack (no double-move, no error)', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: [{ id: 'item-1', warehouse_id: 'wh-1' }], error: null },
      'rpc:inventory_set_rack': { data: 1, error: null },
      // item-1 has a staging holding AND a single rack holding at once:
      'item_stock_levels.select': {
        data: [
          {
            item_id: 'item-1',
            location_id: 'stg-1',
            quantity: 4,
            locations: { kind: 'staging', warehouse_id: 'wh-1' },
          },
          {
            item_id: 'item-1',
            location_id: 'rack-old',
            quantity: 5,
            locations: { kind: 'rack', warehouse_id: 'wh-1' },
          },
        ],
        error: null,
      },
      'locations.select': { data: [{ id: 'rack-new', name: '2-B' }], error: null },
      'rpc:transfer_stock': { data: null, error: null },
    });
    const svc = new InventoryService(makeServiceContext(stub.client));

    const res = await svc.bulkUpdate({
      ids: ['item-1'],
      op: { kind: 'set_rack', rackNumber: '2', rackRow: 'B' },
    });

    expect(res.ok).toBe(1);
    const transfers = stub.rpcCalls.filter((c) => c.name === 'transfer_stock');
    // Exactly one transfer per holding — never a double-move of either.
    expect(transfers).toHaveLength(2);
    expect(transfers).toContainEqual(
      expect.objectContaining({
        args: expect.objectContaining({
          p_item_id: 'item-1',
          p_from_location_id: 'stg-1',
          p_to_location_id: 'rack-new',
          p_quantity: 4,
        }),
      }),
    );
    expect(transfers).toContainEqual(
      expect.objectContaining({
        args: expect.objectContaining({
          p_item_id: 'item-1',
          p_from_location_id: 'rack-old',
          p_to_location_id: 'rack-new',
          p_quantity: 5,
        }),
      }),
    );
  });
});
