import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

const WH_UUID = 'aaaaaaaa-0000-0000-0000-000000000001' as const;

// PO rename only touches purchase_orders + audit. Mock the satellites the
// constructor / get() path pulls in so the suite stays hermetic.
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

const PO_ID = 'po-rename-id';
const BASE_PO = {
  id: PO_ID,
  po_number: 'PO-001',
  status: 'ordered',
  total: 20,
  subtotal: 20,
  supplier_id: null,
  destination_location_id: null,
  expected_at: null,
  notes: null,
  destination: null,
};

/**
 * The rename path issues two purchase_orders.select calls that share one stub
 * key: (1) get() reading the header, (2) the uniqueness pre-check. The stub
 * supports a function result called once per query, so a counter lets the
 * header resolve to the PO while the pre-check resolves to "no conflicting row".
 */
function makeRenameStub(opts: {
  po?: Record<string, unknown>;
  /** Row the uniqueness pre-check finds (truthy → conflict). Default: none. */
  conflictRow?: Record<string, unknown> | null;
  /** Override the header UPDATE result (e.g. inject a 23505 or 0-rows). */
  update?: { data: unknown; error: { message: string; code?: string } | null };
} = {}) {
  const po = opts.po ?? BASE_PO;
  let selectCall = 0;
  return makeSupabaseStub({
    'purchase_orders.select': () => {
      selectCall += 1;
      // 1st select = get() header; 2nd select = uniqueness pre-check.
      return selectCall === 1
        ? { data: po, error: null }
        : { data: opts.conflictRow ?? null, error: null };
    },
    'purchase_orders.update': opts.update ?? { data: { id: PO_ID }, error: null },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── Happy path ──────────────────────────────────────────────────────────────

describe('PurchaseOrdersService.renamePoNumber — happy path', () => {
  it('renames a non-cancelled PO, updates po_number, and audits the rename', async () => {
    const stub = makeRenameStub();
    const svc = new PurchaseOrdersService(makeServiceContext(stub.client) as never);

    const result = await svc.renamePoNumber(PO_ID, '  MLA-001071  ');

    // Trimmed value returned.
    expect(result).toEqual({ id: PO_ID, poNumber: 'MLA-001071' });

    // Header update carried the new number plus the cancelled-guard.
    const updateArgs = stub.chainArgs.get('purchase_orders.update');
    const payload = updateArgs?.[0]?.[0] as Record<string, unknown> | undefined;
    expect(payload?.po_number).toBe('MLA-001071');
    const updateChainArgs = (stub.chainArgsAll.get('purchase_orders.update') ?? []).flat(2);
    expect(updateChainArgs).toContain('cancelled'); // .neq('status','cancelled') guard

    // Audited as a rename.
    expect(mockAudit).toHaveBeenCalledTimes(1);
    const auditArg = (mockAudit.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(auditArg.event).toBe('purchase_order.updated');
    expect((auditArg.after as Record<string, unknown>).renamed).toBe(true);
    expect((auditArg.after as Record<string, unknown>).po_number).toBe('MLA-001071');
  });

  it('works regardless of status — an ordered/received PO can still be renamed', async () => {
    const stub = makeRenameStub({ po: { ...BASE_PO, status: 'received' } });
    const svc = new PurchaseOrdersService(makeServiceContext(stub.client) as never);

    const result = await svc.renamePoNumber(PO_ID, 'RECV-RENAME');
    expect(result.poNumber).toBe('RECV-RENAME');
    expect(stub.chainsAll.get('purchase_orders.update')).toBeDefined();
  });
});

// ─── No-op ─────────────────────────────────────────────────────────────────────

describe('PurchaseOrdersService.renamePoNumber — no-op', () => {
  it('returns early without a uniqueness check or UPDATE when the number is unchanged', async () => {
    const stub = makeRenameStub();
    const svc = new PurchaseOrdersService(makeServiceContext(stub.client) as never);

    const result = await svc.renamePoNumber(PO_ID, '  PO-001  '); // trims to current
    expect(result).toEqual({ id: PO_ID, poNumber: 'PO-001' });

    // Only ONE purchase_orders.select (the get()); pre-check skipped; no UPDATE.
    const allSelects = stub.chainsAll.get('purchase_orders.select') ?? [];
    expect(allSelects).toHaveLength(1);
    expect(stub.chainsAll.get('purchase_orders.update')).toBeUndefined();
    expect(mockAudit).not.toHaveBeenCalled();
  });
});

// ─── Validation ─────────────────────────────────────────────────────────────────

describe('PurchaseOrdersService.renamePoNumber — validation', () => {
  it('rejects a blank number before touching the DB', async () => {
    const stub = makeRenameStub();
    const svc = new PurchaseOrdersService(makeServiceContext(stub.client) as never);

    const thrown = await svc.renamePoNumber(PO_ID, '   ').catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(ServiceError);
    expect((thrown as ServiceError).code).toBe('validation_error');
    expect(stub.fromCalls).not.toContain('purchase_orders');
  });

  it('rejects an over-long number (>100 chars) before touching the DB', async () => {
    const stub = makeRenameStub();
    const svc = new PurchaseOrdersService(makeServiceContext(stub.client) as never);

    const thrown = await svc.renamePoNumber(PO_ID, 'X'.repeat(101)).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(ServiceError);
    expect((thrown as ServiceError).code).toBe('validation_error');
    expect(stub.fromCalls).not.toContain('purchase_orders');
  });
});

// ─── Cancelled is terminal ───────────────────────────────────────────────────

describe('PurchaseOrdersService.renamePoNumber — cancelled guard', () => {
  it('refuses to rename a cancelled PO (its number may already be reissued)', async () => {
    const stub = makeRenameStub({ po: { ...BASE_PO, status: 'cancelled' } });
    const svc = new PurchaseOrdersService(makeServiceContext(stub.client) as never);

    const thrown = await svc.renamePoNumber(PO_ID, 'NEW-NUMBER').catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(ServiceError);
    expect((thrown as ServiceError).code).toBe('conflict');
    expect((thrown as ServiceError).message).toMatch(/cancelled/i);
    // No UPDATE attempted.
    expect(stub.chainsAll.get('purchase_orders.update')).toBeUndefined();
  });
});

// ─── Uniqueness ──────────────────────────────────────────────────────────────

describe('PurchaseOrdersService.renamePoNumber — uniqueness', () => {
  it('raises conflict when the pre-check finds an existing PO with that number', async () => {
    const stub = makeRenameStub({ conflictRow: { id: 'other-po' } });
    const svc = new PurchaseOrdersService(makeServiceContext(stub.client) as never);

    const thrown = await svc.renamePoNumber(PO_ID, 'TAKEN-001').catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(ServiceError);
    expect((thrown as ServiceError).code).toBe('conflict');
    expect((thrown as ServiceError).message).toBe('That PO number is already in use.');
    // Pre-check excludes cancelled POs (those release their number).
    const preCheckArgs = (stub.chainArgsAll.get('purchase_orders.select') ?? []).flat(2);
    expect(preCheckArgs).toContain('cancelled');
    // No UPDATE after the conflict.
    expect(stub.chainsAll.get('purchase_orders.update')).toBeUndefined();
  });

  it('maps a 23505 on the header UPDATE (concurrent claim race) to a clean conflict', async () => {
    const stub = makeRenameStub({
      update: {
        data: null,
        error: {
          code: '23505',
          message: 'duplicate key value violates unique constraint "purchase_orders_org_ponumber_active_key"',
        },
      },
    });
    const svc = new PurchaseOrdersService(makeServiceContext(stub.client) as never);

    const thrown = await svc.renamePoNumber(PO_ID, 'RACED-001').catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(ServiceError);
    expect((thrown as ServiceError).code).toBe('conflict');
    expect((thrown as ServiceError).message).toBe('That PO number is already in use.');
  });

  it('treats a 0-row UPDATE (TOCTOU cancel race) as a conflict, not success', async () => {
    const stub = makeRenameStub({ update: { data: null, error: null } });
    const svc = new PurchaseOrdersService(makeServiceContext(stub.client) as never);

    const thrown = await svc.renamePoNumber(PO_ID, 'GHOST-001').catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(ServiceError);
    expect((thrown as ServiceError).code).toBe('conflict');
    expect(mockAudit).not.toHaveBeenCalled();
  });
});
