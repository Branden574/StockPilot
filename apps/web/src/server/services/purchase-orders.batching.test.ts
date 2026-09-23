import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Purchase orders batch their id lists.
 *
 * A PO's custom lines, a cancelled PO's auto-created items and a
 * drafts-from-selection run have no cap. One `.in()` past ~215 uuids answers
 * 414 locally and fails as "fetch failed" in production after ~7 s of
 * retries. The cancel-time keep-check decides what gets archived: it pages
 * (a truncated read archived items a live PO still needed) and a failed batch
 * archives nothing.
 */

const { invCreate, reportError, invalidate } = vi.hoisted(() => ({
  invCreate: vi.fn(),
  reportError: vi.fn(async () => undefined),
  invalidate: vi.fn(),
}));

vi.mock('@/lib/auth/warehouse', () => ({
  getWarehouseAccess: vi.fn(async () => ({
    readableIds: ['aaaaaaaa-0000-4000-8000-000000000001'],
    writableIds: ['aaaaaaaa-0000-4000-8000-000000000001'],
    hasAllAccess: true,
    primaryWarehouseId: 'aaaaaaaa-0000-4000-8000-000000000001',
  })),
  assertWarehouseAccess: vi.fn(),
  forcedWarehouseId: vi.fn(async () => null),
  ForbiddenError: class ForbiddenError extends Error {
    readonly code = 'forbidden' as const;
  },
}));
vi.mock('./audit', () => ({ audit: vi.fn(async () => {}) }));
vi.mock('./integration-events', () => ({ dispatchEvent: vi.fn(async () => undefined) }));
vi.mock('@/lib/error-reporter', () => ({ reportError }));
vi.mock('./lib/inventory-list-cache', () => ({ invalidateInventoryListAfterWrite: invalidate }));
vi.mock('./item-images', () => ({
  ItemImagesService: class {
    async primaryImagesWithThumbsForItems() {
      return new Map();
    }
  },
}));
vi.mock('./inventory', () => ({
  InventoryService: class {
    create = invCreate;
  },
}));

import {
  inFilters,
  makeServiceContext,
  makeSupabaseStub,
  type MockCall,
} from '@/test/supabase-mock';

import { audit } from './audit';
import { PurchaseOrdersService } from './purchase-orders';

const uuid = (i: number, p = '0') => `${p.repeat(8)}-0000-4000-8000-${String(i).padStart(12, '0')}`;

function inList(call: MockCall, column: string): string[] {
  return (inFilters(call).find(([c]) => c === column)?.[1] ?? []) as string[];
}
function tagsReported(): string[] {
  return reportError.mock.calls.map((c) => (c as unknown as [Error, { tag: string }])[1].tag);
}
const archivedAudits = () =>
  vi
    .mocked(audit)
    .mock.calls.map((c) => c[0] as { event?: string; entityId?: string })
    .filter((a) => a.event === 'inventory.item.archived');

beforeEach(() => {
  vi.clearAllMocks();
  let n = 0;
  invCreate.mockImplementation(async () => ({ id: uuid(n++, 'c') }));
});

describe('create() stamps 150 custom items in batches', () => {
  const lines = Array.from({ length: 150 }, (_, i) => ({
    newItemName: `Custom ${i}`,
    quantityOrdered: 1,
    unitCost: 1,
  }));

  function stubWith(update: (call: MockCall) => { data: unknown; error: unknown }) {
    return makeSupabaseStub({
      'purchase_orders.insert': { data: [{ id: 'po-new' }], error: null },
      'purchase_order_items.insert': { data: null, error: null },
      'inventory_items.update': update as never,
      'rpc:next_po_number': { data: 'PO-1', error: null },
    });
  }

  it('stamps every custom item, at most 100 per write', async () => {
    const lists: string[][] = [];
    const stub = stubWith((call) => {
      lists.push(inList(call, 'id'));
      return { data: null, error: null };
    });
    await new PurchaseOrdersService(makeServiceContext(stub.client) as never).create({ lines });
    expect(lists.map((l) => l.length)).toEqual([100, 50]);
    expect(tagsReported()).not.toContain('po.create.stamp_custom_items');
  });

  it('reports a stamp batch that fails without failing the PO', async () => {
    let n = 0;
    const stub = stubWith(() => {
      n += 1;
      return n === 2 ? { data: null, error: { message: 'boom' } } : { data: null, error: null };
    });
    const po = await new PurchaseOrdersService(makeServiceContext(stub.client) as never).create({
      lines,
    });
    expect(po).toBeTruthy();
    const call = reportError.mock.calls.find(
      (c) => (c as unknown as [Error, { tag: string }])[1].tag === 'po.create.stamp_custom_items',
    ) as unknown as [Error, { extra: Record<string, unknown> }];
    expect(call[1].extra).toMatchObject({ stamped: 100, unstamped: 50 });
  });
});

describe('cancel archives 250 orphaned custom items in batches', () => {
  const candidates = Array.from({ length: 250 }, (_, i) => ({ id: uuid(i), name: `Item ${i}` }));
  const received = uuid(245); // in the keep-check's third batch

  function cancelStub(opts: {
    keep?: (call: MockCall, n: number) => { data: unknown; error: unknown };
    update?: (call: MockCall, n: number) => { data: unknown; error: unknown };
  }) {
    let poItemsReads = 0;
    let updates = 0;
    const keepLists: string[][] = [];
    const updateLists: string[][] = [];
    const stub = makeSupabaseStub({
      'purchase_orders.select': {
        data: { id: 'po-1', po_number: 'PO-1', status: 'ordered', total: 10, destination: null },
        error: null,
      },
      'purchase_order_items.select': (call) => {
        poItemsReads += 1;
        if (poItemsReads === 1) return { data: [], error: null }; // get()'s lines
        const list = inList(call, 'item_id');
        keepLists.push(list);
        if (opts.keep) return opts.keep(call, keepLists.length) as never;
        return {
          data: list
            .filter((id) => id === received)
            .map((item_id) => ({ item_id, quantity_received: 3, po: { status: 'received' } })),
          error: null,
        };
      },
      'purchase_orders.update': { data: { id: 'po-1' }, error: null },
      'inventory_items.select': { data: candidates, error: null },
      'inventory_items.update': (call) => {
        updates += 1;
        const list = inList(call, 'id');
        updateLists.push(list);
        if (opts.update) return opts.update(call, updates) as never;
        return { data: list.map((id) => ({ id, name: 'x' })), error: null };
      },
    });
    return { stub, keepLists, updateLists };
  }

  it('reads the keep-check and archives in batches of at most 100, keeping a received item from the last batch', async () => {
    const { stub, keepLists, updateLists } = cancelStub({});
    await new PurchaseOrdersService(makeServiceContext(stub.client) as never).updateStatus(
      'po-1',
      'cancelled',
    );
    expect(keepLists.map((l) => l.length)).toEqual([100, 100, 50]);
    expect(updateLists.map((l) => l.length)).toEqual([100, 100, 49]);
    expect(updateLists.flat()).not.toContain(received);
    expect(archivedAudits()).toHaveLength(249);
  });

  it('archives NOTHING when a keep-check batch fails', async () => {
    const { stub } = cancelStub({
      keep: (_call, n) =>
        n === 3
          ? { data: null, error: { message: 'statement timeout' } }
          : { data: [], error: null },
    });
    await new PurchaseOrdersService(makeServiceContext(stub.client) as never).updateStatus(
      'po-1',
      'cancelled',
    );
    expect(stub.chainsAll.get('inventory_items.update')).toBeUndefined();
    expect(tagsReported()).toContain('po.cancel.archive_custom_items.keep_check');
  });

  it('audits and invalidates the archived part when a later archive batch fails', async () => {
    const { stub } = cancelStub({
      update: (call, n) =>
        n === 2
          ? { data: null, error: { message: 'boom' } }
          : { data: inList(call, 'id').map((id) => ({ id, name: 'x' })), error: null },
    });
    await new PurchaseOrdersService(makeServiceContext(stub.client) as never).updateStatus(
      'po-1',
      'cancelled',
    );
    expect(archivedAudits()).toHaveLength(100);
    expect(invalidate).toHaveBeenCalledWith('org-test', 'po.cancel.archive_custom_items');
    expect(tagsReported()).toContain('po.cancel.archive_custom_items');
  });
});

describe('createDraftsFromItems and supplier names', () => {
  it('reads a 250-item selection in batches of at most 100', async () => {
    const lists: string[][] = [];
    const stub = makeSupabaseStub({
      'inventory_items.select': (call) => {
        const list = inList(call, 'id');
        lists.push(list);
        return {
          data: list.map((id) => ({
            id,
            supplier_id: null,
            reorder_quantity: 1,
            reorder_point: 0,
            quantity_on_hand: 0,
            unit_cost: 1,
          })),
          error: null,
        };
      },
    });
    const ids = Array.from({ length: 250 }, (_, i) => uuid(i));
    // Every item lacks a supplier, so the run stops right after the read.
    await expect(
      new PurchaseOrdersService(makeServiceContext(stub.client) as never).createDraftsFromItems(
        ids,
      ),
    ).rejects.toMatchObject({ code: 'validation_error' });
    expect(lists.map((l) => l.length)).toEqual([100, 100, 50]);
  });

  it('throws internal_error when a selection batch fails', async () => {
    let n = 0;
    const stub = makeSupabaseStub({
      'inventory_items.select': () => {
        n += 1;
        return n === 2 ? { data: null, error: { message: 'boom' } } : { data: [], error: null };
      },
    });
    const ids = Array.from({ length: 250 }, (_, i) => uuid(i));
    await expect(
      new PurchaseOrdersService(makeServiceContext(stub.client) as never).createDraftsFromItems(
        ids,
      ),
    ).rejects.toMatchObject({ code: 'internal_error' });
  });

  it('resolves 150 supplier names in batches, and degrades to blank names with a report on failure', async () => {
    const supplierIds = Array.from({ length: 150 }, (_, i) => uuid(i, 's'));
    const lists: string[][] = [];
    const ok = makeSupabaseStub({
      'suppliers.select': (call) => {
        const list = inList(call, 'id');
        lists.push(list);
        return { data: list.map((id) => ({ id, name: `Supplier ${id.slice(-3)}` })), error: null };
      },
    });
    type WithNames = { supplierNames(ids: string[], tag: string): Promise<Map<string, string>> };
    const names = await (
      new PurchaseOrdersService(makeServiceContext(ok.client) as never) as unknown as WithNames
    ).supplierNames(supplierIds, 'po.test');
    expect(lists.map((l) => l.length)).toEqual([100, 50]);
    expect(names.size).toBe(150);

    const bad = makeSupabaseStub({ 'suppliers.select': { data: null, error: { message: 'x' } } });
    const none = await (
      new PurchaseOrdersService(makeServiceContext(bad.client) as never) as unknown as WithNames
    ).supplierNames(supplierIds, 'po.test');
    expect(none.size).toBe(0);
    expect(tagsReported()).toContain('po.test');
  });
});
