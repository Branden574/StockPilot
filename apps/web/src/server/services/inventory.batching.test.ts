import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * InventoryService keeps every id list under the request-URL limits.
 *
 * Bulk operations carry up to 500 ids, exports up to 10,000, item history up
 * to 2000 rows of references. One `.in()` past ~215 uuids answers 414 locally
 * and fails as "fetch failed" in production after ~7 s of retries. Reads that
 * decide stock, availability, access or audit throw on a failed batch; labels
 * degrade with a report; writes run one batch at a time and account for what
 * committed.
 */

const { reportError, invalidate, audit, access } = vi.hoisted(() => ({
  reportError: vi.fn(async () => {}),
  invalidate: vi.fn(),
  audit: vi.fn(async () => undefined),
  access: {
    current: {
      readableIds: ['wh-1'],
      writableIds: ['wh-1'],
      hasAllAccess: true,
      primaryWarehouseId: 'wh-1',
    } as {
      readableIds: string[];
      writableIds: string[];
      hasAllAccess: boolean;
      primaryWarehouseId: string | null;
    },
  },
}));
vi.mock('@/lib/error-reporter', () => ({ reportError }));
vi.mock('./lib/inventory-list-cache', () => ({ invalidateInventoryListAfterWrite: invalidate }));
vi.mock('./audit', () => ({ audit }));
vi.mock('./integration-events', () => ({ dispatchEvent: vi.fn(async () => undefined) }));
vi.mock('@/lib/auth/warehouse', () => ({
  getWarehouseAccess: vi.fn(async () => access.current),
  assertWarehouseAccess: vi.fn(),
  forcedWarehouseId: vi.fn(async () => 'wh-1'),
  ForbiddenError: class ForbiddenError extends Error {},
}));
const grants = vi.hoisted(() => ({ current: null as Set<string> | null }));
vi.mock('./user-categories', () => ({
  UserCategoriesService: class {
    async getGrantedCategoryIdsForViewer() {
      return grants.current;
    }
  },
}));
vi.spyOn(console, 'error').mockImplementation(() => {});

import {
  callArgs,
  inFilters,
  makeServiceContext,
  makeSupabaseStub,
  type MockCall,
} from '@/test/supabase-mock';

import type { ServiceError } from './context';
import { InventoryService } from './inventory';

const uuid = (i: number, p = '0') => `${p.repeat(8)}-0000-4000-8000-${String(i).padStart(12, '0')}`;
const ids = (n: number, p = 'a') => Array.from({ length: n }, (_, i) => uuid(i, p));
function inList(call: MockCall, column: string): string[] | null {
  const hit = inFilters(call).find(([c]) => c === column);
  return hit ? (hit[1] as string[]) : null;
}
const tags = () =>
  reportError.mock.calls.map((c) => (c as unknown as [Error, { tag: string }])[1].tag);
function svc(client: unknown, role: 'admin' | 'viewer' = 'admin') {
  return new InventoryService(makeServiceContext(client, { role }) as never);
}
function itemRow(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    sku: `S-${id.slice(-4)}`,
    name: id,
    status: 'active',
    item_type: 'product',
    category_id: 'cat-1',
    quantity_on_hand: 1,
    reorder_point: 0,
    unit_cost: 1,
    warehouse_id: 'wh-1',
    updated_at: '2026-09-01T00:00:00Z',
    custom_fields: {},
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  grants.current = null;
  access.current = {
    readableIds: ['wh-1'],
    writableIds: ['wh-1'],
    hasAllAccess: true,
    primaryWarehouseId: 'wh-1',
  };
});

describe('list()', () => {
  it('refuses more than 100 ids, which a paged, counted query cannot split', async () => {
    const stub = makeSupabaseStub();
    await expect(svc(stub.client).list({ ids: ids(101) })).rejects.toMatchObject({
      code: 'validation_error',
    });
    expect(stub.fromCalls).toEqual([]);
  });

  it('keeps a short grant list in the URL and applies a long one to the rows', async () => {
    const rowsFor = () => [
      itemRow(uuid(1), { category_id: uuid(3, 'c') }),
      itemRow(uuid(2), { category_id: 'not-granted' }),
    ];
    // 5 grants: the URL filter, exactly as before.
    grants.current = new Set(ids(5, 'c'));
    const short = makeSupabaseStub({
      'inventory_items.select': { data: rowsFor(), error: null, count: 2 },
    });
    await svc(short.client, 'viewer').list();
    const shortMain = short.chainsAll.get('inventory_items.select')?.[0] ?? [];
    const shortArgs = short.chainArgsAll.get('inventory_items.select')?.[0] ?? [];
    expect(shortMain.map((m, i) => (m === 'in' ? shortArgs[i]?.[0] : null))).toContain(
      'category_id',
    );

    // 150 grants: no category list in the URL; the rows are filtered instead.
    grants.current = new Set(ids(150, 'c'));
    const long = makeSupabaseStub({
      'inventory_items.select': { data: rowsFor(), error: null, count: 2 },
    });
    const out = await svc(long.client, 'viewer').list();
    for (const chain of long.chainArgsAll.get('inventory_items.select') ?? []) {
      expect(chain.some((a) => a[0] === 'category_id' && Array.isArray(a[1]))).toBe(false);
    }
    expect(out.items.map((i) => i.id)).toEqual([uuid(1)]);
  });
});

describe('listByIdsForExport', () => {
  function exportStub(opts: { failBatch?: number; n: number }) {
    let calls = 0;
    const lists: string[][] = [];
    const stub = makeSupabaseStub({
      'inventory_items.select': (call) => {
        calls += 1;
        const list = inList(call, 'id') ?? [];
        lists.push(list);
        if (calls === opts.failBatch) return { data: null, error: { message: 'boom' } };
        return {
          data: list.map((id) =>
            itemRow(id, {
              updated_at: `2026-09-${String((Number(id.slice(-4)) % 28) + 1).padStart(2, '0')}T00:00:00Z`,
            }),
          ),
          error: null,
        };
      },
    });
    return { stub, lists };
  }

  it('reads 250 ids in batches, sorted newest first, with every match counted', async () => {
    const { stub, lists } = exportStub({ n: 250 });
    const out = await svc(stub.client).listByIdsForExport(ids(250));
    expect(lists.map((l) => l.length)).toEqual([100, 100, 50]);
    expect(out.total).toBe(250);
    expect(out.items).toHaveLength(250);
    const stamps = out.items.map((i) => i.updated_at);
    expect([...stamps].sort().reverse()).toEqual(stamps);
  });

  it('caps the rows at 1000 like list() and still counts all 1200', async () => {
    const { stub } = exportStub({ n: 1200 });
    const out = await svc(stub.client).listByIdsForExport(ids(1200));
    expect(out.items).toHaveLength(1000);
    expect(out.total).toBe(1200);
  });

  it('throws when a batch fails, never a short export', async () => {
    const { stub } = exportStub({ n: 250, failBatch: 2 });
    await expect(svc(stub.client).listByIdsForExport(ids(250))).rejects.toMatchObject({
      code: 'internal_error',
    });
  });
});

describe('id-list reads that throw', () => {
  it('byIds reads 250 ids in batches and throws on a failed batch', async () => {
    const lists: string[][] = [];
    const ok = makeSupabaseStub({
      'inventory_items.select': (call) => {
        const list = inList(call, 'id') ?? [];
        lists.push(list);
        return { data: list.map((id) => ({ id, sku: 's', name: 'n' })), error: null };
      },
    });
    expect(await svc(ok.client).byIds(ids(250))).toHaveLength(250);
    expect(lists.map((l) => l.length)).toEqual([100, 100, 50]);

    let n = 0;
    const bad = makeSupabaseStub({
      'inventory_items.select': () => {
        n += 1;
        return n === 3 ? { data: null, error: { message: 'boom' } } : { data: [], error: null };
      },
    });
    await expect(svc(bad.client).byIds(ids(250))).rejects.toMatchObject({ code: 'internal_error' });
  });

  it('reservedQuantityByItemIds batches, pages, sums the last batch, and throws on failure', async () => {
    const lists: string[][] = [];
    const ok = makeSupabaseStub({
      'stock_reservations.select': (call) => {
        const list = inList(call, 'item_id') ?? [];
        lists.push(list);
        // The last item has 1200 open reservations: past one 1000-row page.
        const rows = list.flatMap((item_id) =>
          item_id === uuid(249, 'a')
            ? Array.from({ length: 1200 }, () => ({ item_id, quantity: 1 }))
            : [{ item_id, quantity: 2 }],
        );
        const [from, to] = (callArgs(call, 'range') ?? [0, 999]) as [number, number];
        return { data: rows.slice(from, to + 1), error: null };
      },
    });
    const out = await svc(ok.client).reservedQuantityByItemIds(ids(250));
    expect(lists.slice(0, 3).map((l) => l.length)).toEqual([100, 100, 50]);
    expect(out.get(uuid(249, 'a'))).toBe(1200);
    expect(out.get(uuid(0, 'a'))).toBe(2);

    let n = 0;
    const bad = makeSupabaseStub({
      'stock_reservations.select': () => {
        n += 1;
        return n === 2 ? { data: null, error: { message: 'boom' } } : { data: [], error: null };
      },
    });
    await expect(svc(bad.client).reservedQuantityByItemIds(ids(250))).rejects.toMatchObject({
      code: 'internal_error',
    });
  });

  it('listForMatching and listGroupVariants apply a long grant list to the rows, not the URL', async () => {
    grants.current = new Set(ids(150, 'c'));
    const stub = makeSupabaseStub({
      'inventory_items.select': () => ({
        data: [
          {
            id: 'kept',
            sku: 's',
            name: 'n',
            quantity_on_hand: 1,
            created_at: 'x',
            unit_cost: 1,
            group_id: 'g',
            variant_size: 'M',
            category_id: uuid(1, 'c'),
          },
          {
            id: 'dropped',
            sku: 's',
            name: 'n',
            quantity_on_hand: 1,
            created_at: 'x',
            unit_cost: 1,
            group_id: 'g',
            variant_size: 'L',
            category_id: 'other',
          },
        ],
        error: null,
      }),
    });
    const matching = await svc(stub.client, 'viewer').listForMatching();
    const variants = await svc(stub.client, 'viewer').listGroupVariants(['g']);
    expect(matching.map((r) => r.id)).toEqual(['kept']);
    expect(variants.map((r) => r.id)).toEqual(['kept']);
    expect(variants[0]).not.toHaveProperty('category_id');
    for (const chain of stub.chainArgsAll.get('inventory_items.select') ?? []) {
      expect(chain.some((a) => a[0] === 'category_id' && Array.isArray(a[1]))).toBe(false);
    }
  });
});

describe('opening-stock compensation with 150 items', () => {
  function stubWith(opts: { failLevelsBatch?: number; failVerify?: boolean }) {
    let levelCalls = 0;
    const lists = { items: [] as string[][] };
    const stub = makeSupabaseStub({
      'item_stock_levels.update': () => {
        levelCalls += 1;
        return levelCalls === opts.failLevelsBatch
          ? { data: null, error: { message: 'boom' } }
          : { data: null, error: null };
      },
      'inventory_items.update': (call) => {
        const list = inList(call, 'id') ?? [];
        lists.items.push(list);
        return { data: list.map((id) => ({ id })), error: null };
      },
      'item_stock_levels.select': () =>
        opts.failVerify ? { data: null, error: { message: 'verify' } } : { data: [], error: null },
    });
    return { stub, lists };
  }
  async function compensate(client: unknown): Promise<ServiceError> {
    const s = svc(client) as unknown as {
      compensateOpeningStockOrThrow(
        ids: string[],
        err: { message: string },
        opts: { tag: string; subject: string; pronoun: 'its' | 'their' },
      ): Promise<never>;
    };
    return s
      .compensateOpeningStockOrThrow(
        ids(150),
        { message: 'refused' },
        {
          tag: '[test]',
          subject: 'These items were',
          pronoun: 'their',
        },
      )
      .catch((e: unknown) => e as ServiceError);
  }

  it('rolls back in batches when every batch succeeds', async () => {
    const { stub, lists } = stubWith({});
    const err = await compensate(stub.client);
    expect(lists.items.map((l) => l.length)).toEqual([100, 50]);
    expect(err.internalDetail).toMatch(/stock adjustment/i);
  });

  it('never zeroes on-hand for items whose placements batch failed', async () => {
    const { stub, lists } = stubWith({ failLevelsBatch: 2 });
    const err = await compensate(stub.client);
    expect(lists.items.flat()).toEqual(ids(150).slice(0, 100));
    expect(err.internalDetail).toMatch(/could not be rolled back/i);
  });

  it('reports "could not be rolled back" when the verify read fails', async () => {
    const { stub } = stubWith({ failVerify: true });
    expect((await compensate(stub.client)).internalDetail).toMatch(/could not be rolled back/i);
  });
});

describe('bulkCreate barcode pre-check', () => {
  it('checks 250 barcodes in batches and inserts nothing when a batch fails', async () => {
    let n = 0;
    const lists: string[][] = [];
    const stub = makeSupabaseStub({
      'organizations.select': { data: { plan: 'enterprise' }, error: null },
      'inventory_items.select': (call) => {
        const list = inList(call, 'barcode');
        if (!list) return { data: [], error: null, count: 0 };
        n += 1;
        lists.push(list);
        return n === 2 ? { data: null, error: { message: 'boom' } } : { data: [], error: null };
      },
    });
    const items = Array.from({ length: 250 }, (_, i) => ({
      name: `Item ${i}`,
      barcode: `97800000${String(i).padStart(5, '0')}`,
      itemType: 'product' as const,
      quantityOnHand: 0,
      unitCost: 1,
      retailPrice: 1,
    }));
    await expect(svc(stub.client).bulkCreate({ warehouseId: 'wh-1', items })).rejects.toMatchObject(
      { code: 'internal_error' },
    );
    expect(lists[0]?.length).toBe(100);
    expect(stub.chainsAll.get('inventory_items.insert')).toBeUndefined();
  });
});

describe('bulkUpdate with 250 items', () => {
  function bulkStub(opts: {
    failUpdateBatch?: number;
    failBeforeValues?: boolean;
    failOldLabels?: boolean;
  }) {
    let updates = 0;
    const updateLists: string[][] = [];
    const stub = makeSupabaseStub({
      'inventory_items.select': (call) => {
        const list = inList(call, 'id') ?? [];
        const cols = String(callArgs(call, 'select')?.[0] ?? '');
        if (cols.includes('status') && opts.failBeforeValues) {
          return { data: null, error: { message: 'before' } };
        }
        if (cols.includes('bin_location') && opts.failOldLabels) {
          return { data: null, error: { message: 'labels' } };
        }
        return {
          data: list.map((id) => ({
            id,
            warehouse_id: 'wh-1',
            status: 'active',
            bin_location: null,
          })),
          error: null,
        };
      },
      // No holdings: the archive stock guard passes.
      'item_stock_levels.select': { data: [], error: null },
      'inventory_items.update': (call) => {
        updates += 1;
        updateLists.push(inList(call, 'id') ?? []);
        return updates === opts.failUpdateBatch
          ? { data: null, error: { message: 'boom' } }
          : { data: null, error: null };
      },
      'rpc:inventory_set_rack': { data: 250, error: null },
    });
    return { stub, updateLists };
  }

  it('writes in batches and, when batch 2 fails, audits and returns the committed part', async () => {
    const { stub, updateLists } = bulkStub({ failUpdateBatch: 2 });
    const res = await svc(stub.client).bulkUpdate({
      ids: ids(250),
      op: { kind: 'archive' },
    } as never);
    expect(updateLists.map((l) => l.length)).toEqual([100, 100]);
    expect(res).toMatchObject({ ok: 100, failed: 150 });
    expect(audit).toHaveBeenCalledTimes(100);
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(tags()).toContain('inventory.bulk_update.partial');
  });

  it('writes nothing when the before-values read fails', async () => {
    const { stub } = bulkStub({ failBeforeValues: true });
    await expect(
      svc(stub.client).bulkUpdate({ ids: ids(250), op: { kind: 'archive' } } as never),
    ).rejects.toMatchObject({ code: 'internal_error' });
    expect(stub.chainsAll.get('inventory_items.update')).toBeUndefined();
  });

  it('set_rack stops before the RPC when the old-label read fails', async () => {
    const { stub } = bulkStub({ failOldLabels: true });
    await expect(
      svc(stub.client).bulkUpdate({
        ids: ids(250),
        op: { kind: 'set_rack', rackNumber: '12', rackRow: 'B' },
      } as never),
    ).rejects.toMatchObject({ code: 'internal_error' });
    expect(stub.rpcCalls.find((c) => c.name === 'inventory_set_rack')).toBeUndefined();
  });
});

describe('stagedWorklist sources', () => {
  it('degrades per batch and never sends a non-uuid note as a receipt id', async () => {
    const levels = Array.from({ length: 250 }, (_, i) => ({
      id: `lvl-${i}`,
      item_id: uuid(i, 'a'),
      location_id: 'stg',
      quantity: 1,
      locations: { id: 'stg', kind: 'staging', warehouse_id: 'wh-1' },
      inventory_items: {
        id: uuid(i, 'a'),
        name: 'n',
        sku: 's',
        item_type: 'product',
        deleted_at: null,
      },
    }));
    let movementCalls = 0;
    const receiptLists: string[][] = [];
    const stub = makeSupabaseStub({
      'item_stock_levels.select': { data: levels, error: null },
      'stock_movements.select': (call) => {
        movementCalls += 1;
        if (movementCalls === 2) return { data: null, error: { message: 'boom' } };
        const list = inList(call, 'item_id') ?? [];
        return {
          data: list.map((item_id, i) => ({
            item_id,
            created_at: '2026-09-01T00:00:00Z',
            // One free-text note that is not a receipt id.
            notes: i === 0 ? 'moved by hand' : uuid(Number(item_id.slice(-12)), 'd'),
            movement_type: 'receive_po',
          })),
          error: null,
        };
      },
      'receipts.select': (call) => {
        const list = inList(call, 'id') ?? [];
        receiptLists.push(list);
        return {
          data: list.map((id) => ({
            id,
            receipt_number: 'R',
            received_at: '2026-09-01T00:00:00Z',
            status: 'posted',
            purchase_orders: { po_number: 'PO-1' },
          })),
          error: null,
        };
      },
    });
    const rows = await svc(stub.client).stagedWorklist();
    expect(rows).toHaveLength(250);
    // Batch 2 (items 100..199) failed on its own: its rows lose the source, the others keep it.
    expect(rows.find((r) => r.itemId === uuid(150, 'a'))?.sourcePoNumber).toBeNull();
    expect(rows.find((r) => r.itemId === uuid(249, 'a'))?.sourcePoNumber).toBe('PO-1');
    expect(receiptLists.flat()).not.toContain('moved by hand');
    expect(receiptLists.every((l) => l.length <= 100)).toBe(true);
    expect(tags()).toContain('inventory.staged_worklist.source_movements');
  });
});

describe('itemMovementHistory label lookups', () => {
  it('resolves 300 location names in batches and degrades a failed lookup with a report', async () => {
    const movements = Array.from({ length: 150 }, (_, i) => ({
      id: uuid(i, 'm'),
      movement_type: 'transfer',
      quantity_change: 0,
      previous_quantity: 1,
      new_quantity: 1,
      moved_quantity: 1,
      from_location_id: uuid(i, 'f'),
      to_location_id: uuid(i, 'e'),
      reason: null,
      notes: null,
      created_at: '2026-09-01T00:00:00Z',
      user_id: null,
      actor: null,
    }));
    const locLists: string[][] = [];
    const stub = makeSupabaseStub({
      'inventory_items.select': {
        data: { id: 'item-1', name: 'n', sku: 's', warehouse_id: 'wh-1', deleted_at: null },
        error: null,
      },
      'stock_movements.select': (call) => {
        const [from, to] = (callArgs(call, 'range') ?? [0, 999]) as [number, number];
        return { data: movements.slice(from, to + 1), error: null, count: 150 };
      },
      'locations.select': (call) => {
        const list = inList(call, 'id') ?? [];
        locLists.push(list);
        if (locLists.length === 3) return { data: null, error: { message: 'boom' } };
        return { data: list.map((id) => ({ id, name: `L-${id.slice(0, 1)}` })), error: null };
      },
    });
    const page = await svc(stub.client).itemMovementHistory({ itemId: 'item-1', limit: 150 });
    expect(locLists.map((l) => l.length)).toEqual([100, 100, 100]);
    // Every movement still renders; the failed third batch only costs its names.
    expect(page.rows).toHaveLength(150);
    const byId = new Map(page.rows.map((r) => [r.id, r]));
    expect(byId.get(uuid(0, 'm'))?.fromLocationName).toBe('L-f');
    expect(byId.get(uuid(149, 'm'))?.fromLocationName).toBeNull();
    expect(tags()).toEqual(['inventory.item_history.locations']);
  });
});
