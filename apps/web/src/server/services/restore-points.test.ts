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
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  update: vi.fn(async (..._a: unknown[]) => ({})),
  create: vi.fn(async (..._a: unknown[]) => ({})),
  adjustStock: vi.fn(async (..._a: unknown[]) => ({})),
  audit: vi.fn(),
  assertPermission: vi.fn(),
  assertCurrentAal2: vi.fn(async () => undefined),
  inserted: [] as Array<Record<string, unknown>>,
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
    from: () => {
      const q: Record<string, unknown> = {};
      q.insert = (v: Record<string, unknown>) => (h.inserted.push(v), q);
      q.select = () => q;
      q.eq = () => q;
      q.order = () => q;
      q.range = async () => ({ data: [], error: null });
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
  auditError?: { message: string } | null;
}

function harness(world: World) {
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
      if (r.select.startsWith('id, sku, bin_location'))
        return { data: world.active ?? [], error: null };
      if (r.select === 'id, name, sku') return { data: world.names ?? [], error: null };
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
    role: 'owner',
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

beforeEach(() => {
  vi.clearAllMocks();
  h.inserted.length = 0;
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

  it('version 1 (no ids) restores exactly as before: by SKU and rack, so the split record is re-created under its old SKU and flagged', async () => {
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

describe('restorePointSkuChanges (the warning before restoring a version 1 point)', () => {
  const V1 = {
    version: 1,
    captured_at: '2026-10-10T08:00:00.000Z',
    created_at: '2026-10-10T08:00:01.000Z',
  };

  it('names each record that changed SKU after the point was taken, oldest first, with its old and new SKU', async () => {
    const { ctx, reads } = harness({
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
        event: 'inventory.item.ungrouped',
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
        event: 'inventory.item.ungrouped',
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
