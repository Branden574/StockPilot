import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A draft PO is saved in ONE database transaction (S3 F2, migration 0366).
 *
 * create() used to insert the header and then the lines as two requests, and
 * update() claimed the header, created custom items, deleted every line and
 * inserted the new set as four. A failure partway left an empty draft, or a
 * draft whose supplier and total did not match its lines. Now:
 *   - the header, the lines and the custom-item tags go through the one
 *     save_purchase_order_draft call (no direct PO table write from here);
 *   - custom "new item" lines are still created first (InventoryService owns
 *     item creation), and every item created by a call that then fails is
 *     soft-deleted again (never used, on no PO), so no hidden "Expected"
 *     item is left behind and none keeps a plan-cap slot; a shortfall
 *     (RLS hiding or refusing some of them) is reported, never silent;
 *   - the function's refusals map onto the service's existing messages.
 */

const { invCreate, reportError, invalidate } = vi.hoisted(() => ({
  invCreate: vi.fn(),
  reportError: vi.fn(async () => undefined),
  invalidate: vi.fn(),
}));

const WH = 'aaaaaaaa-0000-4000-8000-000000000001';

vi.mock('@/lib/auth/warehouse', () => ({
  getWarehouseAccess: vi.fn(async () => ({
    readableIds: [WH],
    writableIds: [WH],
    hasAllAccess: true,
    primaryWarehouseId: WH,
  })),
  assertWarehouseAccess: vi.fn(),
  forcedWarehouseId: vi.fn(async () => null),
  ForbiddenError: class ForbiddenError extends Error {
    readonly code = 'forbidden' as const;
  },
}));
vi.mock('./audit', () => ({
  audit: vi.fn(async () => {}),
  auditMany: vi.fn(async (rows: readonly unknown[]) => ({ written: rows.length, lost: 0 })),
}));
vi.mock('./integration-events', () => ({ dispatchEvent: vi.fn(async () => undefined) }));
vi.mock('@/lib/error-reporter', () => ({ reportError }));
vi.mock('./lib/inventory-list-cache', () => ({ invalidateInventoryListAfterWrite: invalidate }));
vi.mock('./notifications', () => ({ createNotification: vi.fn(async () => 'n') }));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          in: () => ({ not: () => ({ is: async () => ({ data: [], error: null }) }) }),
        }),
      }),
    }),
  }),
}));
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

import { auditMany } from './audit';
import { ServiceError } from './context';
import { PurchaseOrdersService } from './purchase-orders';

const PO_ID = 'po-draft-1';
const DRAFT_PO = {
  id: PO_ID,
  po_number: 'PO-001',
  status: 'draft',
  total: 20,
  subtotal: 20,
  supplier_id: null,
  destination_location_id: null,
  charter_id: null,
  expected_at: null,
  notes: null,
  destination: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  let n = 0;
  invCreate.mockImplementation(async () => ({ id: `custom-${++n}` }));
});

function inList(call: MockCall, column: string): string[] {
  return (inFilters(call).find(([c]) => c === column)?.[1] ?? []) as string[];
}

function saveCalls(stub: ReturnType<typeof makeSupabaseStub>) {
  return stub.rpcCalls.filter((c) => c.name === 'save_purchase_order_draft');
}

function expectNoDirectPoWrites(stub: ReturnType<typeof makeSupabaseStub>) {
  for (const key of [
    'purchase_orders.insert',
    'purchase_orders.update',
    'purchase_order_items.insert',
    'purchase_order_items.delete',
  ]) {
    expect(stub.chainsAll.get(key), key).toBeUndefined();
  }
}

/** The ids the compensation soft-deleted (the `.in('id', …)` of the delete). */
function discardedIds(stub: ReturnType<typeof makeSupabaseStub>): string[] {
  const writes = stub.chainsAll.get('inventory_items.update') ?? [];
  const args = stub.chainArgsAll.get('inventory_items.update') ?? [];
  return writes.flatMap((methods, i) => {
    const call: MockCall = { table: 'inventory_items', op: 'update', methods, args: args[i]! };
    const payload = args[i]?.[0]?.[0] as Record<string, unknown>;
    // A soft delete by this user, never a status flip (an archived item
    // still holds a plan-cap slot and shows under Expected).
    expect(Object.keys(payload).sort()).toEqual(['deleted_at', 'deleted_by', 'updated_by']);
    expect(payload.deleted_by).toBe('user-test');
    expect(typeof payload.deleted_at).toBe('string');
    return inList(call, 'id');
  });
}

/** The filters of the Nth compensation delete, as [method, args] pairs. */
function discardFilters(stub: ReturnType<typeof makeSupabaseStub>, n = 0): Array<[string, unknown[]]> {
  const methods = stub.chainsAll.get('inventory_items.update')?.[n] ?? [];
  const args = stub.chainArgsAll.get('inventory_items.update')?.[n] ?? [];
  return methods.map((m, i) => [m, args[i]!]);
}

function reportedTags(): string[] {
  return reportError.mock.calls.map((c) => (c as unknown as [Error, { tag: string }])[1].tag);
}

/**
 * A stub where the save fails with `saveError` and the compensation sees the
 * created items as active, zero on hand, not deleted (candidates) and on the
 * PO lines `keepLines` (the keep-check).
 */
function failingSaveStub(
  saveError: { code?: string; hint?: string; message: string },
  opts: { keepLines?: Array<Record<string, unknown>>; extra?: Record<string, unknown> } = {},
) {
  return makeSupabaseStub({
    'purchase_orders.select': { data: DRAFT_PO, error: null },
    'rpc:next_po_number': { data: 'PO-NEW', error: null },
    'rpc:save_purchase_order_draft': { data: null, error: saveError },
    // Candidate read by id: every requested id is still a fresh custom item.
    'inventory_items.select': (call: MockCall) => ({
      data: inList(call, 'id').map((id) => ({ id, name: `Item ${id}` })),
      error: null,
    }),
    'purchase_order_items.select': (call: MockCall) => {
      // get()'s own line read has no .in(); the keep-check does.
      if (inList(call, 'item_id').length === 0) return { data: [], error: null };
      return { data: opts.keepLines ?? [], error: null };
    },
    'inventory_items.update': (call: MockCall) => ({
      data: inList(call, 'id').map((id) => ({ id, name: `Item ${id}` })),
      error: null,
    }),
    ...(opts.extra ?? {}),
  });
}

describe('create() — one transaction', () => {
  it('writes the PO only through save_purchase_order_draft (no direct header or line insert)', async () => {
    const stub = makeSupabaseStub({
      'rpc:next_po_number': { data: 'PO-7', error: null },
      'rpc:save_purchase_order_draft': {
        data: { id: 'po-new', stamped: 1, stamp_error: null },
        error: null,
      },
    });
    const svc = new PurchaseOrdersService(makeServiceContext(stub.client) as never);

    const res = await svc.create({
      lines: [
        { itemId: 'item-1', quantityOrdered: 2, unitCost: 3 },
        { newItemName: 'Widget', quantityOrdered: 1, unitCost: 4 },
      ],
    });

    expect(res).toEqual({ id: 'po-new', poNumber: 'PO-7' });
    expect(saveCalls(stub)).toHaveLength(1);
    expect(saveCalls(stub)[0]!.args).toMatchObject({
      p_po_id: null,
      p_lines: [
        { item_id: 'item-1', quantity_ordered: 2, unit_cost: 3 },
        { item_id: 'custom-1', quantity_ordered: 1, unit_cost: 4 },
      ],
      p_custom_item_ids: ['custom-1'],
    });
    expectNoDirectPoWrites(stub);
    expect(stub.chainsAll.get('inventory_items.update')).toBeUndefined();
  });

  it('rejects when the save fails, and soft-deletes the custom items this call created', async () => {
    const stub = failingSaveStub({ code: '42501', message: 'new row violates row-level security policy' });
    const svc = new PurchaseOrdersService(makeServiceContext(stub.client) as never);

    const thrown = await svc
      .create({
        lines: [
          { newItemName: 'One', quantityOrdered: 1, unitCost: 1 },
          { newItemName: 'Two', quantityOrdered: 1, unitCost: 1 },
        ],
      })
      .catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(ServiceError);
    expect((thrown as ServiceError).code).toBe('internal_error');
    expect(discardedIds(stub)).toEqual(['custom-1', 'custom-2']);
    // Only the untouched item this save created: still active, nothing on
    // hand, still awaiting its first receipt, not already deleted. The
    // candidate read and the delete both say so (a read without the awaiting
    // filter would count a just-received item as a delete shortfall).
    const untouched = [
      ['eq', ['status', 'active']],
      ['eq', ['quantity_on_hand', 0]],
      ['eq', ['awaiting_first_receipt', true]],
      ['is', ['deleted_at', null]],
    ];
    expect(discardFilters(stub)).toEqual(expect.arrayContaining(untouched));
    const candidateRead = (stub.chainsAll.get('inventory_items.select') ?? []).map((methods, i) =>
      methods.map((m, j) => [m, stub.chainArgsAll.get('inventory_items.select')![i]![j]]),
    );
    expect(candidateRead).toHaveLength(1);
    expect(candidateRead[0]).toEqual(expect.arrayContaining(untouched));
    const audits = vi
      .mocked(auditMany)
      .mock.calls.flatMap((c) => [...c[0]] as Array<{ event: string; extra?: unknown }>);
    expect(audits.map((a) => [a.event, a.extra])).toEqual([
      ['inventory.item.deleted', { reason: 'po_save_failed', purchaseOrderId: null, itemName: 'Item custom-1' }],
      ['inventory.item.deleted', { reason: 'po_save_failed', purchaseOrderId: null, itemName: 'Item custom-2' }],
    ]);
    expect(reportedTags().filter((t) => t.endsWith('.shortfall'))).toEqual([]);
    expectNoDirectPoWrites(stub);
  });

  it('reports a shortfall when RLS hides some of the items this save created (never silent)', async () => {
    // A category-restricted caller cannot read category-less items: the
    // candidate read returns one of the two ids.
    const stub = failingSaveStub(
      { code: '42501', message: 'new row violates row-level security policy' },
      {
        extra: {
          'inventory_items.select': { data: [{ id: 'custom-1', name: 'Item custom-1' }], error: null },
        },
      },
    );
    const svc = new PurchaseOrdersService(makeServiceContext(stub.client) as never);

    await svc
      .create({
        lines: [
          { newItemName: 'One', quantityOrdered: 1, unitCost: 1 },
          { newItemName: 'Two', quantityOrdered: 1, unitCost: 1 },
        ],
      })
      .catch(() => undefined);

    expect(discardedIds(stub)).toEqual(['custom-1']);
    const shortfall = reportError.mock.calls.find(
      (c) => (c as unknown as [Error, { tag: string }])[1].tag === 'po.create.rollback_custom_items.shortfall',
    ) as unknown as [Error, { extra: unknown }] | undefined;
    expect(shortfall?.[1].extra).toEqual({ created: 2, readable: 1 });
  });

  it('reports a shortfall when the delete matches fewer rows than asked (RLS refusing the UPDATE)', async () => {
    // items:create without items:update: the UPDATE runs, matches 0 rows and
    // returns no error. That must not look like success.
    const stub = failingSaveStub(
      { code: '42501', message: 'new row violates row-level security policy' },
      { extra: { 'inventory_items.update': { data: [], error: null } } },
    );
    const svc = new PurchaseOrdersService(makeServiceContext(stub.client) as never);

    await svc
      .create({ lines: [{ newItemName: 'One', quantityOrdered: 1, unitCost: 1 }] })
      .catch(() => undefined);

    const shortfall = reportError.mock.calls.find(
      (c) => (c as unknown as [Error, { tag: string }])[1].tag === 'po.create.rollback_custom_items.shortfall',
    ) as unknown as [Error, { extra: unknown }] | undefined;
    expect(shortfall?.[1].extra).toEqual({ expected: 1, written: 0 });
    expect(vi.mocked(auditMany)).not.toHaveBeenCalled();
  });

  it('plan_limit_exceeded on the 2nd custom line: deletes the 1st and never calls the save', async () => {
    invCreate
      .mockImplementationOnce(async () => ({ id: 'custom-1' }))
      .mockImplementationOnce(async () => {
        throw new ServiceError('plan_limit_exceeded', 'Your plan allows 100 items.');
      });
    const stub = failingSaveStub({ message: 'unused' });
    const svc = new PurchaseOrdersService(makeServiceContext(stub.client) as never);

    const thrown = await svc
      .create({
        lines: [
          { newItemName: 'One', quantityOrdered: 1, unitCost: 1 },
          { newItemName: 'Two', quantityOrdered: 1, unitCost: 1 },
        ],
      })
      .catch((e: unknown) => e);

    expect((thrown as ServiceError).code).toBe('plan_limit_exceeded');
    expect(saveCalls(stub)).toHaveLength(0);
    expect(discardedIds(stub)).toEqual(['custom-1']);
    expectNoDirectPoWrites(stub);
  });

  it('keeps a created item that is on a live PO line (the save committed, only its answer was lost)', async () => {
    const stub = failingSaveStub(
      { message: 'fetch failed' },
      { keepLines: [{ item_id: 'custom-1', quantity_received: 0, po: { status: 'draft' } }] },
    );
    const svc = new PurchaseOrdersService(makeServiceContext(stub.client) as never);

    await svc
      .create({ lines: [{ newItemName: 'One', quantityOrdered: 1, unitCost: 1 }] })
      .catch(() => undefined);

    expect(discardedIds(stub)).toEqual([]);
  });

  it('a failing compensation never replaces the original error', async () => {
    const stub = failingSaveStub(
      { code: '23505', message: 'duplicate key value violates unique constraint' },
      { extra: { 'inventory_items.select': { data: null, error: { message: 'read timeout' } } } },
    );
    const svc = new PurchaseOrdersService(makeServiceContext(stub.client) as never);

    const thrown = await svc
      .create({ lines: [{ newItemName: 'One', quantityOrdered: 1, unitCost: 1 }] })
      .catch((e: unknown) => e);

    expect((thrown as ServiceError).code).toBe('conflict');
    expect((thrown as ServiceError).message).toBe('That PO number is already in use.');
    expect(discardedIds(stub)).toEqual([]);
    expect(reportedTags()).toContain('po.create.rollback_custom_items.candidates');
  });

  it('checks the supplier BEFORE creating any custom item (a foreign supplier leaves nothing behind)', async () => {
    const stub = failingSaveStub(
      { message: 'unused' },
      { extra: { 'suppliers.select': { data: null, error: null } } },
    );
    const svc = new PurchaseOrdersService(makeServiceContext(stub.client) as never);

    const thrown = await svc
      .create({
        supplierId: 'bbbbbbbb-0000-4000-8000-000000000009',
        lines: [{ newItemName: 'One', quantityOrdered: 1, unitCost: 1 }],
      })
      .catch((e: unknown) => e);

    expect((thrown as ServiceError).code).toBe('validation_error');
    expect(invCreate).not.toHaveBeenCalled();
    expect(saveCalls(stub)).toHaveLength(0);
  });
});

describe('update() — one transaction', () => {
  it('a failing custom-item create makes no save call and no header write', async () => {
    invCreate
      .mockImplementationOnce(async () => ({ id: 'custom-1' }))
      .mockImplementationOnce(async () => {
        throw new ServiceError('forbidden', 'You cannot create items.');
      });
    const stub = failingSaveStub({ message: 'unused' });
    const svc = new PurchaseOrdersService(makeServiceContext(stub.client) as never);

    const thrown = await svc
      .update(PO_ID, {
        supplierId: null,
        lines: [
          { newItemName: 'One', quantityOrdered: 1, unitCost: 1 },
          { newItemName: 'Two', quantityOrdered: 1, unitCost: 1 },
        ],
      })
      .catch((e: unknown) => e);

    expect((thrown as ServiceError).code).toBe('forbidden');
    expect(saveCalls(stub)).toHaveLength(0);
    expectNoDirectPoWrites(stub);
    expect(discardedIds(stub)).toEqual(['custom-1']);
  });

  it('saves header and every line in the one call, as an edit of this PO', async () => {
    const stub = makeSupabaseStub({
      'purchase_orders.select': { data: DRAFT_PO, error: null },
      'purchase_order_items.select': { data: [], error: null },
      'rpc:save_purchase_order_draft': { data: { id: PO_ID, stamped: 0, stamp_error: null }, error: null },
    });
    const svc = new PurchaseOrdersService(
      makeServiceContext(stub.client, { userId: 'user-editor' }) as never,
    );

    await svc.update(PO_ID, {
      notes: 'new notes',
      lines: [{ itemId: 'item-1', quantityOrdered: 5, unitCost: 2 }],
    });

    expect(saveCalls(stub)).toHaveLength(1);
    expect(saveCalls(stub)[0]!.args).toMatchObject({
      p_org_id: 'org-test',
      p_po_id: PO_ID,
      p_po_number: 'PO-001',
      p_notes: 'new notes',
      p_lines: [{ item_id: 'item-1', quantity_ordered: 5, unit_cost: 2 }],
      p_custom_item_ids: [],
      p_actor: 'user-editor',
    });
    expectNoDirectPoWrites(stub);
  });
});

describe('save_purchase_order_draft refusals map onto the service messages', () => {
  const cases: Array<{
    name: string;
    error: { code?: string; hint?: string; message: string };
    code: ServiceError['code'];
    message?: string;
  }> = [
    {
      name: '23505 (PO number taken)',
      error: { code: '23505', message: 'duplicate key value violates unique constraint' },
      code: 'conflict',
      message: 'That PO number is already in use.',
    },
    {
      name: '55000 / po_not_draft',
      error: { code: '55000', hint: 'po_not_draft', message: 'x' },
      code: 'conflict',
      message: 'This purchase order is no longer a draft (it may have just been ordered).',
    },
    {
      // Header-then-lines (the save) against lines-then-header (an old tab's
      // direct line DELETE): Postgres aborts one; PostgREST does not retry it.
      name: '40P01 (deadlock with a concurrent edit)',
      error: { code: '40P01', hint: 'See server log for query details.', message: 'deadlock detected' },
      code: 'conflict',
      message: 'This purchase order was changed at the same time. Reload it and try again.',
    },
    {
      name: '55P03 (lock not available)',
      error: { code: '55P03', message: 'canceling statement due to lock timeout' },
      code: 'conflict',
      message: 'This purchase order was changed at the same time. Reload it and try again.',
    },
    {
      name: 'po_not_found',
      error: { code: 'P0002', hint: 'po_not_found', message: 'Purchase order not found.' },
      code: 'not_found',
    },
    {
      name: 'po_line_invalid',
      error: {
        code: '22023',
        hint: 'po_line_invalid',
        message: 'Each line needs an item, a quantity above 0 and a cost of 0 or more.',
      },
      code: 'validation_error',
      message: 'Each line needs an item, a quantity above 0 and a cost of 0 or more.',
    },
    {
      name: 'po_not_in_org',
      error: { code: '42501', hint: 'po_not_in_org', message: 'not part of this organization.' },
      code: 'validation_error',
    },
    {
      name: 'an unmarked RLS refusal',
      error: { code: '42501', message: 'new row violates row-level security policy' },
      code: 'internal_error',
    },
  ];

  for (const c of cases) {
    it(`create(): ${c.name} -> ${c.code}`, async () => {
      const stub = failingSaveStub(c.error);
      const svc = new PurchaseOrdersService(makeServiceContext(stub.client) as never);
      const thrown = await svc
        .create({ lines: [{ itemId: 'item-1', quantityOrdered: 1, unitCost: 1 }] })
        .catch((e: unknown) => e);
      expect(thrown).toBeInstanceOf(ServiceError);
      expect((thrown as ServiceError).code).toBe(c.code);
      if (c.message) expect((thrown as ServiceError).message).toBe(c.message);
    });

    it(`update(): ${c.name} -> ${c.code}`, async () => {
      const stub = failingSaveStub(c.error);
      const svc = new PurchaseOrdersService(makeServiceContext(stub.client) as never);
      const thrown = await svc
        .update(PO_ID, { lines: [{ itemId: 'item-1', quantityOrdered: 1, unitCost: 1 }] })
        .catch((e: unknown) => e);
      expect(thrown).toBeInstanceOf(ServiceError);
      expect((thrown as ServiceError).code).toBe(c.code);
      if (c.message) expect((thrown as ServiceError).message).toBe(c.message);
    });
  }
});
