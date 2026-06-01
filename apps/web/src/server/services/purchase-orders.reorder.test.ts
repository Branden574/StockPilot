import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

// Full warehouse access by default — these tests focus on supplier
// grouping + quantity math, not warehouse scoping.
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

vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({
    userId: 'user-test',
    organizationId: 'org-test',
    role: 'admin',
  })),
}));

// Audit is fire-and-forget; stub it so it doesn't reach for a real client.
vi.mock('./audit', () => ({ audit: vi.fn(async () => {}) }));

// ItemImagesService is imported by the module but unused on this path.
vi.mock('./item-images', () => ({
  ItemImagesService: class {
    async primaryImagesForItems() {
      return new Map<string, string>();
    }
  },
}));

import { PurchaseOrdersService } from './purchase-orders';

beforeEach(() => {
  vi.clearAllMocks();
});

/**
 * Build a stub whose inventory read returns `items`, whose suppliers read
 * returns `suppliers`, and where each purchase_orders.insert returns a
 * fresh, incrementing PO id so per-supplier drafts are distinguishable.
 */
function stubFor(
  items: Array<{
    id: string;
    supplier_id: string | null;
    reorder_point: number | null;
    reorder_quantity: number | null;
    quantity_on_hand: number | null;
    unit_cost: number | null;
  }>,
  suppliers: Array<{ id: string; name: string }>,
) {
  let poSeq = 0;
  return makeSupabaseStub({
    'inventory_items.select': { data: items, error: null },
    'suppliers.select': { data: suppliers, error: null },
    'purchase_orders.insert': () => {
      poSeq += 1;
      return { data: [{ id: `po-${poSeq}` }], error: null };
    },
    'purchase_order_items.insert': { data: null, error: null },
    'locations.select': { data: null, error: null },
    'rpc:next_po_number': () => ({ data: `PO-${poSeq + 1}`, error: null }),
  });
}

describe('PurchaseOrdersService.createDraftsFromReorderForecast', () => {
  it('groups below-par items by supplier into one draft PO each with deficit-prefilled quantities', async () => {
    // Supplier A: two below-par items. Supplier B: one. plus one healthy
    // item (on hand above reorder point) that must be ignored.
    const stub = stubFor(
      [
        // Supplier A — item 1: target = max(reorderQty 5, reorderPoint 10) = 10, on hand 2 => deficit 8
        {
          id: 'item-1',
          supplier_id: 'sup-a',
          reorder_point: 10,
          reorder_quantity: 5,
          quantity_on_hand: 2,
          unit_cost: 3,
        },
        // Supplier A — item 2: target = max(reorderQty 20, reorderPoint 8) = 20, on hand 0 => deficit 20
        {
          id: 'item-2',
          supplier_id: 'sup-a',
          reorder_point: 8,
          reorder_quantity: 20,
          quantity_on_hand: 0,
          unit_cost: 1.5,
        },
        // Supplier B — item 3: target = max(reorderQty 0, reorderPoint 6) = 6, on hand 6 => at par, deficit 0 -> still reorder up by reorder point? on hand == reorder point counts as below-par
        {
          id: 'item-3',
          supplier_id: 'sup-b',
          reorder_point: 6,
          reorder_quantity: 0,
          quantity_on_hand: 1,
          unit_cost: 4,
        },
        // Healthy item — on hand (50) above reorder point (10): excluded
        {
          id: 'item-4',
          supplier_id: 'sup-a',
          reorder_point: 10,
          reorder_quantity: 5,
          quantity_on_hand: 50,
          unit_cost: 2,
        },
      ],
      [
        { id: 'sup-a', name: 'Supplier A' },
        { id: 'sup-b', name: 'Supplier B' },
      ],
    );
    const svc = new PurchaseOrdersService(makeServiceContext(stub.client));

    const result = await svc.createDraftsFromReorderForecast();

    // Two suppliers => two draft POs, no unassigned.
    expect(result.supplierCount).toBe(2);
    expect(result.createdPoIds).toHaveLength(2);
    expect(result.skipped).toBe(0);
    expect(result.supplierFailures).toHaveLength(0);

    // Inspect the line payloads inserted into purchase_order_items.
    const insertArgs = stub.chainArgsAll.get('purchase_order_items.insert') ?? [];
    // Flatten: each insert call's first arg is the rows array.
    const allLines = insertArgs.flatMap((argsList) => {
      const rows = argsList[0]?.[0] as Array<{
        item_id: string;
        quantity_ordered: number;
        unit_cost: number;
      }>;
      return rows ?? [];
    });

    const byItem = new Map(allLines.map((l) => [l.item_id, l]));
    // item-4 (healthy) must NOT be ordered.
    expect(byItem.has('item-4')).toBe(false);
    // Deficit math.
    expect(byItem.get('item-1')?.quantity_ordered).toBe(8);
    expect(byItem.get('item-2')?.quantity_ordered).toBe(20);
    expect(byItem.get('item-3')?.quantity_ordered).toBe(5); // 6 - 1
    // Unit cost carried through.
    expect(byItem.get('item-1')?.unit_cost).toBe(3);

    // Each created PO is a DRAFT.
    const poInserts = stub.chainArgsAll.get('purchase_orders.insert') ?? [];
    for (const argsList of poInserts) {
      const row = argsList[0]?.[0] as { status: string };
      expect(row.status).toBe('draft');
    }
  });

  it('routes items with no supplier into a single unassigned draft PO', async () => {
    const stub = stubFor(
      [
        {
          id: 'item-x',
          supplier_id: null,
          reorder_point: 10,
          reorder_quantity: 0,
          quantity_on_hand: 3,
          unit_cost: 2,
        },
        {
          id: 'item-y',
          supplier_id: 'sup-a',
          reorder_point: 4,
          reorder_quantity: 0,
          quantity_on_hand: 1,
          unit_cost: 5,
        },
      ],
      [{ id: 'sup-a', name: 'Supplier A' }],
    );
    const svc = new PurchaseOrdersService(makeServiceContext(stub.client));

    const result = await svc.createDraftsFromReorderForecast();

    // One real supplier + one unassigned bucket = 2 drafts.
    expect(result.createdPoIds).toHaveLength(2);
    expect(result.unassignedCount).toBe(1);

    // The unassigned PO should have supplier_id null.
    const poInserts = stub.chainArgsAll.get('purchase_orders.insert') ?? [];
    const supplierIds = poInserts.map(
      (argsList) => (argsList[0]?.[0] as { supplier_id: string | null }).supplier_id,
    );
    expect(supplierIds).toContain(null);
    expect(supplierIds).toContain('sup-a');

    // item-x (deficit 10 - 3 = 7) is on the unassigned PO line.
    const insertArgs = stub.chainArgsAll.get('purchase_order_items.insert') ?? [];
    const allLines = insertArgs.flatMap((argsList) => {
      const rows = argsList[0]?.[0] as Array<{ item_id: string; quantity_ordered: number }>;
      return rows ?? [];
    });
    const xLine = allLines.find((l) => l.item_id === 'item-x');
    expect(xLine?.quantity_ordered).toBe(7);
  });

  it('returns nothing-to-do when no items are below par', async () => {
    const stub = stubFor([], []);
    const svc = new PurchaseOrdersService(makeServiceContext(stub.client));

    const result = await svc.createDraftsFromReorderForecast();

    expect(result.createdPoIds).toHaveLength(0);
    expect(result.supplierCount).toBe(0);
    expect(result.unassignedCount).toBe(0);
  });
});
