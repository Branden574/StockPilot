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
  requireOrgContext: vi.fn(async () => ({ userId: 'user-test', organizationId: 'org-test', role: 'admin' })),
}));

const { mockAudit: _mockAudit } = vi.hoisted(() => ({ mockAudit: vi.fn(async () => {}) }));
vi.mock('./audit', () => ({ audit: _mockAudit }));
vi.mock('./integration-events', () => ({ dispatchEvent: vi.fn(async () => {}) }));
vi.mock('./item-images', () => ({
  ItemImagesService: class {
    async primaryImagesForItems() {
      return new Map<string, string>();
    }
  },
}));

const mockAudit = _mockAudit;

import { ServiceError } from './context';
import { PurchaseOrdersService } from './purchase-orders';

const PO_ID = 'po-notes-id';

/** get() reads the header (one purchase_orders.select) then the lines. */
function makeNotesStub(
  opts: { po?: Record<string, unknown>; update?: { data: unknown; error: { message: string; code?: string } | null } } = {},
) {
  const po = opts.po ?? { id: PO_ID, status: 'received', notes: 'old note', destination: null };
  return makeSupabaseStub({
    'purchase_orders.select': { data: po, error: null },
    'purchase_order_items.select': { data: [], error: null },
    'purchase_orders.update': opts.update ?? { data: { id: PO_ID }, error: null },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('PurchaseOrdersService.updateNotes', () => {
  it('updates notes on a RECEIVED PO (not just drafts) and audits the change', async () => {
    const stub = makeNotesStub({ po: { id: PO_ID, status: 'received', notes: 'old', destination: null } });
    const svc = new PurchaseOrdersService(makeServiceContext(stub.client) as never);

    const result = await svc.updateNotes(PO_ID, '  Backorder ETA next week  ');

    expect(result).toEqual({ id: PO_ID });
    const payload = stub.chainArgs.get('purchase_orders.update')?.[0]?.[0] as Record<string, unknown>;
    expect(payload?.notes).toBe('Backorder ETA next week'); // trimmed
    // org + id scoped write.
    const updArgs = (stub.chainArgsAll.get('purchase_orders.update') ?? []).flat(Infinity);
    expect(updArgs).toContain('organization_id');
    expect(updArgs).toContain('org-test');
    // Audited as a notes update.
    const call = (mockAudit.mock.calls[0] as unknown as [Record<string, unknown>])?.[0];
    expect(call?.event).toBe('purchase_order.updated');
    expect((call?.after as Record<string, unknown>)?.notesUpdated).toBe(true);
  });

  it('clears notes to null when given an empty/whitespace string', async () => {
    const stub = makeNotesStub({ po: { id: PO_ID, status: 'ordered', notes: 'remove me', destination: null } });
    const svc = new PurchaseOrdersService(makeServiceContext(stub.client) as never);

    await svc.updateNotes(PO_ID, '   ');
    const payload = stub.chainArgs.get('purchase_orders.update')?.[0]?.[0] as Record<string, unknown>;
    expect(payload?.notes).toBeNull();
  });

  it('rejects notes over 2000 chars before any write', async () => {
    const stub = makeNotesStub();
    const svc = new PurchaseOrdersService(makeServiceContext(stub.client) as never);

    const thrown = await svc.updateNotes(PO_ID, 'x'.repeat(2001)).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(ServiceError);
    expect((thrown as ServiceError).code).toBe('validation_error');
    expect(stub.chainsAll.get('purchase_orders.update')).toBeUndefined();
  });

  it('fails closed (not_found) when the PO is gone (0-row update)', async () => {
    const stub = makeNotesStub({ update: { data: null, error: null } });
    const svc = new PurchaseOrdersService(makeServiceContext(stub.client) as never);

    const thrown = await svc.updateNotes(PO_ID, 'note').catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(ServiceError);
    expect((thrown as ServiceError).code).toBe('not_found');
    expect(mockAudit).not.toHaveBeenCalled();
  });
});
