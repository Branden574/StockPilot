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

/**
 * The supabase mock RECORDS every query-builder method call (and its args)
 * against the holdings query, but its canned `data` is returned regardless
 * of what filters were actually chained — it does not simulate PostgREST
 * filtering. So a test asserting only on the OUTCOME (which holdings moved)
 * cannot tell "the code fetched broadly and classified in JS" apart from
 * "the code still filters `.in('locations.kind', […])` at the DB level" —
 * both produce the same canned rows in this mock. This inspects the
 * RECORDED chain directly: true if any call against
 * `item_stock_levels.select` filtered on a `locations.kind` argument (the
 * exact shape that silently drops NULL/site rows — see the method's doc in
 * inventory.ts). Used to prove the DB-side filter is actually gone, not
 * just that today's canned fixtures happen to still pass.
 */
function holdingsQueryFiltersOnLocationsKind(
  stub: ReturnType<typeof makeSupabaseStub>,
): boolean {
  const args = stub.chainArgs.get('item_stock_levels.select') ?? [];
  return args.some(
    (callArgs) => typeof callArgs[0] === 'string' && callArgs[0].startsWith('locations.kind'),
  );
}

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

// Owner report 2026-08-03: three DC4 items with 2/2/3 units unplaced stayed
// "Unplaced/awaiting put-away" after running Set rack '28-A'. Root cause:
// the holdings query used to filter `.in('locations.kind', ['staging',
// 'unplaced', 'rack', 'crate'])` — `kind IN (...)` is never true for a NULL
// column, so stock sitting directly on a SITE (locations.kind IS NULL, per
// `reference_locations_kind_null_is_a_site`) was silently excluded from
// BOTH buckets and the function no-opped for those items. Fixed by dropping
// the DB-side kind filter and classifying in JS with `isRackShelfLocation`
// (groups.ts) instead, so a NULL-kind row is never silently dropped again.
describe('bulkUpdate set_rack — NULL-kind (site) holdings are "not yet placed" too', () => {
  it('a holding at a NULL-kind SITE location is treated as unplaced and moved to the rack, with a movement recorded', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: [{ id: 'item-1', warehouse_id: 'wh-1' }], error: null },
      'rpc:inventory_set_rack': { data: 1, error: null },
      // item-1's stock sits directly on the DC4 SITE — kind NULL, not the
      // dedicated 'unplaced' bucket. This is the exact shape that no-opped.
      'item_stock_levels.select': {
        data: [
          {
            item_id: 'item-1',
            location_id: 'dc4-site',
            quantity: 2,
            locations: { kind: null, type: null, warehouse_id: 'wh-1' },
          },
        ],
        error: null,
      },
      'locations.select': { data: [{ id: 'rack-28a', name: '28-A' }], error: null },
      'rpc:transfer_stock': { data: null, error: null },
    });
    const svc = new InventoryService(makeServiceContext(stub.client));

    const res = await svc.bulkUpdate({
      ids: ['item-1'],
      op: { kind: 'set_rack', rackNumber: '28', rackRow: 'A' },
    });

    expect(res.ok).toBe(1);
    // `placed` reports the physical move happened, not just the label.
    expect(res.placed).toBe(1);
    const transfer = stub.rpcCalls.find((c) => c.name === 'transfer_stock');
    expect(transfer).toBeDefined();
    expect(transfer!.args).toMatchObject({
      p_item_id: 'item-1',
      p_from_location_id: 'dc4-site',
      p_to_location_id: 'rack-28a',
      p_quantity: 2,
    });
    // Proves the fix is real, not just that this fixture's canned rows
    // happen to pass — the mock replays `data` regardless of chained
    // filters, so an outcome-only assertion can't tell "fetched broadly,
    // classified in JS" apart from "still filters .in('locations.kind',
    // […])" (which would ALSO return this canned NULL-kind row here).
    expect(holdingsQueryFiltersOnLocationsKind(stub)).toBe(false);
  });

  it('a NULL-kind holding moves, but a split pair of existing rack/crate holdings for a DIFFERENT item stays untouched', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': {
        data: [
          { id: 'item-unplaced', warehouse_id: 'wh-1' },
          { id: 'item-split', warehouse_id: 'wh-1' },
        ],
        error: null,
      },
      'rpc:inventory_set_rack': { data: 2, error: null },
      'item_stock_levels.select': {
        data: [
          {
            item_id: 'item-unplaced',
            location_id: 'dc4-site',
            quantity: 3,
            locations: { kind: null, type: null, warehouse_id: 'wh-1' },
          },
          {
            item_id: 'item-split',
            location_id: 'rack-a',
            quantity: 2,
            locations: { kind: 'rack', type: 'shelf', warehouse_id: 'wh-1' },
          },
          {
            item_id: 'item-split',
            location_id: 'crate-b',
            quantity: 4,
            locations: { kind: 'crate', type: null, warehouse_id: 'wh-1' },
          },
        ],
        error: null,
      },
      'locations.select': { data: [{ id: 'rack-28a', name: '28-A' }], error: null },
      'rpc:transfer_stock': { data: null, error: null },
    });
    const svc = new InventoryService(makeServiceContext(stub.client));

    const res = await svc.bulkUpdate({
      ids: ['item-unplaced', 'item-split'],
      op: { kind: 'set_rack', rackNumber: '28', rackRow: 'A' },
    });

    expect(res.placed).toBe(1);
    const transfers = stub.rpcCalls.filter((c) => c.name === 'transfer_stock');
    expect(transfers).toHaveLength(1);
    expect(transfers[0]!.args).toMatchObject({
      p_item_id: 'item-unplaced',
      p_from_location_id: 'dc4-site',
      p_to_location_id: 'rack-28a',
    });
    // item-split's two holdings are a split placement — neither moves.
    expect(
      transfers.some((c) => (c.args as Record<string, unknown>).p_item_id === 'item-split'),
    ).toBe(false);
    expect(holdingsQueryFiltersOnLocationsKind(stub)).toBe(false);
  });

  it('placement failure (rack cannot be resolved/created) still leaves the label written', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: [{ id: 'item-1', warehouse_id: 'wh-1' }], error: null },
      'rpc:inventory_set_rack': { data: 1, error: null },
      'item_stock_levels.select': {
        data: [
          {
            item_id: 'item-1',
            location_id: 'dc4-site',
            quantity: 2,
            locations: { kind: null, type: null, warehouse_id: 'wh-1' },
          },
        ],
        error: null,
      },
      // Resolve finds nothing AND the create fails outright (not a 23505
      // race) — placement degrades to a no-op.
      'locations.select': { data: [], error: null },
      'locations.insert': { data: null, error: { message: 'boom' } },
    });
    const svc = new InventoryService(makeServiceContext(stub.client));

    const res = await svc.bulkUpdate({
      ids: ['item-1'],
      op: { kind: 'set_rack', rackNumber: '28', rackRow: 'A' },
    });

    expect(res.ok).toBe(1);
    expect(res.placed).toBe(0);
    // The label RPC still ran and succeeded.
    expect(stub.rpcCalls.some((c) => c.name === 'inventory_set_rack')).toBe(true);
    expect(stub.rpcCalls.some((c) => c.name === 'transfer_stock')).toBe(false);
    // AND THE OPERATOR IS TOLD. `placed: 0` alone reads identically to "there
    // was nothing to place", which is the benign case. The item now carries a
    // label naming a rack that does not exist, with its stock still at the
    // site — the count is what separates those two.
    expect(res.placeFailed).toBe(1);
  });

  // ═══ THE `!toLoc` SPLIT: UNRESOLVABLE IS NOT THE SAME AS ALREADY-THERE ═══
  //
  // Both branches of the placement loops start `if (!toLoc)`, and the line
  // right after is `if (toLoc === <current>) return`. Those two look adjacent
  // and mean opposite things: the first is a failure the operator must hear
  // about, the second is a success with no work to do. Collapsing them in
  // either direction is silent and plausible — blame every idempotent item, or
  // stay quiet about every unresolvable one.
  //
  // The resolution is keyed PER WAREHOUSE (`rackByWh.get(warehouseId)`), so a
  // mixed batch is where the distinction is load-bearing: one item's warehouse
  // can resolve while another's does not, in the same operation.

  it('a mixed batch splits per item: one warehouse resolves and places, the other is reported', async () => {
    let selects = 0;
    const stub = makeSupabaseStub({
      'inventory_items.select': {
        data: [
          { id: 'item-1', warehouse_id: 'wh-1' },
          { id: 'item-2', warehouse_id: 'wh-2' },
        ],
        error: null,
      },
      'rpc:inventory_set_rack': { data: 2, error: null },
      'item_stock_levels.select': {
        data: [
          {
            item_id: 'item-1',
            location_id: 'site-1',
            quantity: 4,
            locations: { kind: null, type: null, warehouse_id: 'wh-1' },
          },
          {
            item_id: 'item-2',
            location_id: 'site-2',
            quantity: 7,
            locations: { kind: null, type: null, warehouse_id: 'wh-2' },
          },
        ],
        error: null,
      },
      // One warehouse's rack resolves; the other's does not and cannot be
      // created. Which warehouse wins is not asserted below — only that the
      // batch SPLIT rather than going all-or-nothing.
      'locations.select': () => {
        selects += 1;
        return selects === 1
          ? { data: [{ id: 'rack-28a', name: '28-A' }], error: null }
          : { data: [], error: null };
      },
      'locations.insert': { data: null, error: { message: 'plan limit exceeded' } },
    });
    const svc = new InventoryService(makeServiceContext(stub.client));

    const res = await svc.bulkUpdate({
      ids: ['item-1', 'item-2'],
      op: { kind: 'set_rack', rackNumber: '28', rackRow: 'A' },
    });

    // Both labels were written; the placements diverged.
    expect(res.ok).toBe(2);
    expect(res.placed).toBe(1);
    expect(res.placeFailed).toBe(1);
    // Exactly ONE physical move — the resolvable warehouse's. A batch that
    // gave up entirely on the first unresolvable item would show 0 here, and
    // one that ignored the failure would show 2.
    expect(stub.rpcCalls.filter((c) => c.name === 'transfer_stock')).toHaveLength(1);
  });

  it('already on the target rack is NOT reported as a failure — no move needed is not a miss', async () => {
    // The other side of the split. An operator who re-runs "Set rack 28-A" on
    // items already on 28-A must see a clean result; warning here would train
    // them to dismiss the warning that matters.
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: [{ id: 'item-1', warehouse_id: 'wh-1' }], error: null },
      'rpc:inventory_set_rack': { data: 1, error: null },
      'item_stock_levels.select': {
        data: [
          {
            item_id: 'item-1',
            location_id: 'rack-28a',
            quantity: 5,
            locations: { kind: 'rack', type: 'shelf', warehouse_id: 'wh-1' },
          },
        ],
        error: null,
      },
      'locations.select': { data: [{ id: 'rack-28a', name: '28-A' }], error: null },
    });
    const svc = new InventoryService(makeServiceContext(stub.client));

    const res = await svc.bulkUpdate({
      ids: ['item-1'],
      op: { kind: 'set_rack', rackNumber: '28', rackRow: 'A' },
    });

    expect(res.ok).toBe(1);
    expect(res.placed).toBe(0);
    // The distinction the whole split exists for: 0 placed, 0 FAILED.
    expect(res.placeFailed ?? 0).toBe(0);
    expect(stub.rpcCalls.some((c) => c.name === 'transfer_stock')).toBe(false);
  });
});
