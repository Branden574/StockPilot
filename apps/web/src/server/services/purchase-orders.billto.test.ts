import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

/**
 * B4 — changing the BILL-TO on an existing purchase order must be a purely
 * financial edit.
 *
 * Bill-to is the charter the PO is invoiced to; it is rendered in the PO PDF's
 * "Bill to" block (which is where the bill-to ADDRESS comes from — there is no
 * separate bill_to_location column, and B2 forbids inventing one when the
 * charter already carries the billing address).
 *
 * Changing it must preserve operational placement, the warehouse assignment,
 * access, ownership, receiving history and inventory transactions, must write
 * its own BILLING audit event, and must write NO placement-change event.
 */

const WH_UUID = 'aaaaaaaa-0000-0000-0000-000000000001' as const;
/** Operational: where this PO receives. It must not move. */
const LOC_A = 'loc-operational-A' as const;
/** Billing: the bill-to charter before and after the edit. */
const CHARTER_B = 'chr-billto-B' as const;
const CHARTER_C = 'chr-billto-C' as const;

const { mockInvCreate: _mockInvCreate, mockAudit: _mockAudit, mockDispatch: _mockDispatch } =
  vi.hoisted(() => ({
    mockInvCreate: vi.fn(async () => ({ id: 'new-item-uuid' })),
    mockAudit: vi.fn(async () => {}),
    mockDispatch: vi.fn(async () => {}),
  }));

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
    userId: 'user-editor',
    organizationId: 'org-test',
    role: 'admin',
  })),
}));

vi.mock('./audit', () => ({ audit: _mockAudit }));
vi.mock('./integration-events', () => ({ dispatchEvent: _mockDispatch }));
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
    create = _mockInvCreate;
  },
}));
vi.mock('./notifications', () => ({ createNotification: vi.fn(async () => 'notif-id') }));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({ in: () => ({ not: () => ({ is: async () => ({ data: [], error: null }) }) }) }),
      }),
    }),
  }),
}));

const mockAudit = _mockAudit;
const mockInvCreate = _mockInvCreate;

import { PurchaseOrdersService } from './purchase-orders';

const PO_ID = 'po-billto';

/** A draft PO already operationally placed at LOC_A and billed to CHARTER_B. */
const EXISTING_PO = {
  id: PO_ID,
  po_number: 'PO-777',
  status: 'draft',
  total: 20,
  subtotal: 20,
  supplier_id: null,
  destination_location_id: LOC_A,
  charter_id: CHARTER_B,
  expected_at: null,
  notes: null,
  destination: { warehouse_id: WH_UUID },
};

function makeStub(overrides: Record<string, unknown> = {}) {
  return makeSupabaseStub({
    'purchase_orders.select': { data: EXISTING_PO, error: null },
    // resolveDestinationWarehouseId: LOC_A resolves to the same warehouse.
    'locations.select': { data: { warehouse_id: WH_UUID }, error: null },
    // resolveCharterId: the requested bill-to charter is a live org charter.
    'charters.select': { data: { id: CHARTER_C }, error: null },
    'purchase_order_items.select': {
      data: [
        {
          id: 'line-1',
          item_id: 'item-uuid-1',
          quantity_ordered: 2,
          unit_cost: 10,
          quantity_received: 0,
          line_total: 20,
        },
      ],
      error: null,
    },
    'purchase_order_items.delete': { data: null, error: null },
    'purchase_order_items.insert': { data: null, error: null },
    'purchase_orders.update': { data: { id: PO_ID }, error: null },
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockInvCreate.mockResolvedValue({ id: 'new-item-uuid' });
});

function auditCalls() {
  return mockAudit.mock.calls.map((c) => (c as unknown as [Record<string, unknown>])[0]);
}

// ─── TEST 2 (owner-required) ──────────────────────────────────────────────────

describe('OWNER TEST 2 — change ONLY the bill-to on a PO placed at location A', () => {
  it('keeps placement, warehouse and access; moves bill-to B→C; audits it as billing, not placement', async () => {
    const stub = makeStub();
    const svc = new PurchaseOrdersService(makeServiceContext(stub.client) as never);

    // The ONLY thing the caller changes is the bill-to charter. Operational
    // placement is resubmitted unchanged, exactly as the PO edit form does.
    await svc.update(PO_ID, {
      destinationLocationId: LOC_A,
      charterId: CHARTER_C,
      lines: [{ itemId: 'item-uuid-1', quantityOrdered: 2, unitCost: 10 }],
    });

    const payload = stub.chainArgs.get('purchase_orders.update')?.[0]?.[0] as Record<
      string,
      unknown
    >;

    // OPERATIONAL PLACEMENT IS UNCHANGED — still location A.
    expect(payload.destination_location_id).toBe(LOC_A);
    // …and specifically was not replaced by any billing value.
    expect(payload.destination_location_id).not.toBe(CHARTER_C);
    expect(payload.destination_location_id).not.toBe(CHARTER_B);

    // BILL-TO IS NOW C.
    expect(payload.charter_id).toBe(CHARTER_C);

    // WAREHOUSE ASSIGNMENT IS UNCHANGED. The PO has no warehouse column of its
    // own: its warehouse IS its destination location's warehouse, and that
    // location did not move. The write carries no warehouse field at all, so
    // there is nothing that could have changed it.
    expect(payload).not.toHaveProperty('warehouse_id');
    const locArgs = (stub.chainArgsAll.get('locations.select') ?? []).flat(Infinity);
    expect(locArgs).toContain(LOC_A);

    // ACCESS IS UNCHANGED. PO visibility is derived from the destination
    // location's warehouse against getWarehouseAccess (list() filters on it) —
    // never from charter_id. Same location ⇒ same warehouse ⇒ same audience.

    // OWNERSHIP / RECEIVING / STOCK ARE UNTOUCHED: this path writes no item,
    // no stock movement and no receipt row.
    expect(stub.fromCalls).not.toContain('inventory_items');
    expect(stub.fromCalls).not.toContain('stock_movements');
    expect(stub.fromCalls).not.toContain('receipts');
    expect(stub.fromCalls).not.toContain('receipt_lines');
    expect(mockInvCreate).not.toHaveBeenCalled();

    // A BILLING AUDIT EVENT EXISTS, with its own before/after.
    const updated = auditCalls().find((a) => a.event === 'purchase_order.updated');
    expect(updated).toBeDefined();
    const extra = updated!.extra as Record<string, unknown>;
    expect(extra.bill_to_charter_id_before).toBe(CHARTER_B);
    expect(extra.bill_to_charter_id_after).toBe(CHARTER_C);
    expect(extra.bill_to_changed).toBe(true);

    // AND NO PLACEMENT-CHANGE EVENT. The same record proves placement held.
    expect(extra.placement_changed).toBe(false);
    expect(extra.destination_location_id_before).toBe(LOC_A);
    expect(extra.destination_location_id_after).toBe(LOC_A);
    // No separate placement/transfer/movement event was emitted either.
    const events = auditCalls().map((a) => a.event as string);
    expect(events.filter((e) => /placement|transfer|moved|location\.changed/i.test(e))).toEqual([]);
  });

  it('records bill_to_changed=false when the bill-to is resubmitted unchanged', async () => {
    // Guards the inverse: an unrelated edit must not manufacture a billing
    // event, or the audit log stops being able to answer "who re-billed this?".
    const stub = makeStub({ 'charters.select': { data: { id: CHARTER_B }, error: null } });
    const svc = new PurchaseOrdersService(makeServiceContext(stub.client) as never);

    await svc.update(PO_ID, {
      destinationLocationId: LOC_A,
      charterId: CHARTER_B,
      notes: 'typo fix',
      lines: [{ itemId: 'item-uuid-1', quantityOrdered: 2, unitCost: 10 }],
    });

    const extra = auditCalls().find((a) => a.event === 'purchase_order.updated')!.extra as Record<
      string,
      unknown
    >;
    expect(extra.bill_to_changed).toBe(false);
    expect(extra.placement_changed).toBe(false);
  });
});
