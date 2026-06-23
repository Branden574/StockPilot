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

describe('PurchaseOrdersService.updateStatus — cancelled is terminal', () => {
  /** A visible CANCELLED PO. */
  function cancelledStub() {
    return makeSupabaseStub({
      'purchase_orders.select': {
        data: { id: 'po-1', po_number: 'MLA-001071', status: 'cancelled', total: 0, destination: null },
        error: null,
      },
      'purchase_order_items.select': { data: [], error: null },
      'purchase_orders.update': { data: { id: 'po-1' }, error: null },
    });
  }

  for (const target of ['draft', 'ordered'] as const) {
    it(`refuses to reopen a cancelled PO (→ ${target}) — its number may be reissued`, async () => {
      const stub = cancelledStub();
      const svc = new PurchaseOrdersService(makeServiceContext(stub.client) as never);
      const err = await svc.updateStatus('po-1', target).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ServiceError);
      expect((err as ServiceError).code).toBe('conflict');
      expect((err as ServiceError).message).toMatch(/cancelled.*cannot be reopened/i);
      // The terminal guard fires BEFORE any write.
      expect(stub.chainsAll.get('purchase_orders.update')).toBeUndefined();
    });
  }

  it('still allows a no-op re-cancel of an already-cancelled PO', async () => {
    const stub = cancelledStub();
    const svc = new PurchaseOrdersService(makeServiceContext(stub.client) as never);
    await svc.updateStatus('po-1', 'cancelled');
    expect(stub.chainsAll.get('purchase_orders.update')).toBeDefined();
  });

  it('maps a residual partial-index 23505 to a clean conflict (not internal_error)', async () => {
    const stub = makeSupabaseStub({
      'purchase_orders.select': {
        data: { id: 'po-1', po_number: 'X', status: 'draft', total: 0, destination: null },
        error: null,
      },
      'purchase_order_items.select': { data: [], error: null },
      'purchase_orders.update': {
        data: null,
        error: { code: '23505', message: 'duplicate key value violates unique constraint "purchase_orders_org_ponumber_active_key"' },
      },
    });
    const svc = new PurchaseOrdersService(makeServiceContext(stub.client) as never);
    const err = await svc.updateStatus('po-1', 'draft').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).code).toBe('conflict');
    expect((err as ServiceError).message).not.toMatch(/duplicate key/i);
  });
});

describe('PurchaseOrdersService.updateStatus — cancel cleans up auto-created items', () => {
  function cancelStub(opts: {
    candidates: Array<{ id: string; name: string }>;
    /** Rows the purchase_order_items lookup returns (item_id, quantity_received, po.status). */
    poLines?: Array<Record<string, unknown>>;
  }) {
    return makeSupabaseStub({
      'purchase_orders.select': {
        data: { id: 'po-1', po_number: 'PO-1', status: 'ordered', total: 0, destination: null },
        error: null,
      },
      'purchase_order_items.select': { data: opts.poLines ?? [], error: null },
      'purchase_orders.update': { data: { id: 'po-1' }, error: null },
      'inventory_items.select': { data: opts.candidates, error: null },
      'inventory_items.update': { data: opts.candidates, error: null },
    });
  }

  it('archives the unused custom items the PO created when it is cancelled', async () => {
    const stub = cancelStub({ candidates: [{ id: 'item-x', name: 'Foldable Tote' }] });
    const svc = new PurchaseOrdersService(makeServiceContext(stub.client) as never);

    await svc.updateStatus('po-1', 'cancelled');

    // The orphaned custom item was archived (status -> 'archived').
    const updArgs = stub.chainArgs.get('inventory_items.update');
    const payload = updArgs?.[0]?.[0] as Record<string, unknown> | undefined;
    expect(payload?.status).toBe('archived');
  });

  it('does NOT touch items when the PO auto-created none', async () => {
    const stub = cancelStub({ candidates: [] });
    const svc = new PurchaseOrdersService(makeServiceContext(stub.client) as never);

    await svc.updateStatus('po-1', 'cancelled');

    expect(stub.chainsAll.get('inventory_items.update')).toBeUndefined();
    // The PO itself was still cancelled.
    expect(stub.chainsAll.get('purchase_orders.update')).toBeDefined();
  });

  it('does NOT archive a custom item that received stock on this PO (qoh later drawn to 0)', async () => {
    // qoh=0 but quantity_received>0 means it was received then consumed — it has
    // real receipt/cost history and must stay visible, not be archived.
    const stub = cancelStub({
      candidates: [{ id: 'item-x', name: 'Foldable Tote' }],
      poLines: [{ item_id: 'item-x', quantity_received: 5, po: { status: 'cancelled' } }],
    });
    const svc = new PurchaseOrdersService(makeServiceContext(stub.client) as never);

    await svc.updateStatus('po-1', 'cancelled');

    expect(stub.chainsAll.get('inventory_items.update')).toBeUndefined();
  });

  it('does NOT archive a custom item still referenced by another non-cancelled PO', async () => {
    const stub = cancelStub({
      candidates: [{ id: 'item-x', name: 'Foldable Tote' }],
      poLines: [{ item_id: 'item-x', quantity_received: 0, po: { status: 'ordered' } }],
    });
    const svc = new PurchaseOrdersService(makeServiceContext(stub.client) as never);

    await svc.updateStatus('po-1', 'cancelled');

    expect(stub.chainsAll.get('inventory_items.update')).toBeUndefined();
  });
});
