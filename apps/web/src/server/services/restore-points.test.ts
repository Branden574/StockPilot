// Restore points and Ungroup (orchestrator decision D1, Ungroup test stage).
//
// A restore point used to remember each record only by its SKU and rack
// (version 1). After an Ungroup gave a record a new SKU, restoring an older
// point found no record with the old SKU at that rack, re-created one with the
// stock it had then, and left the split record (new SKU, same stock) as an
// extra: the stock was counted twice. Version 2 points carry each record's id,
// and the restore matches by id first; the SKU and rack are used only to find
// or re-create a record whose id no longer exists. A version 1 point still
// restores exactly as before, and the restore screen warns first when a SKU
// changed after it was taken (restorePointSkuChanges).
//
// PR stage, data review DATA-1: a version 1 point restored after an Ungroup
// finds the split record through the split's own audit row (read with the
// service role, scoped to the organization) and reconciles it by id, so it
// re-creates nothing; the warning names only SKU edits that are not splits;
// and an admin who cannot view the audit log is told the check could not run,
// never shown an empty list as an all-clear.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ROLE_PERMISSIONS, type Permission } from '@stockpilot/core';

const h = vi.hoisted(() => ({
  update: vi.fn(async (..._a: unknown[]) => ({})),
  create: vi.fn(async (..._a: unknown[]) => ({})),
  adjustStock: vi.fn(async (..._a: unknown[]) => ({})),
  audit: vi.fn(),
  assertPermission: vi.fn(),
  assertCurrentAal2: vi.fn(async () => undefined),
  inserted: [] as Array<Record<string, unknown>>,
  /** Every read the service-role client was asked for. */
  adminReads: [] as Array<{
    table: string;
    select: string;
    filters: unknown[][];
    order: unknown[][];
  }>,
  /** inventory.item.ungrouped rows as the service-role read returns them. */
  splits: [] as Array<{ id: string; item_id: string | null; left_sku: string | null }>,
  splitsError: null as { message: string } | null,
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn() }));
vi.mock('@/lib/auth/warehouse', () => ({
  getWarehouseAccess: async () => ({ primaryWarehouseId: 'wh-fallback' }),
}));
vi.mock('./audit', () => ({ audit: h.audit }));
vi.mock('./context', () => ({
  assertPermission: h.assertPermission,
  assertCurrentAal2: h.assertCurrentAal2,
  ServiceError: class ServiceError extends Error {
    constructor(
      public code: string,
      message: string,
      public details?: Record<string, unknown>,
    ) {
      super(message);
    }
  },
}));
vi.mock('./inventory', () => ({
  InventoryService: class {
    update = h.update;
    create = h.create;
    adjustStock = h.adjustStock;
  },
}));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const r = { table, select: '', filters: [] as unknown[][], order: [] as unknown[][] };
      h.adminReads.push(r);
      const q: Record<string, unknown> = {};
      q.insert = (v: Record<string, unknown>) => (h.inserted.push(v), q);
      q.select = (cols: string) => ((r.select = cols), q);
      for (const op of ['eq', 'gt', 'in', 'is']) {
        q[op] = (...args: unknown[]) => (r.filters.push([op, ...args]), q);
      }
      q.order = (...args: unknown[]) => (r.order.push(args), q);
      q.range = async () =>
        table === 'audit_logs'
          ? { data: h.splitsError ? null : h.splits, error: h.splitsError }
          : { data: [], error: null };
      q.single = async () => ({ data: { id: 'pre-restore-id' }, error: null });
      return q;
    },
  }),
}));

import {
  createSnapshot,
  restorePointSkuChanges,
  restoreSnapshot,
  SKU_CHANGES_SCAN,
  type RestoreSnapshot,
  type SnapshotItem,
} from './restore-points';

const ORG = '11111111-1111-4111-8111-111111111111';
const ME = '22222222-2222-4222-8222-222222222222';
const POINT = '33333333-3333-4333-8333-333333333333';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const D = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

type Read = {
  table: string;
  select: string;
  filters: unknown[][];
  order: unknown[][];
  limit: number | null;
};

interface World {
  /** inventory_items rows as the capture select returns them */
  capture?: Array<Record<string, unknown>>;
  /** inventory_items rows as the restore's active-row read returns them */
  active?: Array<{
    id: string;
    sku: string;
    bin_location: string | null;
    quantity_on_hand: number;
    status: string;
  }>;
  snapshot?: RestoreSnapshot;
  /** the restore point's metadata read (restorePointSkuChanges) */
  point?: { version: unknown; captured_at: string | null; created_at: string } | null;
  audit?: Array<Record<string, unknown>>;
  names?: Array<{ id: string; name: string; sku: string }>;
  /** live records holding the named records' new SKUs (the shared check) */
  holders?: Array<{ id?: string; sku: string }>;
  auditError?: { message: string } | null;
  /** split records' racks now (final round, review DR2-1) */
  splitRacks?: Array<{ id: string; bin_location: string | null }>;
  splitRacksError?: { message: string } | null;
  /** live records holding the SKUs split records left (final round, DR2-1) */
  oldSkuHolders?: Array<{ id: string; sku: string; bin_location: string | null }>;
  oldSkuHoldersError?: { message: string } | null;
}

function harness(world: World, who: { role?: string; permissions?: Set<Permission> } = {}) {
  const reads: Read[] = [];
  const answer = (r: Read): { data: unknown; error: unknown } => {
    if (r.table === 'organizations') return { data: { plan: 'business' }, error: null };
    if (r.table === 'restore_points') {
      if (r.select === 'snapshot') return { data: { snapshot: world.snapshot }, error: null };
      return { data: world.point ?? null, error: null };
    }
    if (r.table === 'audit_logs')
      return { data: world.audit ?? [], error: world.auditError ?? null };
    if (r.table === 'inventory_items') {
      if (r.select === 'id, sku, bin_location, quantity_on_hand, status')
        return { data: world.active ?? [], error: null };
      if (r.select === 'id, bin_location')
        return { data: world.splitRacks ?? [], error: world.splitRacksError ?? null };
      if (r.select === 'id, sku, bin_location')
        return { data: world.oldSkuHolders ?? [], error: world.oldSkuHoldersError ?? null };
      if (r.select === 'id, name, sku') return { data: world.names ?? [], error: null };
      if (r.select === 'sku' || r.select === 'id, sku')
        return { data: world.holders ?? [], error: null };
      return { data: world.capture ?? [], error: null };
    }
    return { data: [], error: null };
  };
  const supabase = {
    from: (table: string) => {
      const r: Read = { table, select: '', filters: [], order: [], limit: null };
      reads.push(r);
      const q: Record<string, unknown> = {};
      q.select = (cols: string) => ((r.select = cols), q);
      for (const op of ['eq', 'in', 'is', 'gt', 'filter']) {
        q[op] = (...args: unknown[]) => (r.filters.push([op, ...args]), q);
      }
      q.order = (...args: unknown[]) => (r.order.push(args), q);
      q.limit = (n: number) => ((r.limit = n), q);
      q.range = () => q;
      q.single = async () => answer(r);
      q.maybeSingle = async () => answer(r);
      (q as { then: unknown }).then = (
        res: (v: unknown) => unknown,
        rej: (e: unknown) => unknown,
      ) => Promise.resolve(answer(r)).then(res, rej);
      return q;
    },
  };
  const ctx = {
    organizationId: ORG,
    userId: ME,
    role: who.role ?? 'owner',
    ...(who.permissions ? { permissions: who.permissions } : {}),
    supabase,
    enabledModules: new Set<string>(),
    mfaRequired: false,
    mfaSatisfied: true,
  } as never;
  return { ctx, reads };
}

function item(over: Partial<SnapshotItem> & { sku: string }): SnapshotItem {
  return {
    name: 'Black Mouse Pad',
    barcode: null,
    description: null,
    unitCost: 0,
    retailPrice: 0,
    quantityOnHand: 0,
    reorderPoint: 0,
    reorderQuantity: 0,
    unitOfMeasure: 'unit',
    status: 'active',
    itemType: 'product',
    warehouseId: 'wh-1',
    binLocation: null,
    categoryName: null,
    supplierName: null,
    locationName: null,
    ...over,
  };
}

const row = (id: string, sku: string, bin: string | null, qty: number) => ({
  id,
  sku,
  bin_location: bin,
  quantity_on_hand: qty,
  status: 'active',
});

/** The first patch the restore sent InventoryService.update for a record. */
const patchFor = (id: string) =>
  h.update.mock.calls.find((c) => c[0] === id)?.[1] as Record<string, unknown>;
/**
 * PR stage fix round 1 (review F3-restore-fanout): all a record whose SKU now
 * belongs to another product gets back besides its stock. None of them is in
 * InventoryService's SHARED_ITEM_FIELDS (pinned below), so update() copies
 * nothing to the other records.
 */
const PLACEMENT_PATCH_KEYS = ['primaryLocationId', 'status', 'supplierId', 'unitOfMeasure'];

beforeEach(() => {
  vi.clearAllMocks();
  h.inserted.length = 0;
  h.adminReads.length = 0;
  h.splits = [];
  h.splitsError = null;
});

/** An admin's permissions with the audit-log view revoked (an override). */
const adminWithout = (p: Permission): Set<Permission> =>
  new Set(ROLE_PERMISSIONS.admin.filter((x) => x !== p));
/** An inventory.item.ungrouped row as the restore's service-role read returns it. */
const splitRow = (itemId: string, leftSku: string) => ({
  id: `audit-${itemId}`,
  item_id: itemId,
  left_sku: leftSku,
});

describe('createSnapshot (version 2 carries each record id)', () => {
  it('writes version 2 and keeps each record id next to its SKU and rack', async () => {
    const { ctx } = harness({
      capture: [
        {
          id: A,
          sku: 'SP-PAIR',
          name: 'Black Mouse Pad',
          quantity_on_hand: 9,
          bin_location: '22-A',
          status: 'active',
          item_type: 'product',
          warehouse_id: 'wh-1',
        },
        {
          id: B,
          sku: 'SP-PAIR',
          name: 'Black Mouse Pad',
          quantity_on_hand: 4,
          bin_location: '22-C',
          status: 'active',
          item_type: 'product',
          warehouse_id: 'wh-1',
        },
      ],
    });
    await createSnapshot(ctx, { kind: 'manual', label: 'before split' });
    const snap = h.inserted[0]?.snapshot as RestoreSnapshot;
    expect(snap.version).toBe(2);
    expect(snap.items.map((i) => [i.id, i.sku, i.binLocation, i.quantityOnHand])).toEqual([
      [A, 'SP-PAIR', '22-A', 9],
      [B, 'SP-PAIR', '22-C', 4],
    ]);
  });

  it('reads the record id in the capture select', async () => {
    const { ctx, reads } = harness({ capture: [] });
    await createSnapshot(ctx, { kind: 'auto', label: null });
    const capture = reads.find((r) => r.table === 'inventory_items');
    expect(capture?.select.split(',').map((s) => s.trim())).toContain('id');
  });
});

describe('restoreSnapshot after an Ungroup', () => {
  // Before the split: A on 22-A (9) and B on 22-C (4) share SP-PAIR. After it,
  // B has SP-NEW1 and the same 4 on 22-C.
  const AFTER_SPLIT = [row(A, 'SP-PAIR', '22-A', 9), row(B, 'SP-NEW1', '22-C', 4)];

  it('version 2: matches each record by id, so the split record keeps its stock once and nothing is re-created', async () => {
    const { ctx } = harness({
      snapshot: {
        version: 2,
        capturedAt: '2026-10-12T00:00:00.000Z',
        items: [
          item({ id: A, sku: 'SP-PAIR', binLocation: '22-A', quantityOnHand: 9 }),
          item({ id: B, sku: 'SP-PAIR', binLocation: '22-C', quantityOnHand: 4 }),
        ],
      },
      active: AFTER_SPLIT,
    });
    const res = await restoreSnapshot(ctx, { id: POINT, confirm: 'RESTORE' });
    expect(h.create).not.toHaveBeenCalled();
    expect(h.adjustStock).not.toHaveBeenCalled();
    expect(h.update.mock.calls.map((c) => c[0])).toEqual([A, B]);
    // The restore never writes a SKU: the split record keeps its own.
    for (const c of h.update.mock.calls) expect(c[1]).not.toHaveProperty('sku');
    expect(res).toMatchObject({
      updated: 2,
      recreated: 0,
      quantityAdjusted: 0,
      failures: 0,
      extrasFlagged: 0,
    });
  });

  it("version 2: puts a record's stock back on that record by id, whatever its SKU is now", async () => {
    const { ctx } = harness({
      snapshot: {
        version: 2,
        capturedAt: '2026-10-12T00:00:00.000Z',
        items: [item({ id: B, sku: 'SP-PAIR', binLocation: '22-C', quantityOnHand: 4 })],
      },
      active: [row(A, 'SP-PAIR', '22-A', 9), row(B, 'SP-NEW1', '22-C', 1)],
    });
    const res = await restoreSnapshot(ctx, { id: POINT, confirm: 'RESTORE' });
    expect(h.adjustStock).toHaveBeenCalledTimes(1);
    expect(h.adjustStock.mock.calls[0]?.[0]).toMatchObject({ itemId: B, quantityChange: 3 });
    expect(h.create).not.toHaveBeenCalled();
    // A is not in this point: flagged by its SKU, never deleted.
    expect(res).toMatchObject({
      updated: 1,
      recreated: 0,
      extrasFlagged: 1,
      extrasSample: ['SP-PAIR'],
    });
  });

  it('version 2: a record whose id is gone is found by SKU and rack, or re-created', async () => {
    const { ctx } = harness({
      snapshot: {
        version: 2,
        capturedAt: '2026-10-12T00:00:00.000Z',
        items: [
          // C was deleted; D now holds the same SKU and rack and is not in the point.
          item({ id: C, sku: 'SP-GONE', binLocation: '5-A', quantityOnHand: 2 }),
          // A was deleted and nothing holds SP-OLD at 7-B: re-created.
          item({ id: A, sku: 'SP-OLD', binLocation: '7-B', quantityOnHand: 6 }),
        ],
      },
      active: [row(D, 'SP-GONE', '5-A', 2)],
    });
    const res = await restoreSnapshot(ctx, { id: POINT, confirm: 'RESTORE' });
    expect(h.update.mock.calls.map((c) => c[0])).toEqual([D]);
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.create.mock.calls[0]?.[0]).toMatchObject({
      sku: 'SP-OLD',
      binLocation: '7-B',
      quantityOnHand: 6,
    });
    expect(res).toMatchObject({ updated: 1, recreated: 1, extrasFlagged: 0 });
  });

  it('version 2: never reconciles one record twice: a SKU and rack match the point reconciles by its own id is left to it', async () => {
    const { ctx } = harness({
      snapshot: {
        version: 2,
        capturedAt: '2026-10-12T00:00:00.000Z',
        items: [
          // Two charters' records shared SP-TWO on 3-C; C is gone, A is live.
          item({ id: C, sku: 'SP-TWO', binLocation: '3-C', quantityOnHand: 5 }),
          item({ id: A, sku: 'SP-TWO', binLocation: '3-C', quantityOnHand: 8 }),
        ],
      },
      active: [row(A, 'SP-TWO', '3-C', 8)],
    });
    const res = await restoreSnapshot(ctx, { id: POINT, confirm: 'RESTORE' });
    expect(h.update.mock.calls.map((c) => c[0])).toEqual([A]);
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.create.mock.calls[0]?.[0]).toMatchObject({
      sku: 'SP-TWO',
      binLocation: '3-C',
      quantityOnHand: 5,
    });
    expect(res).toMatchObject({ updated: 1, recreated: 1 });
  });

  // PR stage fix round 1 (review F3-restore-fanout): the restore reconciles a
  // record with InventoryService.update, which copies the shared product
  // fields it is given (name, barcode, cost, price, ...) to every other live
  // record holding the record's CURRENT SKU (Model B). Matching by id finds a
  // record whose SKU changed after the point; when that SKU now belongs to
  // records that did not share the point's SKU (here A was edited to Desk
  // Lamp's SKU), those fields overwrote the other product's records. Such a
  // record gets its stock and its own placement fields back, never the shared
  // ones.
  it("version 2: never copies the point's shared fields onto another product's records when a record's SKU now belongs to that product", async () => {
    const { ctx } = harness({
      snapshot: {
        version: 2,
        capturedAt: '2026-10-12T00:00:00.000Z',
        items: [
          item({ id: A, sku: 'SP-PAIR', unitCost: 5, binLocation: '22-A', quantityOnHand: 9 }),
          item({
            id: C,
            sku: 'SP-LAMP',
            name: 'Desk Lamp',
            unitCost: 30,
            binLocation: '7-B',
            quantityOnHand: 2,
          }),
        ],
      },
      // After the point A's SKU was edited to SP-LAMP, Desk Lamp's SKU.
      active: [row(A, 'SP-LAMP', '22-A', 4), row(C, 'SP-LAMP', '7-B', 2)],
    });
    const res = await restoreSnapshot(ctx, { id: POINT, confirm: 'RESTORE' });
    expect(h.update.mock.calls.map((c) => c[0])).toEqual([A, C]);
    expect(Object.keys(patchFor(A)).sort()).toEqual(PLACEMENT_PATCH_KEYS);
    expect(patchFor(A)).toMatchObject({ status: 'active', unitOfMeasure: 'unit' });
    // Its stock still comes back, on that same record.
    expect(h.adjustStock.mock.calls[0]?.[0]).toMatchObject({ itemId: A, quantityChange: 5 });
    // Desk Lamp still holds its SKU from the point: it gets every field back.
    expect(patchFor(C)).toMatchObject({ name: 'Desk Lamp', unitCost: 30 });
    expect(res).toMatchObject({ updated: 2, recreated: 0, extrasFlagged: 0 });
    expect(h.audit.mock.calls.at(-1)?.[0].extra).toMatchObject({ sharedFieldsKept: 1 });
  });

  it("version 2: a record whose SKU now belongs only to records the point does not hold keeps that product's shared fields too", async () => {
    const { ctx } = harness({
      snapshot: {
        version: 2,
        capturedAt: '2026-10-12T00:00:00.000Z',
        items: [item({ id: A, sku: 'SP-PAIR', binLocation: '22-A', quantityOnHand: 9 })],
      },
      // D was created after the point; A's SKU was then edited to D's.
      active: [row(A, 'SP-DESK', '22-A', 9), row(D, 'SP-DESK', '8-A', 1)],
    });
    const res = await restoreSnapshot(ctx, { id: POINT, confirm: 'RESTORE' });
    expect(h.update.mock.calls.map((c) => c[0])).toEqual([A]);
    expect(Object.keys(patchFor(A)).sort()).toEqual(PLACEMENT_PATCH_KEYS);
    expect(res).toMatchObject({ updated: 1, extrasFlagged: 1, extrasSample: ['SP-DESK'] });
  });

  it('version 2: records whose SKU changed together, as one product, get every field back', async () => {
    const { ctx } = harness({
      snapshot: {
        version: 2,
        capturedAt: '2026-10-12T00:00:00.000Z',
        items: [
          item({ id: A, sku: 'SP-PAIR', binLocation: '22-A', quantityOnHand: 9 }),
          item({ id: B, sku: 'SP-PAIR', binLocation: '22-C', quantityOnHand: 4 }),
        ],
      },
      // A's SKU was edited to SP-PAD3 and B followed it (Model B).
      active: [row(A, 'SP-PAD3', '22-A', 9), row(B, 'SP-PAD3', '22-C', 4)],
    });
    await restoreSnapshot(ctx, { id: POINT, confirm: 'RESTORE' });
    expect(h.update.mock.calls.map((c) => c[0])).toEqual([A, B]);
    for (const id of [A, B]) {
      expect(patchFor(id)).toMatchObject({
        name: 'Black Mouse Pad',
        unitCost: 0,
        status: 'active',
      });
    }
    expect(h.audit.mock.calls.at(-1)?.[0].extra).not.toHaveProperty('sharedFieldsKept');
  });

  // PR stage, DATA-1: this is now the SKU-EDIT case (no inventory.item.ungrouped
  // row records the change). A version 1 point restores it exactly as before:
  // the record is re-created under its old SKU and the one with the new SKU is
  // flagged, which the warning names before the typed confirm. The split case
  // is in the next describe block.
  it('version 1 (no ids) after a SKU edit restores exactly as before: by SKU and rack, so the record is re-created under its old SKU and flagged', async () => {
    const { ctx } = harness({
      snapshot: {
        version: 1,
        capturedAt: '2026-10-12T00:00:00.000Z',
        items: [
          item({ sku: 'SP-PAIR', binLocation: '22-A', quantityOnHand: 9 }),
          item({ sku: 'SP-PAIR', binLocation: '22-C', quantityOnHand: 4 }),
        ],
      },
      active: AFTER_SPLIT,
    });
    const res = await restoreSnapshot(ctx, { id: POINT, confirm: 'RESTORE' });
    expect(h.update.mock.calls.map((c) => c[0])).toEqual([A]);
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.create.mock.calls[0]?.[0]).toMatchObject({
      sku: 'SP-PAIR',
      binLocation: '22-C',
      quantityOnHand: 4,
    });
    expect(res).toMatchObject({
      updated: 1,
      recreated: 1,
      extrasFlagged: 1,
      extrasSample: ['SP-NEW1'],
    });
  });

  it('version 1 with no SKU change restores as before: every record matched by SKU and rack', async () => {
    const { ctx } = harness({
      snapshot: {
        version: 1,
        capturedAt: '2026-10-12T00:00:00.000Z',
        items: [
          item({ sku: 'SP-PAIR', binLocation: '22-A', quantityOnHand: 9 }),
          item({ sku: 'SP-PAIR', binLocation: '22-C', quantityOnHand: 5 }),
        ],
      },
      active: [row(A, 'SP-PAIR', '22-A', 9), row(B, 'SP-PAIR', '22-C', 4)],
    });
    const res = await restoreSnapshot(ctx, { id: POINT, confirm: 'RESTORE' });
    expect(h.update.mock.calls.map((c) => c[0])).toEqual([A, B]);
    expect(h.adjustStock.mock.calls[0]?.[0]).toMatchObject({ itemId: B, quantityChange: 1 });
    expect(h.create).not.toHaveBeenCalled();
    expect(res).toMatchObject({ updated: 2, recreated: 0, quantityAdjusted: 1, extrasFlagged: 0 });
  });
});

describe('restoreSnapshot: a version 1 point after an Ungroup (PR stage, DATA-1)', () => {
  // Before the split: A on 22-A (9) and B on 22-C (4) shared SP-PAIR, and the
  // version 1 point (no ids) remembers both by SKU and rack. The split gave B
  // SP-NEW1 and wrote an inventory.item.ungrouped row naming B and SP-PAIR.
  const POINT_V1: RestoreSnapshot = {
    version: 1,
    capturedAt: '2026-10-12T00:00:00.000Z',
    items: [
      item({ sku: 'SP-PAIR', binLocation: '22-A', quantityOnHand: 9 }),
      item({ sku: 'SP-PAIR', binLocation: '22-C', quantityOnHand: 4 }),
    ],
  };
  const AFTER_SPLIT = [row(A, 'SP-PAIR', '22-A', 9), row(B, 'SP-NEW1', '22-C', 4)];

  it('finds the split record through its Ungroup row and reconciles it by id: nothing re-created, nothing flagged, its stock once', async () => {
    h.splits = [splitRow(B, 'SP-PAIR')];
    const { ctx } = harness({ snapshot: POINT_V1, active: AFTER_SPLIT });
    const res = await restoreSnapshot(ctx, { id: POINT, confirm: 'RESTORE' });
    expect(h.create).not.toHaveBeenCalled();
    expect(h.adjustStock).not.toHaveBeenCalled();
    expect(h.update.mock.calls.map((c) => c[0])).toEqual([A, B]);
    // The restore still never writes a SKU: B keeps SP-NEW1.
    for (const c of h.update.mock.calls) expect(c[1]).not.toHaveProperty('sku');
    expect(res).toMatchObject({
      updated: 2,
      recreated: 0,
      quantityAdjusted: 0,
      failures: 0,
      extrasFlagged: 0,
      extrasSample: [],
    });
  });

  it("puts the point's stock back on the split record, whatever its SKU is now", async () => {
    h.splits = [splitRow(B, 'SP-PAIR')];
    const { ctx } = harness({
      snapshot: POINT_V1,
      active: [row(A, 'SP-PAIR', '22-A', 9), row(B, 'SP-NEW1', '22-C', 1)],
    });
    const res = await restoreSnapshot(ctx, { id: POINT, confirm: 'RESTORE' });
    expect(h.adjustStock).toHaveBeenCalledTimes(1);
    expect(h.adjustStock.mock.calls[0]?.[0]).toMatchObject({ itemId: B, quantityChange: 3 });
    expect(h.create).not.toHaveBeenCalled();
    expect(res).toMatchObject({ updated: 2, recreated: 0, quantityAdjusted: 1, extrasFlagged: 0 });
  });

  it("reads only the organization's Ungroup rows written after the point, with the service role, and never through the caller's audit-log access", async () => {
    h.splits = [splitRow(B, 'SP-PAIR')];
    const { ctx, reads } = harness(
      { snapshot: POINT_V1, active: AFTER_SPLIT },
      { role: 'admin', permissions: adminWithout('activity_logs:read') },
    );
    const res = await restoreSnapshot(ctx, { id: POINT, confirm: 'RESTORE' });
    const splitRead = h.adminReads.filter((r) => r.table === 'audit_logs');
    expect(splitRead).toHaveLength(1);
    expect(splitRead[0]!.filters).toEqual(
      expect.arrayContaining([
        ['eq', 'organization_id', ORG],
        ['eq', 'event', 'inventory.item.ungrouped'],
        ['gt', 'created_at', POINT_V1.capturedAt],
      ]),
    );
    expect(splitRead[0]!.select.split(',').map((x) => x.trim())).toEqual([
      'id',
      'item_id:metadata->>entity_id',
      'left_sku:metadata->>left_sku',
    ]);
    expect(reads.some((r) => r.table === 'audit_logs')).toBe(false);
    // An admin whose audit-log view was revoked gets the same restore.
    expect(res).toMatchObject({ updated: 2, recreated: 0, extrasFlagged: 0 });
  });

  it('never takes a split record that is on another rack now, or gone: the old record is re-created as before', async () => {
    h.splits = [splitRow(B, 'SP-PAIR'), splitRow(C, 'SP-PAIR')];
    const { ctx } = harness({
      snapshot: {
        ...POINT_V1,
        items: [
          ...POINT_V1.items,
          item({ sku: 'SP-PAIR', binLocation: '22-E', quantityOnHand: 2 }),
        ],
      },
      // B moved from 22-C to 22-D after its split; C (split from 22-E) is gone.
      active: [row(A, 'SP-PAIR', '22-A', 9), row(B, 'SP-NEW1', '22-D', 4)],
    });
    const res = await restoreSnapshot(ctx, { id: POINT, confirm: 'RESTORE' });
    expect(h.update.mock.calls.map((c) => c[0])).toEqual([A]);
    expect(
      h.create.mock.calls.map((c) => [
        (c[0] as SnapshotItem).sku,
        (c[0] as SnapshotItem).binLocation,
      ]),
    ).toEqual([
      ['SP-PAIR', '22-C'],
      ['SP-PAIR', '22-E'],
    ]);
    expect(res).toMatchObject({
      updated: 1,
      recreated: 2,
      extrasFlagged: 1,
      extrasSample: ['SP-NEW1'],
    });
  });

  it('takes each split record once: two records the point held on one rack get the two records split from there, in the order they were split', async () => {
    // Two charters' records shared SP-PAIR on 22-C (the point has no charter);
    // both were split, B first.
    h.splits = [splitRow(B, 'SP-PAIR'), splitRow(C, 'SP-PAIR')];
    const { ctx } = harness({
      snapshot: {
        ...POINT_V1,
        items: [
          item({ sku: 'SP-PAIR', binLocation: '22-A', quantityOnHand: 9 }),
          item({ sku: 'SP-PAIR', binLocation: '22-C', quantityOnHand: 4 }),
          item({ sku: 'SP-PAIR', binLocation: '22-C', quantityOnHand: 5 }),
        ],
      },
      active: [
        row(A, 'SP-PAIR', '22-A', 9),
        row(B, 'SP-NEW1', '22-C', 4),
        row(C, 'SP-NEW2', '22-C', 5),
      ],
    });
    const res = await restoreSnapshot(ctx, { id: POINT, confirm: 'RESTORE' });
    expect(h.update.mock.calls.map((c) => c[0])).toEqual([A, B, C]);
    expect(h.create).not.toHaveBeenCalled();
    expect(h.adjustStock).not.toHaveBeenCalled();
    expect(res).toMatchObject({ updated: 3, recreated: 0, extrasFlagged: 0 });
  });

  it('never takes a record that the point already reconciles by its own SKU and rack', async () => {
    // D was split from SP-PAIR on 22-C and later edited to SP-LAMP, a SKU the
    // point remembers on 22-C: the point's SP-LAMP record reconciles D, so the
    // SP-PAIR record on 22-C is re-created rather than reconciling D twice.
    h.splits = [splitRow(D, 'SP-PAIR')];
    const { ctx } = harness({
      snapshot: {
        ...POINT_V1,
        items: [
          ...POINT_V1.items,
          item({ sku: 'SP-LAMP', binLocation: '22-C', quantityOnHand: 1 }),
        ],
      },
      active: [row(A, 'SP-PAIR', '22-A', 9), row(D, 'SP-LAMP', '22-C', 1)],
    });
    const res = await restoreSnapshot(ctx, { id: POINT, confirm: 'RESTORE' });
    expect(h.update.mock.calls.map((c) => c[0])).toEqual([A, D]);
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.create.mock.calls[0]?.[0]).toMatchObject({ sku: 'SP-PAIR', binLocation: '22-C' });
    expect(res).toMatchObject({ updated: 2, recreated: 1, extrasFlagged: 0 });
  });

  // PR stage fix round 1 (review F3-restore-fanout): a split record found
  // through its split whose SKU was later edited to another product's SKU gets
  // its stock and placement fields back, never the point's shared fields,
  // which update() would copy onto that product's records.
  it("never copies the point's shared fields onto another product's records when the split record's SKU was later edited to that product's SKU", async () => {
    // B was split from SP-PAIR on 22-C, then edited to SP-LAMP, the SKU of
    // Desk Lamp (on 7-B, in the point).
    h.splits = [splitRow(B, 'SP-PAIR')];
    const { ctx } = harness({
      snapshot: {
        ...POINT_V1,
        items: [
          ...POINT_V1.items,
          item({ sku: 'SP-LAMP', name: 'Desk Lamp', binLocation: '7-B', quantityOnHand: 2 }),
        ],
      },
      active: [
        row(A, 'SP-PAIR', '22-A', 9),
        row(B, 'SP-LAMP', '22-C', 4),
        row(C, 'SP-LAMP', '7-B', 2),
      ],
    });
    const res = await restoreSnapshot(ctx, { id: POINT, confirm: 'RESTORE' });
    expect(h.update.mock.calls.map((c) => c[0])).toEqual([A, B, C]);
    expect(Object.keys(patchFor(B)).sort()).toEqual(PLACEMENT_PATCH_KEYS);
    expect(patchFor(A)).toMatchObject({ name: 'Black Mouse Pad' });
    expect(patchFor(C)).toMatchObject({ name: 'Desk Lamp' });
    expect(res).toMatchObject({ updated: 3, recreated: 0, extrasFlagged: 0 });
    expect(h.audit.mock.calls.at(-1)?.[0].extra).toMatchObject({
      matchedBySplit: 1,
      sharedFieldsKept: 1,
    });
  });

  it('says in the restore audit row how many records it found through a split; a version 1 restore with none says nothing new', async () => {
    h.splits = [splitRow(B, 'SP-PAIR')];
    const { ctx } = harness({ snapshot: POINT_V1, active: AFTER_SPLIT });
    await restoreSnapshot(ctx, { id: POINT, confirm: 'RESTORE' });
    expect(h.audit.mock.calls.at(-1)?.[0]).toMatchObject({
      event: 'restore_point.restored',
      extra: { snapshotVersion: 1, recreated: 0, extras: 0, matchedBySplit: 1 },
    });
    vi.clearAllMocks();
    h.splits = [];
    const again = harness({
      snapshot: POINT_V1,
      active: [row(A, 'SP-PAIR', '22-A', 9), row(B, 'SP-PAIR', '22-C', 4)],
    });
    await restoreSnapshot(again.ctx, { id: POINT, confirm: 'RESTORE' });
    expect(h.audit.mock.calls.at(-1)?.[0].extra).not.toHaveProperty('matchedBySplit');
  });

  it('a version 2 point reads no Ungroup row: it matches by id', async () => {
    h.splits = [splitRow(B, 'SP-PAIR')];
    const { ctx } = harness({
      snapshot: {
        version: 2,
        capturedAt: '2026-10-12T00:00:00.000Z',
        items: [
          item({ id: A, sku: 'SP-PAIR', binLocation: '22-A', quantityOnHand: 9 }),
          item({ id: B, sku: 'SP-PAIR', binLocation: '22-C', quantityOnHand: 4 }),
        ],
      },
      active: AFTER_SPLIT,
    });
    await restoreSnapshot(ctx, { id: POINT, confirm: 'RESTORE' });
    expect(h.adminReads.some((r) => r.table === 'audit_logs')).toBe(false);
    expect(h.audit.mock.calls.at(-1)?.[0].extra).not.toHaveProperty('matchedBySplit');
  });

  it('refuses before writing anything when the Ungroup rows cannot be read', async () => {
    h.splitsError = { message: 'gateway timeout' };
    const { ctx } = harness({ snapshot: POINT_V1, active: AFTER_SPLIT });
    await expect(restoreSnapshot(ctx, { id: POINT, confirm: 'RESTORE' })).rejects.toMatchObject({
      code: 'internal_error',
    });
    // No pre-restore point, no record touched.
    expect(h.inserted).toHaveLength(0);
    expect(h.update).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
    expect(h.adjustStock).not.toHaveBeenCalled();
  });
});

describe('restorePointSkuChanges (the warning before restoring a version 1 point)', () => {
  const V1 = {
    version: 1,
    captured_at: '2026-10-10T08:00:00.000Z',
    created_at: '2026-10-10T08:00:01.000Z',
  };

  it('names each record whose SKU was edited after the point was taken, oldest first, with its old and new SKU', async () => {
    const { ctx, reads } = harness({
      point: V1,
      audit: [
        {
          entity_id: B,
          event: 'inventory.item.updated',
          before_sku: 'SP-PAIR',
          after_sku: 'SP-NEW1',
          propagated: null,
        },
        {
          entity_id: C,
          event: 'inventory.item.updated',
          before_sku: 'SP-OLD',
          after_sku: 'SP-MID',
          propagated: 'SP-MID',
        },
        {
          entity_id: C,
          event: 'inventory.item.updated',
          before_sku: 'SP-MID',
          after_sku: 'SP-LAST',
          propagated: null,
        },
      ],
      names: [
        { id: C, name: 'Hoodie', sku: 'SP-LAST' },
        { id: B, name: 'Black Mouse Pad', sku: 'SP-NEW1' },
      ],
      // C's sibling followed it to SP-LAST (the Model B edit carried it along).
      holders: [
        { id: C, sku: 'SP-LAST' },
        { id: D, sku: 'SP-LAST' },
      ],
    });
    const res = await restorePointSkuChanges(ctx, POINT);
    expect(res).toEqual({
      version: 1,
      changes: [
        { itemId: B, name: 'Black Mouse Pad', before: 'SP-PAIR', after: 'SP-NEW1', shared: false },
        { itemId: C, name: 'Hoodie', before: 'SP-OLD', after: 'SP-LAST', shared: true },
      ],
      more: 0,
      truncated: false,
    });
    const audit = reads.find((r) => r.table === 'audit_logs')!;
    expect(audit.filters).toEqual(
      expect.arrayContaining([
        ['eq', 'organization_id', ORG],
        ['in', 'event', ['inventory.item.updated', 'inventory.item.ungrouped']],
        ['gt', 'created_at', V1.captured_at],
        ['filter', 'metadata->changed_keys', 'cs', '["sku"]'],
      ]),
    );
    expect(audit.order).toEqual([['created_at', { ascending: true }]]);
    const names = reads.find((r) => r.table === 'inventory_items')!;
    expect(names.filters).toEqual(expect.arrayContaining([['eq', 'organization_id', ORG]]));
  });

  it('a version 2 point needs no warning and reads no audit log', async () => {
    const { ctx, reads } = harness({
      point: {
        version: 2,
        captured_at: '2026-10-12T08:00:00.000Z',
        created_at: '2026-10-12T08:00:01.000Z',
      },
    });
    expect(await restorePointSkuChanges(ctx, POINT)).toEqual({
      version: 2,
      changes: [],
      more: 0,
      truncated: false,
    });
    expect(reads.some((r) => r.table === 'audit_logs')).toBe(false);
  });

  // PR stage (found by the D1 lab): update() writes propagated_to_sku whenever
  // its Model B fan-out runs, even when no other record had the SKU, so the flag
  // alone made the warning say "with the records that shared it" for a record
  // that shared nothing. The line now says it only when other live records hold
  // the record's new SKU now (the siblings that followed it).
  it('says "with the records that shared it" only when other records now hold the new SKU, not for a record that shared nothing', async () => {
    const { ctx, reads } = harness({
      point: V1,
      audit: [
        {
          entity_id: B,
          event: 'inventory.item.updated',
          before_sku: 'QA-CABLE',
          after_sku: 'QA-CABLE-2',
          propagated: 'QA-CABLE-2',
        },
        {
          entity_id: C,
          event: 'inventory.item.updated',
          before_sku: 'SP-OLD',
          after_sku: 'SP-NEW',
          propagated: 'SP-NEW',
        },
      ],
      names: [
        { id: B, name: 'HDMI Cable', sku: 'QA-CABLE-2' },
        { id: C, name: 'Hoodie', sku: 'SP-NEW' },
      ],
      // B alone holds QA-CABLE-2; C and the sibling that followed it hold SP-NEW.
      holders: [
        { id: B, sku: 'QA-CABLE-2' },
        { id: C, sku: 'SP-NEW' },
        { id: D, sku: 'SP-NEW' },
      ],
    });
    expect((await restorePointSkuChanges(ctx, POINT)).changes).toEqual([
      { itemId: B, name: 'HDMI Cable', before: 'QA-CABLE', after: 'QA-CABLE-2', shared: false },
      { itemId: C, name: 'Hoodie', before: 'SP-OLD', after: 'SP-NEW', shared: true },
    ]);
    const holders = reads.find(
      (r) =>
        r.table === 'inventory_items' && r.filters.some((f) => f[0] === 'in' && f[1] === 'sku'),
    );
    // PR stage fix round 1 (F2): the holders' ids are read too, so the record
    // itself is never counted as one that shared its SKU.
    expect(holders?.select).toBe('id, sku');
    expect(holders!.filters).toEqual(
      expect.arrayContaining([
        ['eq', 'organization_id', ORG],
        ['is', 'deleted_at', null],
        ['in', 'sku', ['QA-CABLE-2', 'SP-NEW']],
      ]),
    );
  });

  it('a version 1 point with no SKU change since gives an empty list', async () => {
    const { ctx } = harness({ point: V1, audit: [] });
    expect(await restorePointSkuChanges(ctx, POINT)).toEqual({
      version: 1,
      changes: [],
      more: 0,
      truncated: false,
    });
  });

  it('names at most ten records and counts the rest', async () => {
    const ids = Array.from(
      { length: 13 },
      (_, i) => `eeeeeeee-eeee-4eee-8eee-${String(i).padStart(12, '0')}`,
    );
    const { ctx, reads } = harness({
      point: V1,
      audit: ids.map((id, i) => ({
        entity_id: id,
        event: 'inventory.item.updated',
        before_sku: 'SP-PAIR',
        after_sku: `SP-N${i}`,
        propagated: null,
      })),
      names: ids.slice(0, 10).map((id, i) => ({ id, name: `Record ${i}`, sku: `SP-N${i}` })),
    });
    const res = await restorePointSkuChanges(ctx, POINT);
    expect(res.changes).toHaveLength(10);
    expect(res.more).toBe(3);
    const names = reads.find((r) => r.table === 'inventory_items')!;
    const inFilter = names.filters.find((f) => f[0] === 'in')!;
    expect((inFilter[2] as string[]).length).toBe(10);
  });

  it('says the count is a floor when the audit read was cut at its limit', async () => {
    const ids = Array.from(
      { length: SKU_CHANGES_SCAN },
      (_, i) => `eeeeeeee-eeee-4eee-8eee-${String(i).padStart(12, '0')}`,
    );
    const { ctx, reads } = harness({
      point: V1,
      audit: ids.map((id) => ({
        entity_id: id,
        event: 'inventory.item.updated',
        before_sku: 'SP-PAIR',
        after_sku: 'SP-X',
        propagated: null,
      })),
      names: [],
    });
    const res = await restorePointSkuChanges(ctx, POINT);
    expect(res).toMatchObject({ more: SKU_CHANGES_SCAN - 10, truncated: true });
    expect(reads.find((r) => r.table === 'audit_logs')?.limit).toBe(SKU_CHANGES_SCAN);
  });

  it('a record the caller cannot read is still listed by its SKUs, without a name', async () => {
    const { ctx } = harness({
      point: V1,
      audit: [
        {
          entity_id: D,
          event: 'inventory.item.updated',
          before_sku: 'SP-A',
          after_sku: 'SP-B',
          propagated: null,
        },
      ],
      names: [],
    });
    expect((await restorePointSkuChanges(ctx, POINT)).changes).toEqual([
      { itemId: D, name: null, before: 'SP-A', after: 'SP-B', shared: false },
    ]);
  });

  // PR stage, DATA-1: a record Ungroup split is found through its split when
  // the point is restored (restoreSnapshot's version 1 path), so it is never
  // added again and the warning leaves it out, a later SKU edit of it
  // included. Only SKU edits of records that were not split are named.
  it('leaves out records that Ungroup split, even when their new SKU was edited later; a SKU edit of another record is still named', async () => {
    const { ctx } = harness({
      point: V1,
      audit: [
        {
          entity_id: B,
          event: 'inventory.item.ungrouped',
          before_sku: 'SP-PAIR',
          after_sku: 'SP-NEW1',
          propagated: null,
        },
        {
          entity_id: C,
          event: 'inventory.item.updated',
          before_sku: 'SP-OLD',
          after_sku: 'SP-MID',
          propagated: null,
        },
        {
          entity_id: B,
          event: 'inventory.item.updated',
          before_sku: 'SP-NEW1',
          after_sku: 'SP-NEW2',
          propagated: null,
        },
      ],
      names: [{ id: C, name: 'Hoodie', sku: 'SP-MID' }],
    });
    expect(await restorePointSkuChanges(ctx, POINT)).toEqual({
      version: 1,
      changes: [{ itemId: C, name: 'Hoodie', before: 'SP-OLD', after: 'SP-MID', shared: false }],
      more: 0,
      truncated: false,
    });
  });

  // PR stage fix round 1 (F2, the owner's mouse pads): A on 22-A and B on 22-C
  // shared SP-PAIR when the version 1 point was taken. After it, A's SKU was
  // edited to SP-PAD3 and B followed (Model B writes one audit row, A's). Then
  // Ungroup split one of them. The restore finds a split record only by the
  // SKU its split left (planSplitMatches), and both left SP-PAD3, not the
  // point's SP-PAIR, so the restore adds both again under SP-PAIR. The warning
  // left out every record with an Ungroup row, the edit before its split
  // included: it named nothing, or A without the records that shared it.
  const EDIT_A = {
    entity_id: A,
    event: 'inventory.item.updated',
    before_sku: 'SP-PAIR',
    after_sku: 'SP-PAD3',
    propagated: 'SP-PAD3',
  };

  it('names a record whose SKU was edited and then split, from its SKU at the point to its newest, with the records that shared it', async () => {
    const { ctx } = harness({
      point: V1,
      audit: [
        EDIT_A,
        {
          entity_id: A,
          event: 'inventory.item.ungrouped',
          before_sku: 'SP-PAD3',
          after_sku: 'SP-NEW1',
          propagated: null,
        },
      ],
      names: [{ id: A, name: 'Black Mouse Pad', sku: 'SP-NEW1' }],
      // B followed A's edit and still holds SP-PAD3; A alone holds SP-NEW1.
      holders: [
        { id: B, sku: 'SP-PAD3' },
        { id: A, sku: 'SP-NEW1' },
      ],
    });
    expect(await restorePointSkuChanges(ctx, POINT)).toEqual({
      version: 1,
      changes: [
        { itemId: A, name: 'Black Mouse Pad', before: 'SP-PAIR', after: 'SP-NEW1', shared: true },
      ],
      more: 0,
      truncated: false,
    });
  });

  it('keeps "with the records that shared it" on a SKU edit when a record that followed it was split since, and leaves that split record out', async () => {
    const { ctx } = harness({
      point: V1,
      audit: [
        EDIT_A,
        {
          entity_id: B,
          event: 'inventory.item.ungrouped',
          before_sku: 'SP-PAD3',
          after_sku: 'SP-NEW1',
          propagated: null,
        },
      ],
      names: [{ id: A, name: 'Black Mouse Pad', sku: 'SP-PAD3' }],
      // A alone holds SP-PAD3 now: B left it through its split.
      holders: [{ id: A, sku: 'SP-PAD3' }],
    });
    expect(await restorePointSkuChanges(ctx, POINT)).toEqual({
      version: 1,
      changes: [
        { itemId: A, name: 'Black Mouse Pad', before: 'SP-PAIR', after: 'SP-PAD3', shared: true },
      ],
      more: 0,
      truncated: false,
    });
  });

  it('does not count a record that left the new SKU through a split before the edit as one that followed it', async () => {
    const { ctx } = harness({
      point: V1,
      audit: [
        // C left SP-PAD3, its SKU at the point, before A was edited to it: the
        // restore finds C through its split, and C never followed A.
        {
          entity_id: C,
          event: 'inventory.item.ungrouped',
          before_sku: 'SP-PAD3',
          after_sku: 'SP-NEW2',
          propagated: null,
        },
        EDIT_A,
      ],
      names: [{ id: A, name: 'Black Mouse Pad', sku: 'SP-PAD3' }],
      holders: [{ id: A, sku: 'SP-PAD3' }],
    });
    expect((await restorePointSkuChanges(ctx, POINT)).changes).toEqual([
      { itemId: A, name: 'Black Mouse Pad', before: 'SP-PAIR', after: 'SP-PAD3', shared: false },
    ]);
  });

  it('a version 1 point with only splits since gives an empty list: the restore finds them', async () => {
    const { ctx } = harness({
      point: V1,
      audit: [
        {
          entity_id: B,
          event: 'inventory.item.ungrouped',
          before_sku: 'SP-PAIR',
          after_sku: 'SP-NEW1',
          propagated: null,
        },
      ],
    });
    expect(await restorePointSkuChanges(ctx, POINT)).toMatchObject({ changes: [], more: 0 });
  });

  // Final round (review DR2-1): the restore finds a split record through its
  // split only when no live record holds the SKU it left on its rack.
  // planSplitMatches skips a point record whose SKU and rack a live record
  // holds, and restoreSnapshot reconciles THAT record with the split record's
  // stock at the point instead, while the split record keeps its own stock as
  // an extra. A record in another charter on the same rack (case a), or one put
  // there with the old SKU after the split (case b, a Duplicate of the record
  // that kept it), does exactly that, and the warning left every split record
  // out: a double count, or a record's stock overwritten, with no warning line.
  const SPLIT_B = {
    entity_id: B,
    event: 'inventory.item.ungrouped',
    before_sku: 'UG-REST',
    after_sku: 'SP-NEWB',
    propagated: null,
  };

  it("names a split record when a record put on its rack after the split has the SKU it left there (case b), and says what restoring does to that record's stock", async () => {
    const { ctx, reads } = harness({
      point: V1,
      audit: [SPLIT_B],
      // B is still on 6-B. A kept UG-REST on 6-A; D, a Duplicate of A put on
      // 6-B after the split, has UG-REST there (the restore trims both racks).
      splitRacks: [{ id: B, bin_location: '6-B' }],
      oldSkuHolders: [
        { id: A, sku: 'UG-REST', bin_location: '6-A' },
        { id: D, sku: 'UG-REST', bin_location: ' 6-B ' },
      ],
      names: [{ id: B, name: 'Restore Lamp', sku: 'SP-NEWB' }],
    });
    expect(await restorePointSkuChanges(ctx, POINT)).toEqual({
      version: 1,
      changes: [
        {
          itemId: B,
          name: 'Restore Lamp',
          before: 'UG-REST',
          after: 'SP-NEWB',
          shared: false,
          oldSkuOnItsRack: true,
        },
      ],
      more: 0,
      truncated: false,
    });
    // Two reads through the caller's RLS, never the service role: the split
    // records' racks now, by id, and the live records with the SKUs they left.
    const racks = reads.find(
      (r) => r.table === 'inventory_items' && r.select === 'id, bin_location',
    );
    expect(racks?.filters).toEqual(
      expect.arrayContaining([
        ['eq', 'organization_id', ORG],
        ['is', 'deleted_at', null],
        ['in', 'id', [B]],
      ]),
    );
    const holders = reads.find(
      (r) => r.table === 'inventory_items' && r.select === 'id, sku, bin_location',
    );
    expect(holders?.filters).toEqual(
      expect.arrayContaining([
        ['eq', 'organization_id', ORG],
        ['is', 'deleted_at', null],
        ['in', 'sku', ['UG-REST']],
      ]),
    );
    expect(h.adminReads).toEqual([]);
  });

  it('names a split record when a record in another charter has the SKU it left on the same rack (case a), from that SKU to its newest', async () => {
    const { ctx } = harness({
      point: V1,
      audit: [
        SPLIT_B,
        {
          entity_id: B,
          event: 'inventory.item.updated',
          before_sku: 'SP-NEWB',
          after_sku: 'SP-NEWB2',
          propagated: null,
        },
      ],
      // A (one charter) and B (another) shared UG-REST on 6-B at the point. A
      // version 1 point carries no charter, so both point records match A.
      splitRacks: [{ id: B, bin_location: '6-B' }],
      oldSkuHolders: [{ id: A, sku: 'UG-REST', bin_location: '6-B' }],
      names: [{ id: B, name: 'Restore Lamp', sku: 'SP-NEWB2' }],
    });
    expect((await restorePointSkuChanges(ctx, POINT)).changes).toEqual([
      {
        itemId: B,
        name: 'Restore Lamp',
        before: 'UG-REST',
        after: 'SP-NEWB2',
        shared: false,
        oldSkuOnItsRack: true,
      },
    ]);
  });

  it('still leaves a split record out when no other live record has the SKU it left on its rack: only on other racks, only itself (its SKU edited back), or the record is gone', async () => {
    const { ctx } = harness({
      point: V1,
      audit: [
        SPLIT_B,
        {
          entity_id: C,
          event: 'inventory.item.ungrouped',
          before_sku: 'UG-MAT',
          after_sku: 'SP-NEWC',
          propagated: null,
        },
        {
          entity_id: C,
          event: 'inventory.item.updated',
          before_sku: 'SP-NEWC',
          after_sku: 'UG-MAT',
          propagated: null,
        },
        {
          entity_id: D,
          event: 'inventory.item.ungrouped',
          before_sku: 'UG-HOOD',
          after_sku: 'SP-NEWD',
          propagated: null,
        },
      ],
      // UG-REST is on 6-A only; C, edited back to UG-MAT, is the record with it
      // on 7-D; D has no live row.
      splitRacks: [
        { id: B, bin_location: '6-B' },
        { id: C, bin_location: '7-D' },
      ],
      oldSkuHolders: [
        { id: A, sku: 'UG-REST', bin_location: '6-A' },
        { id: C, sku: 'UG-MAT', bin_location: '7-D' },
      ],
    });
    expect(await restorePointSkuChanges(ctx, POINT)).toEqual({
      version: 1,
      changes: [],
      more: 0,
      truncated: false,
    });
  });

  it("a failed read of the split records' racks, or of the records with the SKUs they left, is an error, never an all-clear", async () => {
    for (const failed of [
      { splitRacksError: { message: 'boom' } },
      { oldSkuHoldersError: { message: 'boom' } },
    ]) {
      const { ctx } = harness({
        point: V1,
        audit: [SPLIT_B],
        splitRacks: [{ id: B, bin_location: '6-B' }],
        ...failed,
      });
      await expect(restorePointSkuChanges(ctx, POINT)).rejects.toMatchObject({
        code: 'internal_error',
      });
    }
  });

  it('counts such split records against the same cap: at most ten named, the rest counted', async () => {
    const ids = Array.from(
      { length: 12 },
      (_, i) => `eeeeeeee-eeee-4eee-8eee-${String(i).padStart(12, '0')}`,
    );
    const { ctx } = harness({
      point: V1,
      audit: ids.map((id, i) => ({
        entity_id: id,
        event: 'inventory.item.ungrouped',
        before_sku: `UG-${i}`,
        after_sku: `SP-N${i}`,
        propagated: null,
      })),
      splitRacks: ids.map((id) => ({ id, bin_location: '6-B' })),
      oldSkuHolders: ids.map((_, i) => ({
        id: `ffffffff-ffff-4fff-8fff-${String(i).padStart(12, '0')}`,
        sku: `UG-${i}`,
        bin_location: '6-B',
      })),
      names: [],
    });
    const res = await restorePointSkuChanges(ctx, POINT);
    expect(res.changes).toHaveLength(10);
    expect(res.changes.every((c) => c.oldSkuOnItsRack === true)).toBe(true);
    expect(res.more).toBe(2);
  });

  // PR stage, DATA-1 (2): the audit log's read policy (0279) needs
  // activity_logs:read, which an override can take from an admin while
  // Backups & restore stays open to them (organization:update). Reading through
  // their RLS answered an empty list, which the screen showed as no warning.
  // The check now says it could not run, and reads nothing: the warning shows
  // audit facts (which record had which SKU), so it is not read past the
  // permission; the restore itself finds split records with the service role
  // and shows nothing of what it read.
  it('says the check cannot run, never an empty all-clear, for an admin who cannot view the audit log, and reads no audit row', async () => {
    const { ctx, reads } = harness(
      { point: V1, audit: [] },
      { role: 'admin', permissions: adminWithout('activity_logs:read') },
    );
    await expect(restorePointSkuChanges(ctx, POINT)).rejects.toMatchObject({
      code: 'forbidden',
      details: { reason: 'audit_log_hidden' },
    });
    expect(reads.some((r) => r.table === 'audit_logs')).toBe(false);
    expect(h.adminReads.some((r) => r.table === 'audit_logs')).toBe(false);
  });

  it('a version 2 point needs no audit log, so that admin gets no warning there either', async () => {
    const { ctx } = harness(
      {
        point: {
          version: 2,
          captured_at: '2026-10-12T08:00:00.000Z',
          created_at: '2026-10-12T08:00:01.000Z',
        },
      },
      { role: 'admin', permissions: adminWithout('activity_logs:read') },
    );
    expect(await restorePointSkuChanges(ctx, POINT)).toEqual({
      version: 2,
      changes: [],
      more: 0,
      truncated: false,
    });
  });

  it('checks the same owner/admin gate as the restore itself, and refuses a point that is not there', async () => {
    const { ctx } = harness({ point: null });
    await expect(restorePointSkuChanges(ctx, POINT)).rejects.toMatchObject({ code: 'not_found' });
    expect(h.assertPermission).toHaveBeenCalledWith(ctx, 'organization:update');
  });

  it('a failed audit read is an error, never an empty all-clear', async () => {
    const { ctx } = harness({ point: V1, auditError: { message: 'boom' } });
    await expect(restorePointSkuChanges(ctx, POINT)).rejects.toMatchObject({
      code: 'internal_error',
    });
  });
});

describe('what a restore gives back to a record whose SKU now belongs to another product (PR stage fix round 1)', () => {
  // The placement patch must never carry a shared product field: update()
  // copies those to every record with the record's SKU. Read from the source,
  // so a field moved into SHARED_ITEM_FIELDS later fails here.
  it("sends none of InventoryService's SHARED_ITEM_FIELDS", () => {
    const src = readFileSync(join(__dirname, 'inventory.ts'), 'utf8');
    const block = /const SHARED_ITEM_FIELDS = \[([\s\S]*?)\] as const;/.exec(src)?.[1] ?? '';
    const shared = [...block.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    // The list was found: the fields an edit copies to every record of a SKU.
    expect(shared).toEqual(expect.arrayContaining(['name', 'sku', 'unit_cost', 'barcode']));
    for (const col of ['primary_location_id', 'status', 'supplier_id', 'unit_of_measure']) {
      expect(shared, col).not.toContain(col);
    }
    expect(PLACEMENT_PATCH_KEYS).toEqual([
      'primaryLocationId',
      'status',
      'supplierId',
      'unitOfMeasure',
    ]);
  });
});
