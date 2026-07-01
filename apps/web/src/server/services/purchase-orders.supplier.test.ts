/**
 * Tests for the supplier_id org-verification guard in PurchaseOrdersService.
 * create() and update() must throw validation_error before any insert/update
 * when a supplierId from a foreign org is supplied.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

const WH_UUID = 'aaaaaaaa-0000-0000-0000-000000000001' as const;

vi.mock('@/lib/auth/warehouse', () => ({
  getWarehouseAccess: vi.fn(async () => ({
    readableIds: [WH_UUID],
    writableIds: [WH_UUID],
    hasAllAccess: true,
    primaryWarehouseId: WH_UUID,
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

vi.mock('./audit', () => ({ audit: vi.fn(async () => {}) }));
vi.mock('./integration-events', () => ({ dispatchEvent: vi.fn(async () => {}) }));

vi.mock('./item-images', () => ({
  ItemImagesService: class {
    async primaryImagesForItems() {
      return new Map<string, string>();
    }
    async primaryImagesWithThumbsForItems() {
      return new Map();
    }
  },
}));

vi.mock('./inventory', () => ({
  InventoryService: class {
    create = vi.fn(async () => ({ id: 'new-item-uuid' }));
  },
}));

vi.mock('./notifications', () => ({
  createNotification: vi.fn(async () => 'notif-id'),
}));

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          in: () => ({
            not: () => ({
              is: () => Promise.resolve({ data: [], error: null }),
            }),
          }),
        }),
      }),
    }),
  }),
}));

import { ServiceError } from './context';
import { PurchaseOrdersService } from './purchase-orders';

const MINIMAL_LINE = [{ itemId: 'item-uuid-1', quantityOrdered: 2, unitCost: 10 }];
const SUPPLIER_UUID = 'eeeeeeee-0000-0000-0000-000000000001' as const;

const PO_ID = 'po-edit-id';
const DRAFT_PO = {
  id: PO_ID,
  po_number: 'PO-001',
  status: 'draft',
  total: 20,
  subtotal: 20,
  supplier_id: null,
  destination_location_id: null,
  expected_at: null,
  notes: null,
  destination: null,
};

beforeEach(() => {
  vi.clearAllMocks();
});

// ── create() ──────────────────────────────────────────────────────────────────

describe('PurchaseOrdersService.create — supplier org-verification', () => {
  it('rejects a foreign-org supplierId and does NOT insert the PO', async () => {
    const stub = makeSupabaseStub({
      // suppliers lookup returns null → not in this org
      'suppliers.select': { data: null, error: null },
      'purchase_orders.insert': { data: [{ id: 'po-new' }], error: null },
      'purchase_order_items.insert': { data: null, error: null },
      'rpc:next_po_number': { data: 'PO-AUTO-1', error: null },
    });
    const svc = new PurchaseOrdersService(makeServiceContext(stub.client) as never);

    const thrown = await svc
      .create({ lines: MINIMAL_LINE, supplierId: SUPPLIER_UUID })
      .catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(ServiceError);
    expect((thrown as ServiceError).code).toBe('validation_error');
    expect((thrown as ServiceError).message).toMatch(/supplier/i);
    // No PO row and no lines were inserted — guard fired first.
    expect(stub.chainsAll.get('purchase_orders.insert')).toBeUndefined();
    expect(stub.chainsAll.get('purchase_order_items.insert')).toBeUndefined();
  });

  it('proceeds when supplierId belongs to the caller\'s org', async () => {
    const stub = makeSupabaseStub({
      // suppliers lookup finds the row → in this org
      'suppliers.select': { data: { id: SUPPLIER_UUID }, error: null },
      'purchase_orders.insert': { data: [{ id: 'po-new' }], error: null },
      'purchase_order_items.insert': { data: null, error: null },
      'rpc:next_po_number': { data: 'PO-AUTO-2', error: null },
    });
    const svc = new PurchaseOrdersService(makeServiceContext(stub.client) as never);

    const result = await svc.create({ lines: MINIMAL_LINE, supplierId: SUPPLIER_UUID });

    expect(result.poNumber).toBe('PO-AUTO-2');
    // PO and lines were written.
    expect(stub.chainsAll.get('purchase_orders.insert')).toBeDefined();
    expect(stub.chainsAll.get('purchase_order_items.insert')).toBeDefined();
    // The suppliers lookup was org-scoped.
    const supplierArgs = (stub.chainArgsAll.get('suppliers.select') ?? []).flat(Infinity);
    expect(supplierArgs).toContain('organization_id');
    expect(supplierArgs).toContain('org-test');
  });

  it('skips the suppliers lookup entirely when supplierId is null', async () => {
    const stub = makeSupabaseStub({
      'purchase_orders.insert': { data: [{ id: 'po-new' }], error: null },
      'purchase_order_items.insert': { data: null, error: null },
      'rpc:next_po_number': { data: 'PO-AUTO-3', error: null },
    });
    const svc = new PurchaseOrdersService(makeServiceContext(stub.client) as never);

    const result = await svc.create({ lines: MINIMAL_LINE, supplierId: null });

    expect(result.poNumber).toBe('PO-AUTO-3');
    // No supplier lookup at all.
    expect(stub.fromCalls).not.toContain('suppliers');
    // PO inserted successfully.
    expect(stub.chainsAll.get('purchase_orders.insert')).toBeDefined();
  });

  it('skips the suppliers lookup when supplierId is omitted', async () => {
    const stub = makeSupabaseStub({
      'purchase_orders.insert': { data: [{ id: 'po-new' }], error: null },
      'purchase_order_items.insert': { data: null, error: null },
      'rpc:next_po_number': { data: 'PO-AUTO-4', error: null },
    });
    const svc = new PurchaseOrdersService(makeServiceContext(stub.client) as never);

    const result = await svc.create({ lines: MINIMAL_LINE });

    expect(result.poNumber).toBe('PO-AUTO-4');
    expect(stub.fromCalls).not.toContain('suppliers');
  });
});

// ── update() ──────────────────────────────────────────────────────────────────

describe('PurchaseOrdersService.update — supplier org-verification', () => {
  it('rejects a foreign-org supplierId and does NOT write the header or lines', async () => {
    const stub = makeSupabaseStub({
      'purchase_orders.select': { data: DRAFT_PO, error: null },
      'purchase_order_items.select': {
        data: [{ id: 'l-1', item_id: 'item-uuid-1', quantity_ordered: 2, unit_cost: 10, quantity_received: 0, line_total: 20 }],
        error: null,
      },
      // suppliers lookup returns null → foreign org
      'suppliers.select': { data: null, error: null },
      'purchase_order_items.delete': { data: null, error: null },
      'purchase_order_items.insert': { data: null, error: null },
      'purchase_orders.update': { data: { id: PO_ID }, error: null },
    });
    const svc = new PurchaseOrdersService(makeServiceContext(stub.client) as never);

    const thrown = await svc
      .update(PO_ID, { lines: MINIMAL_LINE, supplierId: SUPPLIER_UUID })
      .catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(ServiceError);
    expect((thrown as ServiceError).code).toBe('validation_error');
    expect((thrown as ServiceError).message).toMatch(/supplier/i);
    // No destructive writes occurred.
    expect(stub.chainsAll.get('purchase_order_items.delete')).toBeUndefined();
    expect(stub.chainsAll.get('purchase_order_items.insert')).toBeUndefined();
    expect(stub.chainsAll.get('purchase_orders.update')).toBeUndefined();
  });

  it('proceeds when supplierId belongs to the caller\'s org', async () => {
    const stub = makeSupabaseStub({
      'purchase_orders.select': { data: DRAFT_PO, error: null },
      'purchase_order_items.select': {
        data: [{ id: 'l-1', item_id: 'item-uuid-1', quantity_ordered: 2, unit_cost: 10, quantity_received: 0, line_total: 20 }],
        error: null,
      },
      // suppliers lookup finds the row → same org
      'suppliers.select': { data: { id: SUPPLIER_UUID }, error: null },
      'purchase_order_items.delete': { data: null, error: null },
      'purchase_order_items.insert': { data: null, error: null },
      'purchase_orders.update': { data: { id: PO_ID }, error: null },
    });
    const svc = new PurchaseOrdersService(makeServiceContext(stub.client) as never);

    const result = await svc.update(PO_ID, { lines: MINIMAL_LINE, supplierId: SUPPLIER_UUID });

    expect(result.id).toBe(PO_ID);
    // Lines were replaced and header was updated.
    expect(stub.chainsAll.get('purchase_order_items.delete')).toBeDefined();
    expect(stub.chainsAll.get('purchase_orders.update')).toBeDefined();
  });

  it('skips the suppliers lookup when supplierId is null on update', async () => {
    const stub = makeSupabaseStub({
      'purchase_orders.select': { data: DRAFT_PO, error: null },
      'purchase_order_items.select': {
        data: [{ id: 'l-1', item_id: 'item-uuid-1', quantity_ordered: 2, unit_cost: 10, quantity_received: 0, line_total: 20 }],
        error: null,
      },
      'purchase_order_items.delete': { data: null, error: null },
      'purchase_order_items.insert': { data: null, error: null },
      'purchase_orders.update': { data: { id: PO_ID }, error: null },
    });
    const svc = new PurchaseOrdersService(makeServiceContext(stub.client) as never);

    const result = await svc.update(PO_ID, { lines: MINIMAL_LINE, supplierId: null });

    expect(result.id).toBe(PO_ID);
    expect(stub.fromCalls).not.toContain('suppliers');
  });
});
