import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

// Full warehouse access — these tests cover the approval-threshold gate in
// updateStatus, not warehouse scoping.
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

vi.mock('./audit', () => ({ audit: vi.fn(async () => {}) }));

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

/** Stub: one visible PO (no destination → no warehouse gate) + module settings. */
function stubFor(opts: {
  total: number;
  settings: Record<string, unknown> | null;
  settingsError?: string;
}) {
  return makeSupabaseStub({
    'purchase_orders.select': {
      data: { id: 'po-1', po_number: 'PO-1', status: 'draft', total: opts.total, destination: null },
      error: null,
    },
    'purchase_order_items.select': { data: [], error: null },
    'organization_modules.select': opts.settingsError
      ? { data: null, error: { message: opts.settingsError } }
      : { data: opts.settings === null ? null : { settings: opts.settings }, error: null },
    // updateStatus now appends .select('id').maybeSingle() and fails closed on a
    // 0-row update — return a row so the happy-path transitions still succeed.
    'purchase_orders.update': { data: { id: 'po-1' }, error: null },
    'rpc:publish_outbox': { data: null, error: null },
  });
}

describe('PurchaseOrdersService.updateStatus — approval threshold', () => {
  it('blocks a manager from placing a PO at/above the threshold', async () => {
    const stub = stubFor({ total: 750, settings: { approvalThresholdAmount: 500 } });
    const svc = new PurchaseOrdersService(makeServiceContext(stub.client, { role: 'manager' }) as never);
    const err = await svc.updateStatus('po-1', 'ordered').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).code).toBe('forbidden');
    expect((err as ServiceError).message).toMatch(/approval threshold/i);
    // The status write must never have happened.
    expect(stub.chainsAll.get('purchase_orders.update')).toBeUndefined();
  });

  it('blocks exactly AT the threshold (>= semantics)', async () => {
    const stub = stubFor({ total: 500, settings: { approvalThresholdAmount: 500 } });
    const svc = new PurchaseOrdersService(makeServiceContext(stub.client, { role: 'manager' }) as never);
    const err = await svc.updateStatus('po-1', 'ordered').catch((e: unknown) => e);
    expect((err as ServiceError).code).toBe('forbidden');
  });

  it('lets a manager place a PO below the threshold', async () => {
    const stub = stubFor({ total: 100, settings: { approvalThresholdAmount: 500 } });
    const svc = new PurchaseOrdersService(makeServiceContext(stub.client, { role: 'manager' }) as never);
    await svc.updateStatus('po-1', 'ordered');
    expect(stub.chainsAll.get('purchase_orders.update')).toBeDefined();
    expect(stub.rpcCalls.some((c) => c.name === 'publish_outbox')).toBe(true);
  });

  it('lets an admin place a PO above the threshold (no settings read needed)', async () => {
    const stub = stubFor({ total: 9999, settings: { approvalThresholdAmount: 500 } });
    const svc = new PurchaseOrdersService(makeServiceContext(stub.client, { role: 'admin' }) as never);
    await svc.updateStatus('po-1', 'ordered');
    expect(stub.chainsAll.get('purchase_orders.update')).toBeDefined();
    // Admin path short-circuits before touching organization_modules.
    expect(stub.fromCalls.filter((t) => t === 'organization_modules')).toHaveLength(0);
  });

  it('no threshold configured (absent / 0) → manager can place any size', async () => {
    for (const settings of [null, {}, { approvalThresholdAmount: 0 }]) {
      const stub = stubFor({ total: 50_000, settings: settings as Record<string, unknown> | null });
      const svc = new PurchaseOrdersService(
        makeServiceContext(stub.client, { role: 'manager' }) as never,
      );
      await svc.updateStatus('po-1', 'ordered');
      expect(stub.chainsAll.get('purchase_orders.update')).toBeDefined();
    }
  });

  it('FAILS CLOSED: a settings read error blocks the transition', async () => {
    const stub = stubFor({ total: 750, settings: null, settingsError: 'transient' });
    const svc = new PurchaseOrdersService(makeServiceContext(stub.client, { role: 'manager' }) as never);
    const err = await svc.updateStatus('po-1', 'ordered').catch((e: unknown) => e);
    expect((err as ServiceError).code).toBe('internal_error');
    expect(stub.chainsAll.get('purchase_orders.update')).toBeUndefined();
  });

  it('only gates the ordered transition — cancelling an above-threshold PO is fine', async () => {
    const stub = stubFor({ total: 750, settings: { approvalThresholdAmount: 500 } });
    const svc = new PurchaseOrdersService(makeServiceContext(stub.client, { role: 'manager' }) as never);
    await svc.updateStatus('po-1', 'cancelled');
    expect(stub.chainsAll.get('purchase_orders.update')).toBeDefined();
  });
});
