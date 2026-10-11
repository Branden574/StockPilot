import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub, servedLikePostgrest } from '@/test/supabase-mock';

/**
 * A purchase order's destination is where its received stock goes. The save
 * (PurchaseOrdersService.resolveDestinationWarehouseId, used by create and
 * update) refused a location linked to no warehouse, but accepted a DELETED
 * one: it read only the location's warehouse, deleted locations stay
 * readable, and the database checks only the organization. So a purchase
 * order could be saved, and a recurring template's daily run kept creating
 * them, to a location that no longer exists (small fixes slice 8, item C).
 *
 * Every caller of the method and what its people see on a refusal:
 *   - create (the New purchase order form): the form lists no deleted
 *     location, so only a location deleted while the form was open reaches
 *     it; the form shows the refusal.
 *   - update (Edit purchase order): the form no longer keeps a destination
 *     it does not offer (item A), so the same.
 *   - the recurring template save: it refuses a deleted destination itself
 *     first, in the template's words (#334); unchanged.
 *   - the recurring daily run, through create: the template is skipped and
 *     the reason told (recurring-pos.run-skips.test.ts).
 *   - the reorder drafts and the AI's drafts save with no destination, so
 *     nothing reaches the check.
 */

const WH = 'aaaaaaaa-0000-4000-8000-000000000001';

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
vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({ userId: 'user-test', organizationId: 'org-test', role: 'admin' })),
}));
vi.mock('./audit', () => ({ audit: vi.fn(async () => {}) }));
vi.mock('./integration-events', () => ({ dispatchEvent: vi.fn(async () => {}) }));
vi.mock('./notifications', () => ({ createNotification: vi.fn(async () => 'notif-id') }));
vi.mock('./item-images', () => ({
  ItemImagesService: class {
    async primaryImagesWithThumbsForItems() {
      return new Map();
    }
  },
}));
vi.mock('./inventory', () => ({
  InventoryService: class {
    create = vi.fn(async () => ({ id: 'new-item' }));
  },
}));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => makeSupabaseStub({ 'organization_members.select': { data: [], error: null } }).client,
}));

import { ServiceError } from './context';
import { PurchaseOrdersService, refusedDeletedDestination, refusedDestination } from './purchase-orders';

const DEST = {
  site: 'dddddddd-0000-4000-8000-000000000001',
  staging: 'dddddddd-0000-4000-8000-000000000002',
  deleted: 'dddddddd-0000-4000-8000-000000000003',
  deletedUnnamed: 'dddddddd-0000-4000-8000-000000000004',
  noWarehouse: 'dddddddd-0000-4000-8000-000000000005',
} as const;

/** locations as the database holds them: deleted ones stay readable. */
const LOCATIONS = [
  { id: DEST.site, organization_id: 'org-test', name: 'Main Warehouse', kind: null, type: 'warehouse', warehouse_id: WH, deleted_at: null },
  { id: DEST.staging, organization_id: 'org-test', name: 'Staging', kind: 'staging', type: 'other', warehouse_id: WH, deleted_at: null },
  { id: DEST.deleted, organization_id: 'org-test', name: 'Old Annex', kind: null, type: 'warehouse', warehouse_id: WH, deleted_at: '2026-10-01T00:00:00Z' },
  { id: DEST.deletedUnnamed, organization_id: 'org-test', name: '  ', kind: null, type: 'warehouse', warehouse_id: WH, deleted_at: '2026-10-01T00:00:00Z' },
  { id: DEST.noWarehouse, organization_id: 'org-test', name: 'District Office', kind: null, type: 'warehouse', warehouse_id: null, deleted_at: null },
];

const DRAFT = {
  id: 'po-1',
  organization_id: 'org-test',
  po_number: 'PO-001',
  status: 'draft',
  supplier_id: null,
  destination_location_id: DEST.deleted,
  charter_id: null,
  expected_at: null,
  notes: null,
  destination: { warehouse_id: WH },
};

function stub() {
  return makeSupabaseStub({
    'locations.select': servedLikePostgrest(LOCATIONS),
    'purchase_orders.select': { data: DRAFT, error: null },
    'purchase_order_items.select': { data: [], error: null },
    'rpc:next_po_number': { data: 'PO-100', error: null },
    'rpc:save_purchase_order_draft': { data: { id: 'po-1', stamped: 0, stamp_error: null }, error: null },
  });
}

const LINES = [{ itemId: '00000000-0000-4000-8000-000000000001', quantityOrdered: 1, unitCost: 10 }];

/** What the save said ('saved' or the refusal), and whether anything was written. */
async function save(op: 'create' | 'update', destinationLocationId: string) {
  const s = stub();
  const svc = new PurchaseOrdersService(makeServiceContext(s.client) as never);
  let outcome: string;
  let error: unknown = null;
  try {
    if (op === 'create') await svc.create({ destinationLocationId, lines: LINES });
    else await svc.update('po-1', { destinationLocationId, lines: LINES });
    outcome = 'saved';
  } catch (e) {
    error = e;
    outcome = e instanceof Error ? e.message : String(e);
  }
  const written = s.rpcCalls.some((c) => c.name === 'save_purchase_order_draft');
  return { outcome, written, error };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('PurchaseOrdersService: a deleted destination is refused by name, and nothing is written', () => {
  it.each(['create', 'update'] as const)('%s refuses a deleted location, naming it', async (op) => {
    const { outcome, written, error } = await save(op, DEST.deleted);
    expect(outcome).toBe('"Old Annex" was deleted, so a purchase order can\'t go there. Choose another destination.');
    expect(written).toBe(false);
    expect(error).toBeInstanceOf(ServiceError);
    expect((error as ServiceError).code).toBe('validation_error');
    // The run tells a deleted destination apart from other refusals by this,
    // not by the words.
    expect(refusedDeletedDestination(error)).toEqual({ locationName: 'Old Annex' });
    expect(refusedDestination(error)).toEqual({ why: 'deleted', locationName: 'Old Annex' });
  });

  it('a deleted location with no name is refused without one', async () => {
    const { outcome, written, error } = await save('create', DEST.deletedUnnamed);
    expect(outcome).toBe("The destination location was deleted, so a purchase order can't go there. Choose another destination.");
    expect(written).toBe(false);
    expect(refusedDeletedDestination(error)).toEqual({ locationName: null });
  });

  it('still refuses a location linked to no warehouse, in its own words', async () => {
    const { outcome, written, error } = await save('create', DEST.noWarehouse);
    expect(outcome).toBe(
      "That destination location isn't linked to a warehouse, so received stock would have nowhere to go. Pick a warehouse-backed location.",
    );
    expect(written).toBe(false);
    // Not a deleted destination; tagged with its own reason and name, so the
    // recurring run says it in the template's words (slice 8 review).
    expect(refusedDeletedDestination(error)).toBeNull();
    expect(refusedDestination(error)).toEqual({ why: 'no_warehouse', locationName: 'District Office' });
    expect(refusedDeletedDestination(new Error('x'))).toBeNull();
    expect(refusedDestination(new Error('x'))).toBeNull();
  });

  it.each(['create', 'update'] as const)('%s still saves to a site, and to a staging area (linked to its warehouse)', async (op) => {
    expect(await save(op, DEST.site)).toMatchObject({ outcome: 'saved', written: true });
    expect(await save(op, DEST.staging)).toMatchObject({ outcome: 'saved', written: true });
  });

  it('a failed location read refuses the save as an error, never as "not found" or a pass', async () => {
    const s = makeSupabaseStub({
      'locations.select': { data: null, error: { message: 'statement timeout' } },
      'rpc:next_po_number': { data: 'PO-100', error: null },
      'rpc:save_purchase_order_draft': { data: { id: 'po-1', stamped: 0, stamp_error: null }, error: null },
    });
    const svc = new PurchaseOrdersService(makeServiceContext(s.client) as never);
    const error = await svc.create({ destinationLocationId: DEST.site, lines: LINES }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServiceError);
    expect((error as ServiceError).code).toBe('internal_error');
    expect(s.rpcCalls.some((c) => c.name === 'save_purchase_order_draft')).toBe(false);
  });
});

/**
 * Ordering a draft whose destination was deleted (saved before slice 8, or
 * deleted afterwards) made it a receivable purchase order to a place that no
 * longer exists, with nobody editing it: updateStatus checked no destination
 * (slice 8 review). Committing the order is refused the same way the save is;
 * cancelling it, or keeping it a draft, is not.
 */
describe('PurchaseOrdersService.updateStatus: a draft to a deleted destination is not ordered', () => {
  function statusStub(draft: Record<string, unknown>) {
    return makeSupabaseStub({
      'locations.select': servedLikePostgrest(LOCATIONS),
      'purchase_orders.select': { data: draft, error: null },
      'purchase_order_items.select': { data: [], error: null },
      'purchase_orders.update': { data: { id: 'po-1' }, error: null },
      'organization_modules.select': { data: { settings: {} }, error: null },
      'rpc:publish_outbox': { data: null, error: null },
      'inventory_items.select': { data: [], error: null },
    });
  }

  it('refuses to order it, naming the location, and changes nothing', async () => {
    const s = statusStub(DRAFT);
    const svc = new PurchaseOrdersService(makeServiceContext(s.client) as never);
    const error = await svc.updateStatus('po-1', 'ordered').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServiceError);
    expect((error as ServiceError).message).toBe(
      '"Old Annex" was deleted, so a purchase order can\'t go there. Choose another destination.',
    );
    expect(refusedDeletedDestination(error)).toEqual({ locationName: 'Old Annex' });
    expect(s.chainsAll.get('purchase_orders.update')).toBeUndefined();
  });

  it('still cancels it', async () => {
    const s = statusStub(DRAFT);
    const svc = new PurchaseOrdersService(makeServiceContext(s.client) as never);
    await svc.updateStatus('po-1', 'cancelled');
    expect(s.chainsAll.get('purchase_orders.update')).toHaveLength(1);
  });

  it('orders a draft to a site as before', async () => {
    const s = statusStub({ ...DRAFT, destination_location_id: DEST.site });
    const svc = new PurchaseOrdersService(makeServiceContext(s.client) as never);
    await svc.updateStatus('po-1', 'ordered');
    expect(s.chainsAll.get('purchase_orders.update')).toHaveLength(1);
  });
});
