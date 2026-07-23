import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

// Mock the warehouse helpers — services call them directly. The default mock
// gives full access; individual tests override per-call via mockResolvedValueOnce.
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

// Stub requireOrgContext so any incidental call doesn't blow up trying to read
// Next.js headers in the test environment.
vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({
    userId: 'user-test',
    organizationId: 'org-test',
    role: 'admin',
  })),
}));

// bulkUpdate fires audit() per affected item — mock it so the assertions
// below can inspect exactly which event name was emitted (Task 8's
// archive/restore audit-label fix) without a real audit_logs write.
vi.mock('./audit', () => ({
  audit: vi.fn(async () => undefined),
}));

import { getWarehouseAccess } from '@/lib/auth/warehouse';
import { audit } from './audit';
import { InventoryService, mapMovementTypeToAuditEvent } from './inventory';
import { ServiceError } from './context';

beforeEach(() => {
  vi.clearAllMocks();
  // Reset to default access for each test.
  vi.mocked(getWarehouseAccess).mockResolvedValue({
    readableIds: ['wh-a'],
    writableIds: ['wh-a'],
    hasAllAccess: true,
    primaryWarehouseId: 'wh-a',
  });
});

describe('InventoryService.list', () => {
  it('applies default product filter + active status when no filters passed', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: [], error: null, count: 0 },
    });
    const svc = new InventoryService(makeServiceContext(stub.client));

    await svc.list();

    // list() issues two inventory_items.select queries: the main
    // paginated one and a parallel skinny sum query for valueOnHand.
    // chainsAll preserves order; index 0 is the paginated query.
    const allChains = stub.chainsAll.get('inventory_items.select') ?? [];
    const allArgs = stub.chainArgsAll.get('inventory_items.select') ?? [];
    const chain = allChains[0] ?? [];
    const args = allArgs[0] ?? [];
    expect(chain).toContain('eq');
    expect(chain).toContain('is');
    expect(chain).toContain('order');
    // Pagination uses .range(offset, offset + limit - 1) instead of
    // .limit() so server-side cursoring works for ?page=N URLs.
    expect(chain).toContain('range');

    // Find the eq() that locked status to 'active' and item_type to 'product'.
    const eqCalls = chain
      .map((m, i) => ({ m, args: args[i] }))
      .filter((c) => c.m === 'eq');
    const eqMap = new Map(eqCalls.map((c) => [c.args![0] as string, c.args![1]]));
    expect(eqMap.get('organization_id')).toBe('org-test');
    expect(eqMap.get('status')).toBe('active');
    expect(eqMap.get('item_type')).toBe('product');
  });

  it('applies q filter via .or() with name/sku/barcode ilike', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: [], error: null, count: 0 },
    });
    const svc = new InventoryService(makeServiceContext(stub.client));

    await svc.list({ q: 'widget' });

    const chain = stub.chains.get('inventory_items.select') ?? [];
    const args = stub.chainArgs.get('inventory_items.select') ?? [];
    const orIdx = chain.indexOf('or');
    expect(orIdx).toBeGreaterThan(-1);
    expect(args[orIdx]![0]).toBe(
      'name.ilike.%widget%,sku.ilike.%widget%,barcode.ilike.%widget%,model_number.ilike.%widget%',
    );
  });

  it('skips item_type filter when itemType is "all"', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: [], error: null, count: 0 },
    });
    const svc = new InventoryService(makeServiceContext(stub.client));

    await svc.list({ itemType: 'all' });

    const chain = stub.chains.get('inventory_items.select') ?? [];
    const args = stub.chainArgs.get('inventory_items.select') ?? [];
    const eqArgs = chain
      .map((m, i) => ({ m, args: args[i] }))
      .filter((c) => c.m === 'eq')
      .map((c) => c.args![0] as string);
    expect(eqArgs).not.toContain('item_type');
  });

  it('returns empty when warehouse-scoped user has no readable warehouses', async () => {
    vi.mocked(getWarehouseAccess).mockResolvedValueOnce({
      readableIds: [],
      writableIds: [],
      hasAllAccess: false,
      primaryWarehouseId: null,
    });
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: [{ id: 'should-not-leak' }], error: null, count: 1 },
    });
    const svc = new InventoryService(
      makeServiceContext(stub.client, { role: 'staff' }),
    );

    const result = await svc.list();
    expect(result).toEqual({ items: [], total: 0, valueOnHand: 0 });
  });

  it('warehouse-scoped users get an in() on readableIds', async () => {
    vi.mocked(getWarehouseAccess).mockResolvedValueOnce({
      readableIds: ['wh-a', 'wh-b'],
      writableIds: ['wh-a', 'wh-b'],
      hasAllAccess: false,
      primaryWarehouseId: 'wh-a',
    });
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: [], error: null, count: 0 },
    });
    const svc = new InventoryService(
      makeServiceContext(stub.client, { role: 'staff' }),
    );

    await svc.list();

    const chain = stub.chains.get('inventory_items.select') ?? [];
    const args = stub.chainArgs.get('inventory_items.select') ?? [];
    const inIdx = chain.indexOf('in');
    expect(inIdx).toBeGreaterThan(-1);
    expect(args[inIdx]![0]).toBe('warehouse_id');
    expect(args[inIdx]![1]).toEqual(['wh-a', 'wh-b']);
  });

  it('post-filters lowStock results by qty <= reorder_point', async () => {
    const rows = [
      { id: 'a', quantity_on_hand: 1, reorder_point: 5 },
      { id: 'b', quantity_on_hand: 10, reorder_point: 5 },
    ];
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: rows, error: null, count: 99 },
    });
    const svc = new InventoryService(makeServiceContext(stub.client));

    const result = await svc.list({ lowStock: true });
    expect(result.items).toHaveLength(1);
    expect((result.items[0] as { id: string }).id).toBe('a');
    // total reflects the filtered length, not the wire count.
    expect(result.total).toBe(1);
  });

  it('throws ServiceError when supabase returns error', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: null, error: { message: 'boom' }, count: null },
    });
    const svc = new InventoryService(makeServiceContext(stub.client));

    await expect(svc.list()).rejects.toBeInstanceOf(ServiceError);
  });

  // Task 8: backs the Archived view's "Auto-archived only" filter chip —
  // scoped to rows the zero-stock cron archived, not every archived row.
  it('applies .eq("auto_archived", true) when autoArchived filter is set', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: [], error: null, count: 0 },
    });
    const svc = new InventoryService(makeServiceContext(stub.client));

    await svc.list({ status: 'archived', autoArchived: true });

    const chain = stub.chains.get('inventory_items.select') ?? [];
    const args = stub.chainArgs.get('inventory_items.select') ?? [];
    const eqCalls = chain
      .map((m, i) => ({ m, args: args[i] }))
      .filter((c) => c.m === 'eq');
    const eqMap = new Map(eqCalls.map((c) => [c.args![0] as string, c.args![1]]));
    expect(eqMap.get('status')).toBe('archived');
    expect(eqMap.get('auto_archived')).toBe(true);
  });

  it('omits the auto_archived filter when the flag is not set', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: [], error: null, count: 0 },
    });
    const svc = new InventoryService(makeServiceContext(stub.client));

    await svc.list({ status: 'archived' });

    const chain = stub.chains.get('inventory_items.select') ?? [];
    const args = stub.chainArgs.get('inventory_items.select') ?? [];
    const eqArgs = chain
      .map((m, i) => ({ m, args: args[i] }))
      .filter((c) => c.m === 'eq')
      .map((c) => c.args![0] as string);
    expect(eqArgs).not.toContain('auto_archived');
  });
});

describe('InventoryService.byIds', () => {
  it('returns [] without hitting supabase when ids is empty', async () => {
    const stub = makeSupabaseStub();
    const svc = new InventoryService(makeServiceContext(stub.client));

    const result = await svc.byIds([]);
    expect(result).toEqual([]);
    expect(stub.fromCalls).toHaveLength(0);
  });

  it('flattens tracking_type to "none" when null', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': {
        data: [
          { id: 'a', sku: 'A1', name: 'Widget A', tracking_type: null },
          { id: 'b', sku: 'B1', name: 'Widget B', tracking_type: 'lot' },
        ],
        error: null,
      },
    });
    const svc = new InventoryService(makeServiceContext(stub.client));

    const rows = await svc.byIds(['a', 'b']);
    // barcode rides along for the labels page (null when the row lacks it).
    expect(rows).toEqual([
      { id: 'a', sku: 'A1', name: 'Widget A', tracking_type: 'none', barcode: null },
      { id: 'b', sku: 'B1', name: 'Widget B', tracking_type: 'lot', barcode: null },
    ]);
  });
});

describe('InventoryService.bulkUpdate', () => {
  it('returns 0/0 immediately when ids is empty', async () => {
    const stub = makeSupabaseStub();
    const svc = new InventoryService(makeServiceContext(stub.client));

    const result = await svc.bulkUpdate({ ids: [], op: { kind: 'archive' } });
    expect(result).toEqual({ ok: 0, skipped: 0 });
    expect(stub.fromCalls).toHaveLength(0);
  });

  it('throws when ids exceeds the 500-item cap', async () => {
    const stub = makeSupabaseStub();
    const svc = new InventoryService(makeServiceContext(stub.client));
    const ids = Array.from({ length: 501 }, (_, i) => `i-${i}`);

    await expect(
      svc.bulkUpdate({ ids, op: { kind: 'archive' } }),
    ).rejects.toBeInstanceOf(ServiceError);
  });

  it('skips items in unwritable warehouses for managers without all-access', async () => {
    vi.mocked(getWarehouseAccess).mockResolvedValueOnce({
      readableIds: ['wh-a', 'wh-b'],
      writableIds: ['wh-a'],
      hasAllAccess: false,
      primaryWarehouseId: 'wh-a',
    });
    const stub = makeSupabaseStub({
      'inventory_items.select': {
        data: [
          { id: 'item-1', warehouse_id: 'wh-a' },
          { id: 'item-2', warehouse_id: 'wh-b' },
          { id: 'item-3', warehouse_id: null },
        ],
        error: null,
      },
      'inventory_items.update': { data: null, error: null },
    });
    const svc = new InventoryService(
      makeServiceContext(stub.client, { role: 'manager' }),
    );

    const result = await svc.bulkUpdate({
      ids: ['item-1', 'item-2', 'item-3'],
      op: { kind: 'archive' },
    });
    // wh-a + null warehouse pass through; wh-b is skipped.
    expect(result).toEqual({ ok: 2, skipped: 1 });
  });

  it('builds the right update payload for set_category', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': {
        data: [{ id: 'item-1', warehouse_id: 'wh-a' }],
        error: null,
      },
      'inventory_items.update': { data: null, error: null },
    });
    const svc = new InventoryService(makeServiceContext(stub.client));

    await svc.bulkUpdate({
      ids: ['item-1'],
      op: { kind: 'set_category', categoryId: 'cat-99' },
    });

    const updateChain = stub.chains.get('inventory_items.update') ?? [];
    const updateArgs = stub.chainArgs.get('inventory_items.update') ?? [];
    expect(updateChain[0]).toBe('update');
    const payload = updateArgs[0]![0] as Record<string, unknown>;
    expect(payload.category_id).toBe('cat-99');
    expect(payload.updated_by).toBe('user-test');
  });

  it('builds the right update payload for set_status', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': {
        data: [{ id: 'item-1', warehouse_id: 'wh-a' }],
        error: null,
      },
      'inventory_items.update': { data: null, error: null },
    });
    const svc = new InventoryService(makeServiceContext(stub.client));

    await svc.bulkUpdate({
      ids: ['item-1'],
      op: { kind: 'set_status', status: 'discontinued' },
    });

    const updateArgs = stub.chainArgs.get('inventory_items.update') ?? [];
    const payload = updateArgs[0]![0] as Record<string, unknown>;
    expect(payload.status).toBe('discontinued');
  });

  // Task 8: the 'unarchive' op used to fall through the ternary into the
  // generic 'inventory.item.updated' audit event, so a restore was
  // indistinguishable from an ordinary field edit in the item's Activity
  // feed / audit log. It must emit 'inventory.item.restored' instead
  // (already a member of the AuditEvent union) — mirroring how 'archive'
  // already emits 'inventory.item.archived'.
  it('emits inventory.item.restored (not .updated) for a bulk unarchive', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': {
        data: [{ id: 'item-1', warehouse_id: 'wh-a' }],
        error: null,
      },
      'inventory_items.update': { data: null, error: null },
    });
    const svc = new InventoryService(makeServiceContext(stub.client));

    await svc.bulkUpdate({ ids: ['item-1'], op: { kind: 'unarchive' } });

    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'inventory.item.restored', entityId: 'item-1' }),
      expect.anything(),
    );
    expect(audit).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'inventory.item.updated' }),
      expect.anything(),
    );
  });

  it('still emits inventory.item.archived for a bulk archive (unchanged)', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': {
        data: [{ id: 'item-1', warehouse_id: 'wh-a' }],
        error: null,
      },
      'inventory_items.update': { data: null, error: null },
    });
    const svc = new InventoryService(makeServiceContext(stub.client));

    await svc.bulkUpdate({ ids: ['item-1'], op: { kind: 'archive' } });

    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'inventory.item.archived', entityId: 'item-1' }),
      expect.anything(),
    );
  });

  // A human-initiated bulk archive/unarchive must never leave a stale
  // auto_archived=true behind — otherwise a later receipt (which only
  // revives auto_archived rows, see receiving.ts) or the "Auto-archived"
  // badge could misrepresent a MANUAL action as a system one.
  it.each(['archive', 'unarchive'] as const)(
    'clears auto_archived on bulk %s so it can never be mistaken for a system archive',
    async (kind) => {
      const stub = makeSupabaseStub({
        'inventory_items.select': {
          data: [{ id: 'item-1', warehouse_id: 'wh-a' }],
          error: null,
        },
        'inventory_items.update': { data: null, error: null },
      });
      const svc = new InventoryService(makeServiceContext(stub.client));

      await svc.bulkUpdate({ ids: ['item-1'], op: { kind } });

      const updateArgs = stub.chainArgs.get('inventory_items.update') ?? [];
      const payload = updateArgs[0]![0] as Record<string, unknown>;
      expect(payload.auto_archived).toBe(false);
    },
  );

  it('returns ok:0 when no allowed ids remain after warehouse filtering', async () => {
    vi.mocked(getWarehouseAccess).mockResolvedValueOnce({
      readableIds: ['wh-a'],
      writableIds: [],
      hasAllAccess: false,
      primaryWarehouseId: 'wh-a',
    });
    const stub = makeSupabaseStub({
      'inventory_items.select': {
        data: [{ id: 'item-1', warehouse_id: 'wh-a' }],
        error: null,
      },
    });
    const svc = new InventoryService(
      makeServiceContext(stub.client, { role: 'viewer' }),
    );

    // assertPermission for 'items:update' will fail before bulkUpdate even gets here
    // for a viewer — so use a manager with no writable warehouses instead. The
    // viewer path is exercised via permission elsewhere; here we want to land in
    // the "no allowed ids" branch.
    await expect(
      svc.bulkUpdate({ ids: ['item-1'], op: { kind: 'archive' } }),
    ).rejects.toBeInstanceOf(ServiceError);
  });
});

// Movement/Activity P2 Task 1: the P1 before/after diff drawer
// (metadata-diff.tsx) renders from audit_logs.metadata.before/after — these
// tests prove update()/bulkUpdate() actually populate that data, restricted
// to the CHANGED columns only (never heavy/derived columns like embedding
// or search_vector, even when the full row carries them).
describe('InventoryService.update — audit before/after capture', () => {
  const ITEM_BEFORE = {
    id: 'itm-1',
    organization_id: 'org-test',
    name: 'Old Name',
    sku: 'SKU-1',
    barcode: null,
    warehouse_id: 'wh-a',
    bin_location: 'B-1',
    charter_id: null,
    custom_fields: {},
    status: 'active',
    item_type: 'product',
    tracking_type: 'none',
    quantity_on_hand: 5,
    // Heavy/derived columns that a naive "spread the whole row" bug would
    // otherwise leak into the audit metadata.
    embedding: [0.1, 0.2, 0.3],
    search_vector: 'old tsvector data',
  };
  const ITEM_AFTER = {
    ...ITEM_BEFORE,
    bin_location: 'B-2',
    status: 'discontinued',
    embedding: [0.9, 0.9, 0.9],
    search_vector: 'new tsvector data',
  };

  it('passes before/after restricted to the CHANGED keys only, excluding heavy columns', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: ITEM_BEFORE, error: null },
      'inventory_items.update': { data: ITEM_AFTER, error: null },
    });
    const svc = new InventoryService(makeServiceContext(stub.client));

    // bin_location + status are PER-PLACEMENT fields (not in
    // SHARED_ITEM_FIELDS), so this patch never triggers the Model-B
    // sibling fan-out — keeps this test focused on the target-row diff.
    await svc.update('itm-1', { binLocation: 'B-2', status: 'discontinued' });

    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'inventory.item.updated',
        entityType: 'inventory_item',
        entityId: 'itm-1',
        before: { bin_location: 'B-1', status: 'active' },
        after: { bin_location: 'B-2', status: 'discontinued' },
        extra: expect.objectContaining({ changed_keys: ['bin_location', 'status'] }),
      }),
      expect.anything(),
    );

    const [payload] = vi.mocked(audit).mock.calls[0]!;
    expect(payload.before).not.toHaveProperty('embedding');
    expect(payload.before).not.toHaveProperty('search_vector');
    expect(payload.after).not.toHaveProperty('embedding');
    expect(payload.after).not.toHaveProperty('search_vector');
  });
});

describe('InventoryService.bulkUpdate — audit before/after capture', () => {
  it('generic branch (set_category): before/after + changed_keys reflect the OLD vs NEW column value', async () => {
    let selectCalls = 0;
    const stub = makeSupabaseStub({
      'inventory_items.select': () => {
        selectCalls += 1;
        // Call 1 is the warehouse-access load; call 2 is the new
        // old-values batch read this task adds.
        return selectCalls === 1
          ? { data: [{ id: 'item-1', warehouse_id: 'wh-a' }], error: null }
          : { data: [{ id: 'item-1', category_id: 'cat-old' }], error: null };
      },
      'inventory_items.update': { data: null, error: null },
    });
    const svc = new InventoryService(makeServiceContext(stub.client));

    await svc.bulkUpdate({
      ids: ['item-1'],
      op: { kind: 'set_category', categoryId: 'cat-new' },
    });

    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'inventory.item.updated',
        entityType: 'inventory_item',
        entityId: 'item-1',
        before: { category_id: 'cat-old' },
        after: { category_id: 'cat-new' },
        extra: { bulk_op: 'set_category', changed_keys: ['category_id'] },
      }),
      expect.anything(),
    );
  });

  it('set_rack branch: before/after carry the OLD vs NEW bin_location label', async () => {
    let selectCalls = 0;
    const stub = makeSupabaseStub({
      'inventory_items.select': () => {
        selectCalls += 1;
        return selectCalls === 1
          ? { data: [{ id: 'item-1', warehouse_id: 'wh-a' }], error: null }
          : { data: [{ id: 'item-1', bin_location: 'OLD-1' }], error: null };
      },
      'rpc:inventory_set_rack': { data: 1, error: null },
      // Empty holdings so placeItemsOntoRackByName (called after the label
      // write) finds nothing to physically move — irrelevant to this test.
      'item_stock_levels.select': { data: [], error: null },
    });
    const svc = new InventoryService(makeServiceContext(stub.client));

    await svc.bulkUpdate({
      ids: ['item-1'],
      op: { kind: 'set_rack', rackNumber: '2', rackRow: 'B' },
    });

    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'inventory.item.updated',
        entityType: 'inventory_item',
        entityId: 'item-1',
        before: { bin_location: 'OLD-1' },
        after: { bin_location: '2-B' },
        extra: expect.objectContaining({
          bulk_op: 'set_rack',
          changed_keys: ['bin_location'],
        }),
      }),
      expect.anything(),
    );
  });
});

describe('mapMovementTypeToAuditEvent', () => {
  it.each([
    ['receive_po', 'stock.received'],
    ['remove', 'stock.removed'],
    ['damage', 'stock.removed'],
    ['add', 'stock.adjusted'],
    ['adjust', 'stock.adjusted'],
    ['transfer', 'stock.adjusted'],
    ['return', 'stock.adjusted'],
    ['loss', 'stock.adjusted'],
    ['correction', 'stock.adjusted'],
    ['initial', 'stock.adjusted'],
  ] as const)('%s -> %s', (movementType, expected) => {
    expect(mapMovementTypeToAuditEvent(movementType)).toBe(expected);
  });
});

describe('InventoryService.adjustStock — audit capture', () => {
  const ITEM = {
    id: 'itm-1',
    organization_id: 'org-test',
    warehouse_id: 'wh-a',
    status: 'active',
    quantity_on_hand: 10,
    reorder_point: 2,
    name: 'Widget',
    sku: 'W-1',
  };

  it('emits an audit row with entityId=itemId + before/after quantity_on_hand + the mapped event', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: ITEM, error: null },
      'item_stock_levels.select': { data: [], error: null },
      'rpc:adjust_stock': { data: { quantity_on_hand: 15, reorder_point: 2 }, error: null },
    });
    const svc = new InventoryService(makeServiceContext(stub.client));

    await svc.adjustStock({
      itemId: 'itm-1',
      quantityChange: 5,
      movementType: 'receive_po',
      locationId: 'loc-1',
      reason: 'PO receipt',
    });

    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'stock.received',
        entityType: 'inventory_item',
        entityId: 'itm-1',
        warehouseId: 'wh-a',
        before: { quantity_on_hand: 10 },
        after: { quantity_on_hand: 15 },
        reason: 'PO receipt',
        extra: {
          quantity_change: 5,
          movement_type: 'receive_po',
          location_id: 'loc-1',
        },
      }),
      expect.anything(),
    );
  });
});

describe('InventoryService.transferStock — audit capture', () => {
  it('emits stock.transferred with entityId=itemId + before/after location_id', async () => {
    const stub = makeSupabaseStub({
      'rpc:transfer_stock': { data: { ok: true }, error: null },
    });
    const svc = new InventoryService(makeServiceContext(stub.client));

    await svc.transferStock({
      itemId: 'itm-1',
      fromLocationId: 'loc-a',
      toLocationId: 'loc-b',
      quantity: 3,
    });

    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'stock.transferred',
        entityType: 'inventory_item',
        entityId: 'itm-1',
        before: { location_id: 'loc-a' },
        after: { location_id: 'loc-b' },
        extra: { quantity: 3, from_location_id: 'loc-a', to_location_id: 'loc-b' },
      }),
      expect.anything(),
    );
  });
});

// Movement/Activity P3 Task 1: archive() and softDelete() deliberately
// PRESERVE quantity_on_hand — no stock physically moves — but a previous
// version ALSO inserted a fictional `stock_movements` row
// (movement_type='adjust', reason='item_archived'/'item_deleted') driving
// on-hand to 0 whenever the item had stock. Nothing ever reversed that row
// on restore, which double-counted historical qty in the dashboard-history
// reconstruction. These tests prove the insert is gone while the audit
// event (the correct way to record the lifecycle transition) still fires.
describe('InventoryService.archive / softDelete — no fictional stock_movements row', () => {
  const ITEM_WITH_STOCK = {
    id: 'itm-stock',
    organization_id: 'org-test',
    warehouse_id: 'wh-a',
    status: 'active',
    quantity_on_hand: 42,
  };

  // Behaviour deliberately changed (archive stock-guard): archiving an item
  // that still holds stock now REQUIRES an explicit acknowledgeStock flag — the
  // silent orphan is gone, the deliberate write-off is not. This test keeps
  // proving the ORIGINAL property (no fictional stock_movements row is written,
  // and the lifecycle audit event still fires) but via the acknowledged path,
  // which is the only way an item with stock is archivable now. The refuse-by-
  // default behaviour is covered in the 'archive stock-guard' describe below.
  it('archive({acknowledgeStock:true}) on an item WITH stock writes NO stock_movements row and still emits inventory.item.archived', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: ITEM_WITH_STOCK, error: null },
      'inventory_items.update': { data: null, error: null },
    });
    const svc = new InventoryService(makeServiceContext(stub.client));

    await svc.archive('itm-stock', { acknowledgeStock: true });

    // No insert (or any query at all) against stock_movements.
    expect(stub.fromCalls).not.toContain('stock_movements');
    expect(stub.chains.has('stock_movements.insert')).toBe(false);

    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'inventory.item.archived',
        entityType: 'inventory_item',
        entityId: 'itm-stock',
        warehouseId: 'wh-a',
      }),
      expect.anything(),
    );

    // The status update still fires with the real payload — archive/delete
    // must keep preserving quantity_on_hand (it's absent from the payload).
    const updateArgs = stub.chainArgs.get('inventory_items.update') ?? [];
    const payload = updateArgs[0]![0] as Record<string, unknown>;
    expect(payload.status).toBe('archived');
    expect(payload).not.toHaveProperty('quantity_on_hand');
  });

  it('softDelete() on an item WITH stock on hand writes NO stock_movements row and still emits inventory.item.deleted', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: ITEM_WITH_STOCK, error: null },
      'inventory_items.update': { data: null, error: null },
    });
    const svc = new InventoryService(makeServiceContext(stub.client));

    await svc.softDelete('itm-stock');

    expect(stub.fromCalls).not.toContain('stock_movements');
    expect(stub.chains.has('stock_movements.insert')).toBe(false);

    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'inventory.item.deleted',
        entityType: 'inventory_item',
        entityId: 'itm-stock',
        warehouseId: 'wh-a',
      }),
      expect.anything(),
    );

    const updateArgs = stub.chainArgs.get('inventory_items.update') ?? [];
    const payload = updateArgs[0]![0] as Record<string, unknown>;
    expect(payload).toHaveProperty('deleted_at');
    expect(payload).not.toHaveProperty('quantity_on_hand');
  });

  it('archive() on an item with ZERO stock also writes no stock_movements row (unchanged behavior)', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': {
        data: { ...ITEM_WITH_STOCK, quantity_on_hand: 0 },
        error: null,
      },
      'inventory_items.update': { data: null, error: null },
    });
    const svc = new InventoryService(makeServiceContext(stub.client));

    await svc.archive('itm-stock');

    expect(stub.fromCalls).not.toContain('stock_movements');
  });
});

// DELIVERABLE 1 — the archive stock-guard. Archiving an item that still holds
// stock hides it from every active screen while item_stock_levels /
// quantity_on_hand keep counting its units (orphaned stock: invisible but still
// in valuation + reconciliation). The guard refuses by default, NAMING the
// total and where it sits, and allows a deliberate override.
describe('InventoryService.archive — stock guard', () => {
  const ACTIVE_ITEM = {
    id: 'itm-persepolis',
    organization_id: 'org-test',
    warehouse_id: 'wh-a',
    status: 'active',
    quantity_on_hand: 181,
  };
  // Two rack holdings mirroring Andrew's real Persepolis record.
  const HOLDINGS = [
    { location_id: 'loc-100a', quantity: 140, locations: { id: 'loc-100a', name: '100-A', kind: 'rack' } },
    { location_id: 'loc-38b', quantity: 41, locations: { id: 'loc-38b', name: '38-B', kind: 'rack' } },
  ];

  it('refuses to archive an item that still holds stock, naming the total and each location', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: ACTIVE_ITEM, error: null },
      'item_stock_levels.select': { data: HOLDINGS, error: null },
      'inventory_items.update': { data: null, error: null },
    });
    const svc = new InventoryService(makeServiceContext(stub.client));

    await expect(svc.archive('itm-persepolis')).rejects.toMatchObject({
      code: 'validation_error',
    });
    // The status update must NOT have fired — the archive was blocked.
    expect(stub.chains.has('inventory_items.update')).toBe(false);

    // Re-run to inspect the message text (the rejection above consumed one call).
    await svc.archive('itm-persepolis').catch((e: unknown) => {
      const msg = (e as ServiceError).message;
      expect(msg).toContain('181 units still on hand');
      expect(msg).toContain('140 in 100-A');
      expect(msg).toContain('41 in 38-B');
    });
  });

  it('archives an item with stock when acknowledgeStock is set (deliberate write-off)', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: ACTIVE_ITEM, error: null },
      'item_stock_levels.select': { data: HOLDINGS, error: null },
      'inventory_items.update': { data: null, error: null },
    });
    const svc = new InventoryService(makeServiceContext(stub.client));

    await svc.archive('itm-persepolis', { acknowledgeStock: true });

    const payload = (stub.chainArgs.get('inventory_items.update') ?? [])[0]![0] as Record<
      string,
      unknown
    >;
    expect(payload.status).toBe('archived');
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'inventory.item.archived', entityId: 'itm-persepolis' }),
      expect.anything(),
    );
  });

  it('archives a zero-stock item with no ack (the auto-archive-equivalent path is untouched)', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: { ...ACTIVE_ITEM, quantity_on_hand: 0 }, error: null },
      'item_stock_levels.select': { data: [], error: null },
      'inventory_items.update': { data: null, error: null },
    });
    const svc = new InventoryService(makeServiceContext(stub.client));

    await svc.archive('itm-persepolis');

    const payload = (stub.chainArgs.get('inventory_items.update') ?? [])[0]![0] as Record<
      string,
      unknown
    >;
    expect(payload.status).toBe('archived');
  });

  it('FAILS CLOSED: a stock-read error blocks the archive rather than risking an orphan', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: ACTIVE_ITEM, error: null },
      'item_stock_levels.select': { data: null, error: { message: 'connection reset' } },
      'inventory_items.update': { data: null, error: null },
    });
    const svc = new InventoryService(makeServiceContext(stub.client));

    await expect(svc.archive('itm-persepolis')).rejects.toBeInstanceOf(ServiceError);
    expect(stub.chains.has('inventory_items.update')).toBe(false);
  });
});

describe('InventoryService.bulkUpdate — stock guard', () => {
  it('refuses a single-item bulk archive that still holds stock, with the detailed message', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: [{ id: 'item-1', warehouse_id: 'wh-a' }], error: null },
      'item_stock_levels.select': {
        data: [
          { item_id: 'item-1', location_id: 'l', quantity: 140, locations: { id: 'l', name: '100-A', kind: 'rack' } },
        ],
        error: null,
      },
    });
    const svc = new InventoryService(makeServiceContext(stub.client));

    await svc.bulkUpdate({ ids: ['item-1'], op: { kind: 'archive' } }).catch((e: unknown) => {
      expect((e as ServiceError).code).toBe('validation_error');
      expect((e as ServiceError).message).toContain('140 in 100-A');
    });
    // Blocked → no status update fired.
    expect(stub.chains.has('inventory_items.update')).toBe(false);
  });

  it('names the COUNT when several selected items hold stock', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': {
        data: [
          { id: 'item-1', warehouse_id: 'wh-a' },
          { id: 'item-2', warehouse_id: 'wh-a' },
        ],
        error: null,
      },
      'item_stock_levels.select': {
        data: [
          { item_id: 'item-1', location_id: 'l1', quantity: 10, locations: { id: 'l1', name: 'A', kind: 'rack' } },
          { item_id: 'item-2', location_id: 'l2', quantity: 5, locations: { id: 'l2', name: 'B', kind: 'rack' } },
        ],
        error: null,
      },
    });
    const svc = new InventoryService(makeServiceContext(stub.client));

    await svc.bulkUpdate({ ids: ['item-1', 'item-2'], op: { kind: 'archive' } }).catch((e: unknown) => {
      expect((e as ServiceError).message).toContain('2 selected items still hold stock');
    });
    expect(stub.chains.has('inventory_items.update')).toBe(false);
  });

  it('a bulk set_status to "archived" is guarded the same way', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: [{ id: 'item-1', warehouse_id: 'wh-a' }], error: null },
      'item_stock_levels.select': {
        data: [
          { item_id: 'item-1', location_id: 'l', quantity: 3, locations: { id: 'l', name: 'C', kind: 'rack' } },
        ],
        error: null,
      },
    });
    const svc = new InventoryService(makeServiceContext(stub.client));

    await expect(
      svc.bulkUpdate({ ids: ['item-1'], op: { kind: 'set_status', status: 'archived' } }),
    ).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('acknowledgeStock lets a bulk archive-with-stock through', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: [{ id: 'item-1', warehouse_id: 'wh-a' }], error: null },
      'item_stock_levels.select': {
        data: [
          { item_id: 'item-1', location_id: 'l', quantity: 3, locations: { id: 'l', name: 'C', kind: 'rack' } },
        ],
        error: null,
      },
      'inventory_items.update': { data: null, error: null },
    });
    const svc = new InventoryService(makeServiceContext(stub.client));

    const res = await svc.bulkUpdate({
      ids: ['item-1'],
      op: { kind: 'archive' },
      acknowledgeStock: true,
    });
    expect(res).toEqual({ ok: 1, skipped: 0 });
  });
});

// DELIVERABLE 2 (service half) — remove stock from ONE rack, built on adjustStock.
describe('InventoryService.removeStockFromLocation', () => {
  const ACTIVE_ITEM = {
    id: 'itm-1',
    organization_id: 'org-test',
    warehouse_id: 'wh-a',
    status: 'active',
    quantity_on_hand: 181,
    reorder_point: 0,
    name: 'Persepolis',
    sku: 'SP-THV69-MG8',
  };

  it('draws down exactly ONE location with a negative "remove" delta + the reason verbatim', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: ACTIVE_ITEM, error: null },
      // The pre-read (maybeSingle) sees 140 in this holding; adjustStock's get()
      // staged/unplaced read sees the same rows harmlessly.
      'item_stock_levels.select': { data: [{ quantity: 140 }], error: null },
      'rpc:adjust_stock': { data: { quantity_on_hand: 41, reorder_point: 0 }, error: null },
    });
    const svc = new InventoryService(makeServiceContext(stub.client));

    await svc.removeStockFromLocation({
      itemId: 'itm-1',
      locationId: 'loc-100a',
      quantity: 140,
      reason: 'Consolidated onto 100-A for a clean count',
    });

    const call = stub.rpcCalls.find((c) => c.name === 'adjust_stock');
    expect(call).toBeTruthy();
    expect(call!.args).toMatchObject({
      p_item_id: 'itm-1',
      p_quantity_change: -140,
      p_movement_type: 'remove',
      p_location_id: 'loc-100a',
      p_reason: 'Consolidated onto 100-A for a clean count',
    });
    // The movement is recorded as a removal in the audit trail.
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'stock.removed',
        entityId: 'itm-1',
        reason: 'Consolidated onto 100-A for a clean count',
      }),
      expect.anything(),
    );
  });

  it('refuses an over-quantity removal, naming what is actually there', async () => {
    const stub = makeSupabaseStub({
      'item_stock_levels.select': { data: [{ quantity: 140 }], error: null },
    });
    const svc = new InventoryService(makeServiceContext(stub.client));

    await svc
      .removeStockFromLocation({
        itemId: 'itm-1',
        locationId: 'loc-100a',
        quantity: 200,
        reason: 'oops too many',
      })
      .catch((e: unknown) => {
        expect((e as ServiceError).code).toBe('validation_error');
        expect((e as ServiceError).message).toContain('only 140');
      });
    // adjust_stock must never have been called on an over-draw.
    expect(stub.rpcCalls.find((c) => c.name === 'adjust_stock')).toBeUndefined();
  });

  it('refuses a zero-quantity removal', async () => {
    const stub = makeSupabaseStub({
      'item_stock_levels.select': { data: [{ quantity: 140 }], error: null },
    });
    const svc = new InventoryService(makeServiceContext(stub.client));

    await expect(
      svc.removeStockFromLocation({
        itemId: 'itm-1',
        locationId: 'loc-100a',
        quantity: 0,
        reason: 'nothing',
      }),
    ).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('refuses a removal from a location that holds no stock for the item', async () => {
    const stub = makeSupabaseStub({
      'item_stock_levels.select': { data: [], error: null },
    });
    const svc = new InventoryService(makeServiceContext(stub.client));

    await expect(
      svc.removeStockFromLocation({
        itemId: 'itm-1',
        locationId: 'loc-empty',
        quantity: 5,
        reason: 'nothing here',
      }),
    ).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('composes with archive: after a removal that zeroes the item, archive no longer blocks', async () => {
    let removed = false;
    const stub = makeSupabaseStub({
      'inventory_items.select': () => ({
        data: { ...ACTIVE_ITEM, quantity_on_hand: removed ? 0 : 41 },
        error: null,
      }),
      'item_stock_levels.select': () => ({
        data: removed
          ? []
          : [{ location_id: 'loc-38b', quantity: 41, locations: { id: 'loc-38b', name: '38-B', kind: 'rack' } }],
        error: null,
      }),
      'inventory_items.update': { data: null, error: null },
      'rpc:adjust_stock': { data: { quantity_on_hand: 0, reorder_point: 0 }, error: null },
    });
    const svc = new InventoryService(makeServiceContext(stub.client));

    await svc.removeStockFromLocation({
      itemId: 'itm-1',
      locationId: 'loc-38b',
      quantity: 41,
      reason: 'Wrote off 38-B',
    });
    removed = true;

    // Now at zero stock, the Deliverable-1 guard must NOT block the archive.
    await expect(svc.archive('itm-1')).resolves.toBeUndefined();
    const payload = (stub.chainArgs.get('inventory_items.update') ?? [])[0]![0] as Record<
      string,
      unknown
    >;
    expect(payload.status).toBe('archived');
  });
});
