import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

// Full warehouse access — these tests cover create() PO number logic,
// not warehouse scoping.
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

import { ServiceError } from './context';
import { PurchaseOrdersService } from './purchase-orders';

beforeEach(() => {
  vi.clearAllMocks();
});

const MINIMAL_LINE = [{ itemId: 'item-uuid-1', quantityOrdered: 2, unitCost: 10 }];

describe('PurchaseOrdersService.create — PO number handling', () => {
  it('uses the supplied poNumber and does NOT call next_po_number RPC', async () => {
    const stub = makeSupabaseStub({
      'purchase_orders.insert': { data: [{ id: 'po-new' }], error: null },
      'purchase_order_items.insert': { data: null, error: null },
      'rpc:next_po_number': { data: 'PO-AUTO-999', error: null },
    });
    const svc = new PurchaseOrdersService(makeServiceContext(stub.client) as never);

    const result = await svc.create({ lines: MINIMAL_LINE, poNumber: 'MY-CUSTOM-PO-42' });

    expect(result.poNumber).toBe('MY-CUSTOM-PO-42');
    // next_po_number must NOT have been called when a custom number is supplied.
    expect(stub.rpcCalls.some((c) => c.name === 'next_po_number')).toBe(false);
    // The insert payload must carry the custom po_number.
    const insertArgs = stub.chainArgs.get('purchase_orders.insert');
    const insertPayload = insertArgs?.[0]?.[0] as Record<string, unknown> | undefined;
    expect(insertPayload?.po_number).toBe('MY-CUSTOM-PO-42');
  });

  it('auto-generates via next_po_number RPC when poNumber is omitted', async () => {
    const stub = makeSupabaseStub({
      'purchase_orders.insert': { data: [{ id: 'po-new' }], error: null },
      'purchase_order_items.insert': { data: null, error: null },
      'rpc:next_po_number': { data: 'PO-007', error: null },
    });
    const svc = new PurchaseOrdersService(makeServiceContext(stub.client) as never);

    const result = await svc.create({ lines: MINIMAL_LINE });

    expect(result.poNumber).toBe('PO-007');
    // RPC must have been called exactly once.
    expect(stub.rpcCalls.filter((c) => c.name === 'next_po_number')).toHaveLength(1);
    const insertArgs = stub.chainArgs.get('purchase_orders.insert');
    const insertPayload = insertArgs?.[0]?.[0] as Record<string, unknown> | undefined;
    expect(insertPayload?.po_number).toBe('PO-007');
  });

  it('duplicate poNumber (23505 constraint violation) throws conflict ServiceError', async () => {
    const stub = makeSupabaseStub({
      // Mock the insert to return a Postgres unique-constraint violation.
      'purchase_orders.insert': {
        data: null,
        error: { code: '23505', message: 'unique constraint "purchase_orders_organization_id_po_number_key"' },
      },
      'purchase_order_items.insert': { data: null, error: null },
    });
    const svc = new PurchaseOrdersService(makeServiceContext(stub.client) as never);

    const thrown = await svc
      .create({ lines: MINIMAL_LINE, poNumber: 'DUPLICATE-PO' })
      .catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(ServiceError);
    expect((thrown as ServiceError).code).toBe('conflict');
    expect((thrown as ServiceError).message).toBe('That PO number is already in use.');
    // The purchase_order_items insert must NOT have been attempted.
    expect(stub.chainsAll.get('purchase_order_items.insert')).toBeUndefined();
  });
});
