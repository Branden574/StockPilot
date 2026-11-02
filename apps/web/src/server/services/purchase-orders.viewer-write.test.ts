import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

/**
 * Since migration 0423's decisions round, changing an existing purchase order
 * needs write access to the warehouse its destination is in, as the database's
 * purchase_orders_update policy asks (user_can_access_warehouse 'write'). A
 * viewer reads the purchase orders of the warehouses they are assigned to, so
 * get() lets a viewer holding purchase_orders:manage through, and before this
 * the service went on to write: placing, cancelling, renaming, re-noting or
 * editing a purchase order of a warehouse they may only view. The database now
 * matches no row for them, so the service refuses first, in words.
 *
 * assertWarehouseAccess is modelled on lib/auth/warehouse.ts: a viewer never
 * writes; anyone else writes where `writableIds` (or all access) says.
 */

const WH = 'aaaaaaaa-0000-0000-0000-000000000001' as const;

const { mockAccess } = vi.hoisted(() => ({
  mockAccess: vi.fn(),
}));

vi.mock('@/lib/auth/warehouse', () => {
  class ForbiddenError extends Error {
    readonly code = 'forbidden' as const;
    readonly accessUnreadable: boolean;
    constructor(message = 'Forbidden', opts: { accessUnreadable?: boolean } = {}) {
      super(message);
      this.accessUnreadable = opts.accessUnreadable === true;
    }
  }
  return {
    getWarehouseAccess: mockAccess,
    assertWarehouseAccess: vi.fn(
      async (warehouseId: string, op: 'read' | 'write', ctx: { role: string }) => {
        if (op === 'write' && ctx.role === 'viewer') {
          throw new ForbiddenError('Read-only auditor cannot perform write operations.');
        }
        const access = (await mockAccess(ctx)) as {
          readableIds: string[];
          writableIds: string[];
          hasAllAccess: boolean;
        };
        if (access.hasAllAccess) return;
        const allowed = op === 'write' ? access.writableIds : access.readableIds;
        if (!allowed.includes(warehouseId)) {
          throw new ForbiddenError(`User does not have ${op} access to warehouse ${warehouseId}.`);
        }
      },
    ),
    forcedWarehouseId: vi.fn(async () => null),
    ForbiddenError,
  };
});

vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({
    userId: 'user-test',
    organizationId: 'org-test',
    role: 'viewer',
  })),
}));

const { mockAudit } = vi.hoisted(() => ({ mockAudit: vi.fn(async () => {}) }));
vi.mock('./audit', () => ({ audit: mockAudit }));
vi.mock('./integration-events', () => ({ dispatchEvent: vi.fn(async () => {}) }));
vi.mock('./notifications', () => ({ createNotification: vi.fn(async () => 'notif-id') }));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => {
    throw new Error('no admin client in this test');
  },
}));
vi.mock('./inventory', () => ({ InventoryService: class {} }));
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

import { ServiceError } from './context';
import { PurchaseOrdersService } from './purchase-orders';

const VIEW_ONLY = "Your warehouse access is view only, so you can't change this purchase order.";
const BOTH = new Set(['purchase_orders:manage', 'purchase_orders:read']);
const PO_ID = 'po-viewer-id';

/** A purchase order as get() reads it: its destination's warehouse embedded. */
function po(status: string, warehouseId: string | null, extra: Record<string, unknown> = {}) {
  return {
    id: PO_ID,
    po_number: 'PO-2026-0001',
    status,
    total: 20,
    subtotal: 20,
    supplier_id: null,
    destination_location_id: warehouseId ? 'loc-in-wh' : null,
    expected_at: null,
    notes: 'old',
    destination: warehouseId ? { warehouse_id: warehouseId } : null,
    ...extra,
  };
}

/**
 * get() reads the header; a rename's uniqueness pre-check reads purchase_orders
 * again, for another row (`.neq('id', ...)`), and finds none.
 */
function stubFor(row: Record<string, unknown>) {
  return makeSupabaseStub({
    'purchase_orders.select': (call) =>
      call.methods.includes('neq') ? { data: null, error: null } : { data: row, error: null },
    'purchase_order_items.select': { data: [], error: null },
    'purchase_orders.update': { data: { id: PO_ID }, error: null },
    'rpc:save_purchase_order_draft': {
      data: { id: PO_ID, stamped: 0, stamp_error: null },
      error: null,
    },
  });
}

function svc(stub: ReturnType<typeof makeSupabaseStub>, role: 'viewer' | 'staff' | 'manager') {
  return new PurchaseOrdersService(
    makeServiceContext(stub.client, { role, permissions: BOTH }) as never,
  );
}

/** A viewer assigned to WH: reads there, writes nowhere. */
const VIEWER_ACCESS = {
  readableIds: [WH],
  writableIds: [],
  hasAllAccess: false,
  primaryWarehouseId: WH,
};
/** Staff assigned to WH: reads and writes there. */
const STAFF_ACCESS = {
  readableIds: [WH],
  writableIds: [WH],
  hasAllAccess: false,
  primaryWarehouseId: WH,
};

beforeEach(() => {
  vi.clearAllMocks();
});

type Change = [string, string, (s: PurchaseOrdersService) => Promise<unknown>];
const CHANGES: Change[] = [
  ['updateStatus (place)', 'draft', (s) => s.updateStatus(PO_ID, 'ordered')],
  ['updateStatus (cancel)', 'ordered', (s) => s.updateStatus(PO_ID, 'cancelled')],
  ['updateStatus (back to draft)', 'ordered', (s) => s.updateStatus(PO_ID, 'draft')],
  ['updateNotes', 'ordered', (s) => s.updateNotes(PO_ID, 'new note')],
  ['renamePoNumber', 'ordered', (s) => s.renamePoNumber(PO_ID, 'PO-RENAMED')],
  [
    'update (the draft edit, moving it to no destination)',
    'draft',
    (s) =>
      s.update(PO_ID, {
        destinationLocationId: null,
        lines: [
          { itemId: '00000000-0000-0000-0000-000000000001', quantityOrdered: 1, unitCost: 1 },
        ],
      }),
  ],
];

describe('PurchaseOrdersService: a viewer holding manage cannot change a purchase order of a warehouse they only view', () => {
  it.each(CHANGES)(
    '%s is refused in words before anything is written',
    async (_name, status, call) => {
      mockAccess.mockResolvedValue(VIEWER_ACCESS);
      const stub = stubFor(po(status, WH));

      const err = await call(svc(stub, 'viewer')).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ServiceError);
      expect((err as ServiceError).code).toBe('forbidden');
      expect((err as ServiceError).message).toBe(VIEW_ONLY);
      expect(stub.chainsAll.get('purchase_orders.update')).toBeUndefined();
      expect(stub.rpcCalls.filter((c) => c.name === 'save_purchase_order_draft')).toEqual([]);
      expect(mockAudit).not.toHaveBeenCalled();
    },
  );

  it.each(CHANGES)(
    '%s: staff who may write in that warehouse still change it',
    async (_name, status, call) => {
      mockAccess.mockResolvedValue(STAFF_ACCESS);
      const stub = stubFor(po(status, WH));

      await expect(call(svc(stub, 'staff'))).resolves.not.toThrow();
      const wrote =
        (stub.chainsAll.get('purchase_orders.update') ?? []).length +
        stub.rpcCalls.filter((c) => c.name === 'save_purchase_order_draft').length;
      expect(wrote).toBe(1);
    },
  );

  it('a purchase order with no destination stays open to the viewer, as in the database', async () => {
    mockAccess.mockResolvedValue(VIEWER_ACCESS);
    const stub = stubFor(po('ordered', null));

    await expect(svc(stub, 'viewer').updateNotes(PO_ID, 'new note')).resolves.toEqual({
      id: PO_ID,
    });
    expect((stub.chainsAll.get('purchase_orders.update') ?? []).length).toBe(1);
  });
});
