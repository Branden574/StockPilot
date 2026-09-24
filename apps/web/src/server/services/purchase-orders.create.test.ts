import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

// Use vi.hoisted() so these values are available inside vi.mock() factory callbacks,
// which Vitest hoists before all other statements.
const { WH_UUID, mockInvCreate: _mockInvCreate } = vi.hoisted(() => ({
  WH_UUID: 'aaaaaaaa-0000-0000-0000-000000000001' as const,
  mockInvCreate: vi.fn(async () => ({ id: 'new-item-uuid' })),
}));

// Full warehouse access — these tests cover create() PO number logic,
// not warehouse scoping.
// Uses a proper UUID for the warehouse so createItemSchema.parse() accepts warehouseId.
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

// Audit is fire-and-forget; stub it so it doesn't reach for a real client.
vi.mock('./audit', () => ({ audit: vi.fn(async () => {}) }));

// Integration events are best-effort; stub them.
vi.mock('./integration-events', () => ({ dispatchEvent: vi.fn(async () => {}) }));

// ItemImagesService is imported by the module but unused on the create path.
vi.mock('./item-images', () => ({
  ItemImagesService: class {
    async primaryImagesForItems() {
      return new Map<string, string>();
    }
  },
}));

// InventoryService is called by PurchaseOrdersService.create() for custom lines.
// We stub it so we can assert what it received without a real DB.
vi.mock('./inventory', () => ({
  InventoryService: class {
    create = _mockInvCreate;
  },
}));

// Re-export for test use with a readable name.
const mockInvCreate = _mockInvCreate;

import { assertWarehouseAccess, getWarehouseAccess } from '@/lib/auth/warehouse';
import { ServiceError } from './context';
import { createPoSchema, PurchaseOrdersService } from './purchase-orders';

const DEST_LOC_UUID = 'bbbbbbbb-0000-0000-0000-000000000001' as const;

beforeEach(() => {
  vi.clearAllMocks();
  // Reset the InventoryService.create stub to its default success response.
  mockInvCreate.mockResolvedValue({ id: 'new-item-uuid' });
  // Reset warehouse access to the full-access default.
  vi.mocked(getWarehouseAccess).mockResolvedValue({
    readableIds: [WH_UUID],
    writableIds: [WH_UUID],
    hasAllAccess: true,
    primaryWarehouseId: WH_UUID,
  });
});

const MINIMAL_LINE = [{ itemId: 'item-uuid-1', quantityOrdered: 2, unitCost: 10 }];

/** A successful save_purchase_order_draft (migration 0366) result. */
const SAVED = (id: string, stamped = 0) => ({
  data: { id, stamped, stamp_error: null },
  error: null,
});

type SaveArgs = {
  p_org_id: string;
  p_po_id: string | null;
  p_po_number: string;
  p_supplier_id: string | null;
  p_destination_location_id: string | null;
  p_charter_id: string | null;
  p_expected_at: string | null;
  p_notes: string | null;
  p_lines: Array<{ item_id: string; quantity_ordered: number; unit_cost: number }>;
  p_custom_item_ids: string[];
  p_actor: string;
};

/** The args of the (only) save_purchase_order_draft call. */
function saveArgs(stub: ReturnType<typeof makeSupabaseStub>): SaveArgs | undefined {
  const calls = stub.rpcCalls.filter((c) => c.name === 'save_purchase_order_draft');
  expect(calls.length).toBeLessThanOrEqual(1);
  return calls[0]?.args as SaveArgs | undefined;
}

/** create() never writes the PO tables directly any more: one RPC does it. */
function expectNoDirectPoWrites(stub: ReturnType<typeof makeSupabaseStub>) {
  expect(stub.chainsAll.get('purchase_orders.insert')).toBeUndefined();
  expect(stub.chainsAll.get('purchase_order_items.insert')).toBeUndefined();
  expect(stub.chainsAll.get('inventory_items.update')).toBeUndefined();
}

describe('PurchaseOrdersService.create — PO number handling', () => {
  it('uses the supplied poNumber and does NOT call next_po_number RPC', async () => {
    const stub = makeSupabaseStub({
      'rpc:save_purchase_order_draft': SAVED('po-new'),
      'rpc:next_po_number': { data: 'PO-AUTO-999', error: null },
    });
    const svc = new PurchaseOrdersService(makeServiceContext(stub.client) as never);

    const result = await svc.create({ lines: MINIMAL_LINE, poNumber: 'MY-CUSTOM-PO-42' });

    expect(result.poNumber).toBe('MY-CUSTOM-PO-42');
    // next_po_number must NOT have been called when a custom number is supplied.
    expect(stub.rpcCalls.some((c) => c.name === 'next_po_number')).toBe(false);
    // The one save call must carry the custom po_number, as a create
    // (p_po_id null) in this org, with the caller as the cron-safe actor.
    const args = saveArgs(stub);
    expect(args?.p_po_number).toBe('MY-CUSTOM-PO-42');
    expect(args?.p_po_id).toBeNull();
    expect(args?.p_org_id).toBe('org-test');
    expect(args?.p_actor).toBe('user-test');
    expect(args?.p_lines).toEqual([{ item_id: 'item-uuid-1', quantity_ordered: 2, unit_cost: 10 }]);
    expectNoDirectPoWrites(stub);
  });

  it('auto-generates via next_po_number RPC when poNumber is omitted', async () => {
    const stub = makeSupabaseStub({
      'rpc:save_purchase_order_draft': SAVED('po-new'),
      'rpc:next_po_number': { data: 'PO-007', error: null },
    });
    const svc = new PurchaseOrdersService(makeServiceContext(stub.client) as never);

    const result = await svc.create({ lines: MINIMAL_LINE });

    expect(result.poNumber).toBe('PO-007');
    // RPC must have been called exactly once.
    expect(stub.rpcCalls.filter((c) => c.name === 'next_po_number')).toHaveLength(1);
    expect(saveArgs(stub)?.p_po_number).toBe('PO-007');
  });

  it('duplicate poNumber (23505 constraint violation) throws conflict ServiceError', async () => {
    const stub = makeSupabaseStub({
      // The save's header insert hits the unique index (a concurrent create
      // took the number after the pre-check).
      'rpc:save_purchase_order_draft': {
        data: null,
        error: { code: '23505', message: 'unique constraint "purchase_orders_org_ponumber_active_key"' },
      },
    });
    const svc = new PurchaseOrdersService(makeServiceContext(stub.client) as never);

    const thrown = await svc
      .create({ lines: MINIMAL_LINE, poNumber: 'DUPLICATE-PO' })
      .catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(ServiceError);
    expect((thrown as ServiceError).code).toBe('conflict');
    expect((thrown as ServiceError).message).toBe('That PO number is already in use.');
    // Header and lines are one transaction: nothing was written around it.
    expectNoDirectPoWrites(stub);
  });

  it('pre-checks a supplied duplicate poNumber and rejects BEFORE creating custom items (no orphans)', async () => {
    const stub = makeSupabaseStub({
      // Pre-check SELECT finds an existing PO with this number.
      'purchase_orders.select': { data: [{ id: 'existing-po' }], error: null },
      'rpc:save_purchase_order_draft': SAVED('po-new'),
    });
    const svc = new PurchaseOrdersService(makeServiceContext(stub.client) as never);

    const thrown = await svc
      .create({
        poNumber: 'DUPLICATE-PO',
        lines: [{ newItemName: 'Should Not Be Created', quantityOrdered: 1, unitCost: 5 }],
      })
      .catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(ServiceError);
    expect((thrown as ServiceError).code).toBe('conflict');
    expect((thrown as ServiceError).message).toBe('That PO number is already in use.');
    // Orphan-fix: no custom catalog item was created and no PO row was inserted,
    // because the duplicate was caught BEFORE the item-creation loop.
    expect(mockInvCreate).not.toHaveBeenCalled();
    expect(saveArgs(stub)).toBeUndefined();
  });
});

describe('PurchaseOrdersService.create — custom line items', () => {
  const STUB_PO_ID = 'po-new-id';

  it('creates a catalog item then uses its id for the PO line when newItemName is provided', async () => {
    const stub = makeSupabaseStub({
      'rpc:save_purchase_order_draft': SAVED(STUB_PO_ID),
      'rpc:next_po_number': { data: 'PO-AUTO-1', error: null },
    });
    const svc = new PurchaseOrdersService(makeServiceContext(stub.client) as never);

    const result = await svc.create({
      lines: [{ newItemName: 'Acme Widget', quantityOrdered: 5, unitCost: 12.5 }],
    });

    // InventoryService.create must have been called once with the correct fields.
    expect(mockInvCreate).toHaveBeenCalledTimes(1);
    const invArg = (mockInvCreate.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(invArg.name).toBe('Acme Widget');
    expect(invArg.unitCost).toBe(12.5);
    expect(invArg.itemType).toBe('product');
    expect(invArg.status).toBe('active');
    expect(invArg.quantityOnHand).toBe(0);
    // Warehouse must be org-scoped (from getWarehouseAccess primary, since no
    // destination location was provided).
    expect(invArg.warehouseId).toBe(WH_UUID);
    // PO-born custom items are awaitingFirstReceipt (mig 0277) — hidden
    // as "Expected" until the receive flow clears the flag.
    const invOpts = (mockInvCreate.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    expect(invOpts).toEqual({ awaitingFirstReceipt: true });

    // The saved line must carry the new item's id, not a newItemName, and the
    // item is passed for tagging with its origin PO.
    const args = saveArgs(stub);
    expect(args?.p_lines).toEqual([
      { item_id: 'new-item-uuid', quantity_ordered: 5, unit_cost: 12.5 },
    ]);
    expect(args?.p_custom_item_ids).toEqual(['new-item-uuid']);
    expect(args?.p_org_id).toBe('org-test');

    expect(result.poNumber).toBe('PO-AUTO-1');
  });

  it('handles mixed lines: one existing itemId + one newItemName', async () => {
    const stub = makeSupabaseStub({
      'rpc:save_purchase_order_draft': SAVED(STUB_PO_ID),
      'rpc:next_po_number': { data: 'PO-AUTO-2', error: null },
    });
    const svc = new PurchaseOrdersService(makeServiceContext(stub.client) as never);

    await svc.create({
      lines: [
        { itemId: 'existing-item-uuid', quantityOrdered: 2, unitCost: 20 },
        { newItemName: 'Brand New Thing', quantityOrdered: 3, unitCost: 7.5 },
      ],
    });

    // InventoryService.create called once (only for the custom line).
    expect(mockInvCreate).toHaveBeenCalledTimes(1);
    const invArg = (mockInvCreate.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(invArg.name).toBe('Brand New Thing');

    // Lines payload must have both lines in order, with correct item ids;
    // only the custom one is tagged.
    const args = saveArgs(stub);
    expect(args?.p_lines.map((l) => l.item_id)).toEqual(['existing-item-uuid', 'new-item-uuid']);
    expect(args?.p_custom_item_ids).toEqual(['new-item-uuid']);
  });

  it('tags auto-created custom items with the origin PO inside the save (for cancel-time cleanup)', async () => {
    const stub = makeSupabaseStub({
      'rpc:save_purchase_order_draft': SAVED(STUB_PO_ID, 1),
      'rpc:next_po_number': { data: 'PO-AUTO-9', error: null },
    });
    const svc = new PurchaseOrdersService(makeServiceContext(stub.client) as never);

    await svc.create({ lines: [{ newItemName: 'Stamp Me', quantityOrdered: 1, unitCost: 1 }] });

    // The tag is part of the one save transaction, not a separate request.
    expect(saveArgs(stub)?.p_custom_item_ids).toEqual(['new-item-uuid']);
    expectNoDirectPoWrites(stub);
  });

  it('lineInputSchema refine: rejects a line with BOTH itemId and newItemName', () => {
    const result = createPoSchema.safeParse({
      lines: [
        {
          itemId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          newItemName: 'Conflict',
          quantityOrdered: 1,
          unitCost: 0,
        },
      ],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain('exactly one');
  });

  it('lineInputSchema refine: rejects a line with NEITHER itemId nor newItemName', () => {
    const result = createPoSchema.safeParse({
      lines: [{ quantityOrdered: 1, unitCost: 0 }],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain('exactly one');
  });

  it('throws validation_error when there is no warehouse and the line is custom', async () => {
    // Simulate an org with no warehouses at all.
    vi.mocked(getWarehouseAccess).mockResolvedValue({
      readableIds: [],
      writableIds: [],
      hasAllAccess: true,
      primaryWarehouseId: null,
    });

    const stub = makeSupabaseStub({
      'rpc:save_purchase_order_draft': SAVED(STUB_PO_ID),
      'rpc:next_po_number': { data: 'PO-AUTO-3', error: null },
    });
    const svc = new PurchaseOrdersService(makeServiceContext(stub.client) as never);

    const thrown = await svc
      .create({
        lines: [{ newItemName: 'No Warehouse Item', quantityOrdered: 1, unitCost: 5 }],
      })
      .catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(ServiceError);
    expect((thrown as ServiceError).code).toBe('validation_error');
    expect((thrown as ServiceError).message).toContain('destination location');
    // InventoryService.create must NOT have been called (fail before item creation).
    expect(mockInvCreate).not.toHaveBeenCalled();
  });
});

describe('PurchaseOrdersService.create — destination warehouse guard', () => {
  it('rejects a destination location that has no warehouse_id (un-receivable PO) BEFORE any write', async () => {
    const stub = makeSupabaseStub({
      'locations.select': { data: { warehouse_id: null }, error: null },
      'rpc:save_purchase_order_draft': SAVED('po-new'),
      'rpc:next_po_number': { data: 'PO-X', error: null },
    });
    const svc = new PurchaseOrdersService(makeServiceContext(stub.client) as never);

    const thrown = await svc
      .create({ lines: MINIMAL_LINE, destinationLocationId: DEST_LOC_UUID })
      .catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(ServiceError);
    expect((thrown as ServiceError).code).toBe('validation_error');
    expect((thrown as ServiceError).message).toContain('warehouse');
    // The guard fires before any write — no save at all.
    expect(saveArgs(stub)).toBeUndefined();
    expectNoDirectPoWrites(stub);
  });

  it('rejects a destination location that does not exist', async () => {
    const stub = makeSupabaseStub({
      'locations.select': { data: null, error: null },
      'rpc:next_po_number': { data: 'PO-X', error: null },
    });
    const svc = new PurchaseOrdersService(makeServiceContext(stub.client) as never);

    const thrown = await svc
      .create({ lines: MINIMAL_LINE, destinationLocationId: DEST_LOC_UUID })
      .catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(ServiceError);
    expect((thrown as ServiceError).code).toBe('validation_error');
    expect((thrown as ServiceError).message).toContain('not found');
  });

  it('accepts a warehouse-backed destination and enforces write access', async () => {
    const stub = makeSupabaseStub({
      'locations.select': { data: { warehouse_id: WH_UUID }, error: null },
      'rpc:save_purchase_order_draft': SAVED('po-new'),
      'rpc:next_po_number': { data: 'PO-Y', error: null },
    });
    const svc = new PurchaseOrdersService(makeServiceContext(stub.client) as never);

    const result = await svc.create({
      lines: MINIMAL_LINE,
      destinationLocationId: DEST_LOC_UUID,
    });

    expect(result.poNumber).toBe('PO-Y');
    expect(vi.mocked(assertWarehouseAccess)).toHaveBeenCalledWith(WH_UUID, 'write', expect.anything());
    // PO row + lines were written, by the one save call.
    expect(saveArgs(stub)?.p_destination_location_id).toBe(DEST_LOC_UUID);
  });
});

describe('PurchaseOrdersService.create — bill-to charter', () => {
  const CHARTER_UUID = 'cccccccc-0000-0000-0000-000000000001';
  const SPOOFED_CHARTER_UUID = 'dddddddd-0000-0000-0000-000000000099';

  it('persists a charter_id that belongs to the org, after an org-scoped verification', async () => {
    const stub = makeSupabaseStub({
      'charters.select': { data: { id: CHARTER_UUID }, error: null }, // found in org
      'rpc:save_purchase_order_draft': SAVED('po-ch'),
      'rpc:next_po_number': { data: 'PO-CH-1', error: null },
    });
    const svc = new PurchaseOrdersService(makeServiceContext(stub.client) as never);

    await svc.create({ lines: MINIMAL_LINE, charterId: CHARTER_UUID });

    expect(saveArgs(stub)?.p_charter_id).toBe(CHARTER_UUID);
    // The verification query was org-scoped (tenant isolation).
    const charterSelectArgs = (stub.chainArgsAll.get('charters.select') ?? []).flat(Infinity);
    expect(charterSelectArgs).toContain('organization_id');
    expect(charterSelectArgs).toContain('org-test');
  });

  it('drops a charter that is not in the org (cross-tenant) — writes charter_id null', async () => {
    const stub = makeSupabaseStub({
      'charters.select': { data: null, error: null }, // not found in this org
      'rpc:save_purchase_order_draft': SAVED('po-ch'),
      'rpc:next_po_number': { data: 'PO-CH-2', error: null },
    });
    const svc = new PurchaseOrdersService(makeServiceContext(stub.client) as never);

    await svc.create({ lines: MINIMAL_LINE, charterId: SPOOFED_CHARTER_UUID });

    expect(saveArgs(stub)?.p_charter_id).toBeNull();
  });

  it('writes charter_id null and skips the charter lookup when no charter is given', async () => {
    const stub = makeSupabaseStub({
      'rpc:save_purchase_order_draft': SAVED('po-ch'),
      'rpc:next_po_number': { data: 'PO-CH-3', error: null },
    });
    const svc = new PurchaseOrdersService(makeServiceContext(stub.client) as never);

    await svc.create({ lines: MINIMAL_LINE });

    expect(saveArgs(stub)?.p_charter_id).toBeNull();
    // No charter id → no verification query at all.
    expect(stub.chainsAll.get('charters.select')).toBeUndefined();
  });
});

describe('PurchaseOrdersService.create — cancelled PO number reuse', () => {
  it('allows a supplied poNumber whose only holder is cancelled, and excludes cancelled in the pre-check', async () => {
    const stub = makeSupabaseStub({
      // The status-filtered pre-check finds no NON-cancelled holder.
      'purchase_orders.select': { data: null, error: null },
      'rpc:save_purchase_order_draft': SAVED('po-reuse'),
    });
    const svc = new PurchaseOrdersService(makeServiceContext(stub.client) as never);

    const result = await svc.create({ lines: MINIMAL_LINE, poNumber: 'MLA-001071' });

    expect(result.poNumber).toBe('MLA-001071');
    // The uniqueness pre-check must filter OUT cancelled POs so a number freed
    // by a cancellation can be reused.
    const selectArgs = (stub.chainArgsAll.get('purchase_orders.select') ?? []).flat(2);
    expect(selectArgs).toContain('status');
    expect(selectArgs).toContain('cancelled');
    // The PO was saved with the reused number.
    expect(saveArgs(stub)?.p_po_number).toBe('MLA-001071');
  });
});
