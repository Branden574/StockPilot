import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

vi.mock('@/lib/auth/warehouse', () => ({
  getWarehouseAccess: vi.fn(async () => ({
    readableIds: ['wh-a'],
    writableIds: ['wh-a'],
    hasAllAccess: true,
    primaryWarehouseId: 'wh-a',
  })),
  assertWarehouseAccess: vi.fn(),
  forcedWarehouseId: vi.fn(async () => null),
  ForbiddenError: class ForbiddenError extends Error {
    readonly code = 'forbidden' as const;
  },
}));
vi.mock('./audit', () => ({ audit: vi.fn(async () => {}) }));
vi.mock('./integration-events', () => ({ dispatchEvent: vi.fn(async () => undefined) }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => undefined) }));
vi.mock('./item-images', () => ({
  ItemImagesService: class {
    async primaryImagesWithThumbsForItems() {
      return new Map();
    }
  },
}));

import { reportError } from '@/lib/error-reporter';

import { audit } from './audit';
import { PurchaseOrdersService } from './purchase-orders';

/**
 * Cancelling a PO archives the catalog items it auto-created that were never
 * used. "Never used" is decided by ONE read of every PO line referencing them
 * (received history, or a live PO still expecting them). That read's error
 * used to be discarded: a failed read looked like "no lines at all" and
 * archived items with real receipt history or a pending order.
 */

beforeEach(() => vi.clearAllMocks());

function stubFor(keepCheck: { data: unknown; error: { message: string } | null }) {
  let poItemsReads = 0;
  return makeSupabaseStub({
    'purchase_orders.select': {
      data: { id: 'po-1', po_number: 'PO-1', status: 'ordered', total: 10, destination: null },
      error: null,
    },
    // 1st read: get()'s lines; 2nd: the keep-check.
    'purchase_order_items.select': () => {
      poItemsReads += 1;
      return poItemsReads === 1 ? { data: [], error: null } : keepCheck;
    },
    'purchase_orders.update': { data: { id: 'po-1' }, error: null },
    'inventory_items.select': {
      data: [
        { id: 'item-new', name: 'Never used' },
        { id: 'item-received', name: 'Received on another PO' },
      ],
      error: null,
    },
    'inventory_items.update': { data: [{ id: 'item-new', name: 'Never used' }], error: null },
  });
}

const archivedAudits = () =>
  vi
    .mocked(audit)
    .mock.calls.map((c) => c[0] as { event?: string; entityId?: string })
    .filter((a) => a.event === 'inventory.item.archived');

describe('PurchaseOrdersService.updateStatus(cancelled) — orphaned custom items', () => {
  it('archives only the item with no receipt history and no live PO', async () => {
    const stub = stubFor({
      data: [{ item_id: 'item-received', quantity_received: 3, po: { status: 'received' } }],
      error: null,
    });
    const svc = new PurchaseOrdersService(makeServiceContext(stub.client) as never);

    await svc.updateStatus('po-1', 'cancelled');

    const updateArgs = (stub.chainArgsAll.get('inventory_items.update') ?? []).flat(Infinity);
    expect(updateArgs).toContain('item-new');
    expect(updateArgs).not.toContain('item-received');
    expect(archivedAudits().map((a) => a.entityId)).toEqual(['item-new']);
  });

  it('archives NOTHING when the keep-check read fails, and the cancel still lands', async () => {
    const stub = stubFor({
      data: null,
      error: { message: 'canceling statement due to statement timeout' },
    });
    const svc = new PurchaseOrdersService(makeServiceContext(stub.client) as never);

    await svc.updateStatus('po-1', 'cancelled');

    // The status change itself committed before the cleanup ran.
    expect(stub.chainsAll.get('purchase_orders.update')).toBeDefined();
    // Before the fix both items were archived here, including the one with
    // three units of receipt history.
    expect(stub.chainsAll.get('inventory_items.update')).toBeUndefined();
    expect(archivedAudits()).toEqual([]);
    expect(vi.mocked(reportError)).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'canceling statement due to statement timeout' }),
      expect.objectContaining({ tag: 'po.cancel.archive_custom_items.keep_check' }),
    );
  });
});
