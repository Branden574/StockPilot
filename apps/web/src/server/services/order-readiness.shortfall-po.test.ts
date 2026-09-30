import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const reportError = vi.hoisted(() => vi.fn(async (_err: unknown, _ctx: unknown) => {}));
vi.mock('@/lib/error-reporter', () => ({ reportError }));
vi.mock('@/lib/auth/warehouse', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/auth/warehouse')>();
  return { ...real, assertWarehouseAccess: vi.fn(async () => {}) };
});
vi.mock('./audit', () => ({
  audit: vi.fn(async () => {}),
  auditMany: vi.fn(async (p: unknown[]) => ({ written: p.length, lost: 0 })),
}));
vi.mock('./integration-events', () => ({ dispatchEvent: vi.fn(async () => {}) }));
vi.mock('./lib/inventory-list-cache', () => ({ invalidateInventoryListAfterWrite: vi.fn() }));

import {
  SHORTFALL_PO_BUSY_COPY,
  SHORTFALL_PO_CHANGED_COPY,
  SHORTFALL_PO_CONFLICT_COPY,
  SHORTFALL_PO_FORBIDDEN_COPY,
  SHORTFALL_PO_INVALID_COPY,
  SHORTFALL_PO_ITEM_NOT_DRAFTABLE_COPY,
  SHORTFALL_PO_LINE_NOT_ON_ORDER_COPY,
  SHORTFALL_PO_LINES_CAPPED_COPY,
  SHORTFALL_PO_NO_WAREHOUSE_ACCESS_COPY,
  SHORTFALL_PO_NOT_APPLICABLE_COPY,
  SHORTFALL_PO_NOT_FOUND_COPY,
  SHORTFALL_PO_ORDERS_OFF_COPY,
  SHORTFALL_PO_PURCHASE_ORDERS_OFF_COPY,
  SHORTFALL_PO_SIGN_IN_COPY,
  SHORTFALL_PO_TIMEOUT_COPY,
  type ModuleId,
  type Role,
} from '@stockpilot/core';

import { assertWarehouseAccess, ForbiddenError } from '@/lib/auth/warehouse';
import { makeServiceContext, makeSupabaseStub, type QueryResult } from '@/test/supabase-mock';

import { auditMany } from './audit';
import { ServiceError } from './context';
import { dispatchEvent } from './integration-events';
import { invalidateInventoryListAfterWrite } from './lib/inventory-list-cache';
import { OrderReadinessService, shortfallPoRpcError } from './order-readiness';

/**
 * OrderReadinessService.draftShortfallPos (F2-5, migration 0385). The
 * function is the authority (its floors, the reorder lock, the recompute and
 * the refusal above the draftable: pgTAP 0385 and the two-session race);
 * these pin the service around it: its floors and their words (the same as
 * the database's, before anything is read), what it sends, every refusal it
 * words, the audit entries (never a cost) and the po.created dispatch per
 * draft, and a replay that writes nothing.
 */

const ORDER = '11111111-1111-4111-8111-111111111111';
const ITEM_A = '22222222-2222-4222-8222-22222222222a';
const ITEM_B = '22222222-2222-4222-8222-22222222222b';
const WH = '33333333-3333-4333-8333-333333333333';
const SUP = '44444444-4444-4444-8444-444444444444';

const ANSWER = {
  orderId: ORDER,
  orderNumber: 17,
  replay: false,
  created: [
    {
      purchaseOrderId: 'po-1',
      poNumber: 'PO-2026-0005',
      supplierId: SUP,
      lineCount: 1,
      units: 8,
      lines: [{ itemId: ITEM_A, quantity: 8 }],
    },
    {
      purchaseOrderId: 'po-2',
      poNumber: 'PO-2026-0006',
      supplierId: null,
      lineCount: 1,
      units: 2.5,
      lines: [{ itemId: ITEM_B, quantity: 2.5 }],
    },
  ],
};

function build(
  opts: {
    rpc?: QueryResult;
    order?: QueryResult;
    role?: Role;
    permissions?: string[];
    modules?: ModuleId[];
    mfaRequired?: boolean;
    mfaSatisfied?: boolean;
  } = {},
) {
  const stub = makeSupabaseStub({
    'order_requests.select': opts.order ?? { data: { id: ORDER, warehouse_id: WH, order_number: 17 }, error: null },
    'rpc:draft_order_shortfall_pos': opts.rpc ?? { data: ANSWER, error: null },
  });
  const ctx = makeServiceContext(stub.client, {
    role: opts.role ?? 'manager',
    organizationId: 'org-1',
    enabledModules: new Set<ModuleId>(opts.modules ?? ['orders', 'purchase_orders']),
    ...(opts.permissions ? { permissions: new Set(opts.permissions) } : {}),
    ...(opts.mfaRequired !== undefined ? { mfaRequired: opts.mfaRequired } : {}),
    ...(opts.mfaSatisfied !== undefined ? { mfaSatisfied: opts.mfaSatisfied } : {}),
  });
  return { stub, svc: new OrderReadinessService(ctx as never) };
}

const INPUT = {
  orderId: ORDER,
  lines: [
    { itemId: ITEM_A, quantity: 8 },
    { itemId: ITEM_B, quantity: 2.5 },
  ],
  idempotencyKey: 'key-1',
};

async function refusal(p: Promise<unknown>): Promise<{ code: string; message: string; details: unknown }> {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  if (!(e instanceof ServiceError)) throw new Error(`expected a ServiceError, got ${String(e)}`);
  return { code: e.code, message: e.message, details: e.details };
}

beforeEach(() => {
  vi.mocked(invalidateInventoryListAfterWrite).mockClear();
  vi.mocked(auditMany).mockClear();
  vi.mocked(dispatchEvent).mockClear();
  vi.mocked(assertWarehouseAccess).mockReset().mockResolvedValue(undefined);
  reportError.mockClear();
});

describe('draftShortfallPos: a new draft', () => {
  it("reads THIS org's order, checks warehouse write, sends the lines and the key, and answers the parsed result", async () => {
    const { stub, svc } = build();
    const res = await svc.draftShortfallPos({
      ...INPUT,
      orderId: ORDER.toUpperCase(),
      lines: [
        { itemId: ITEM_A.toUpperCase(), quantity: 8 },
        { itemId: ITEM_B, quantity: 2.50004 },
      ],
      idempotencyKey: '  key-1  ',
    });
    expect(res).toEqual(ANSWER);
    expect(stub.chainsAll.get('order_requests.select')).toEqual([['select', 'eq', 'eq']]);
    expect(stub.chainArgsAll.get('order_requests.select')![0]!.slice(1, 3)).toEqual([
      ['organization_id', 'org-1'],
      ['id', ORDER],
    ]);
    expect(vi.mocked(assertWarehouseAccess).mock.calls[0]!.slice(0, 2)).toEqual([WH, 'write']);
    expect(stub.rpcCalls).toEqual([
      {
        name: 'draft_order_shortfall_pos',
        args: {
          p_order_id: ORDER,
          // Lower case, on the quantity columns' 4-decimal grid.
          p_lines: [
            { item_id: ITEM_A, quantity: 8 },
            { item_id: ITEM_B, quantity: 2.5 },
          ],
          p_idempotency_key: 'key-1',
        },
      },
    ]);
  });

  it('audits the order once (PO ids and numbers, the lines, never a cost) and each draft as created, in one write', async () => {
    const { svc } = build();
    await svc.draftShortfallPos(INPUT);
    expect(auditMany).toHaveBeenCalledTimes(1);
    const payloads = vi.mocked(auditMany).mock.calls[0]![0];
    expect(payloads).toEqual([
      {
        event: 'order_request.shortfall_po_drafted',
        entityType: 'order_request',
        entityId: ORDER,
        warehouseId: WH,
        extra: {
          purchase_order_ids: ['po-1', 'po-2'],
          po_numbers: ['PO-2026-0005', 'PO-2026-0006'],
          lines: [
            { item_id: ITEM_A, quantity: 8, purchase_order_id: 'po-1' },
            { item_id: ITEM_B, quantity: 2.5, purchase_order_id: 'po-2' },
          ],
        },
      },
      {
        event: 'purchase_order.created',
        entityType: 'purchase_order',
        entityId: 'po-1',
        extra: { po_number: 'PO-2026-0005', supplier_id: SUP, line_count: 1, source: 'order_shortfall', order_request_id: ORDER },
      },
      {
        event: 'purchase_order.created',
        entityType: 'purchase_order',
        entityId: 'po-2',
        extra: { po_number: 'PO-2026-0006', supplier_id: null, line_count: 1, source: 'order_shortfall', order_request_id: ORDER },
      },
    ]);
    expect(JSON.stringify(payloads)).not.toMatch(/cost|price|subtotal|total/i);
    // The call reaches save_purchase_order_draft, a stock-table writer
    // (inventory-list-invalidation guard): the Items/Books cache is expired once.
    expect(invalidateInventoryListAfterWrite).toHaveBeenCalledTimes(1);
    expect(invalidateInventoryListAfterWrite).toHaveBeenCalledWith('org-1', 'orders.shortfall_po');
  });

  it('dispatches po.created per draft (the createDraftPo shape), best-effort', async () => {
    const { svc } = build();
    await svc.draftShortfallPos(INPUT);
    await vi.waitFor(() => expect(dispatchEvent).toHaveBeenCalledTimes(2));
    expect(vi.mocked(dispatchEvent).mock.calls).toEqual([
      ['org-1', 'po.created', { id: 'po-1', poNumber: 'PO-2026-0005', lineCount: 1 }],
      ['org-1', 'po.created', { id: 'po-2', poNumber: 'PO-2026-0006', lineCount: 1 }],
    ]);
  });

  it('a replay (the same key and request) answers the first result and writes nothing: no audit, no dispatch', async () => {
    const { svc } = build({ rpc: { data: { ...ANSWER, replay: true }, error: null } });
    const res = await svc.draftShortfallPos(INPUT);
    expect(res.replay).toBe(true);
    expect(res.created.map((c) => c.purchaseOrderId)).toEqual(['po-1', 'po-2']);
    expect(auditMany).not.toHaveBeenCalled();
    expect(invalidateInventoryListAfterWrite).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 0));
    expect(dispatchEvent).not.toHaveBeenCalled();
  });
});

describe('draftShortfallPos: floors first, in core words, before anything is read (pattern #4)', () => {
  it('the orders module off, or the purchase_orders module off', async () => {
    for (const [modules, message, module] of [
      [['purchase_orders'], SHORTFALL_PO_ORDERS_OFF_COPY, 'orders'],
      [['orders'], SHORTFALL_PO_PURCHASE_ORDERS_OFF_COPY, 'purchase_orders'],
    ] as const) {
      const { stub, svc } = build({ modules: [...modules] });
      expect(await refusal(svc.draftShortfallPos(INPUT))).toEqual({
        code: 'module_disabled',
        message,
        details: { reason: 'module_disabled', module },
      });
      expect(stub.fromCalls).toEqual([]);
      expect(stub.rpcCalls).toEqual([]);
    }
  });

  it('staff WITH purchase_orders:manage (not a manager: idempotency keys are manager-only), a viewer, and a manager without purchase_orders:manage', async () => {
    for (const opts of [
      { role: 'staff' as Role, permissions: ['purchase_orders:manage', 'orders:read'] },
      { role: 'viewer' as Role },
      { role: 'manager' as Role, permissions: ['orders:approve', 'purchase_orders:read'] },
    ]) {
      const { stub, svc } = build(opts);
      expect(await refusal(svc.draftShortfallPos(INPUT)), JSON.stringify(opts)).toEqual({
        code: 'forbidden',
        message: SHORTFALL_PO_FORBIDDEN_COPY,
        details: { reason: 'forbidden' },
      });
      expect(stub.fromCalls).toEqual([]);
      expect(stub.rpcCalls).toEqual([]);
    }
  });

  it('an admin and the owner may draft', async () => {
    for (const role of ['admin', 'owner'] as const) {
      const { svc } = build({ role });
      expect((await svc.draftShortfallPos(INPUT)).created).toHaveLength(2);
    }
  });

  it('an MFA session not yet stepped up gets the step-up prompt, not the permission refusal', async () => {
    const { stub, svc } = build({ mfaRequired: true, mfaSatisfied: false });
    const r = await refusal(svc.draftShortfallPos(INPUT));
    expect(r.code).toBe('forbidden');
    expect((r.details as { reason: string }).reason).toMatch(/^(aal2_required|mfa_required)$/);
    expect(stub.rpcCalls).toEqual([]);
  });

  it('a malformed request is refused before any read: the key, the number of lines, an item twice (any case), a quantity that is not above 0', async () => {
    const bad: Array<Partial<typeof INPUT>> = [
      { idempotencyKey: '' },
      { idempotencyKey: '   ' },
      { idempotencyKey: 'k'.repeat(201) },
      { lines: [] },
      { lines: Array.from({ length: 201 }, (_, i) => ({ itemId: `22222222-2222-4222-8222-${String(i).padStart(12, '0')}`, quantity: 1 })) },
      { lines: [{ itemId: 'not-a-uuid', quantity: 1 }] },
      { lines: [{ itemId: ITEM_A, quantity: 1 }, { itemId: ITEM_A.toUpperCase(), quantity: 2 }] },
      { lines: [{ itemId: ITEM_A, quantity: 0 }] },
      { lines: [{ itemId: ITEM_A, quantity: -1 }] },
      { lines: [{ itemId: ITEM_A, quantity: 0.00004 }] },
      { lines: [{ itemId: ITEM_A, quantity: Number.NaN }] },
      { lines: [{ itemId: ITEM_A, quantity: Number.POSITIVE_INFINITY }] },
    ];
    for (const b of bad) {
      const { stub, svc } = build();
      expect(await refusal(svc.draftShortfallPos({ ...INPUT, ...b })), JSON.stringify(b).slice(0, 80)).toEqual({
        code: 'validation_error',
        message: SHORTFALL_PO_INVALID_COPY,
        details: { reason: 'invalid' },
      });
      expect(stub.fromCalls).toEqual([]);
    }
    const { svc } = build();
    expect((await refusal(svc.draftShortfallPos({ ...INPUT, orderId: 'nope' }))).code).toBe('not_found');
  });

  it("an order this org does not have is not found, and the function is never called", async () => {
    const { stub, svc } = build({ order: { data: null, error: null } });
    expect(await refusal(svc.draftShortfallPos(INPUT))).toEqual({
      code: 'not_found',
      message: SHORTFALL_PO_NOT_FOUND_COPY,
      details: { reason: 'not_found' },
    });
    expect(stub.rpcCalls).toEqual([]);
  });

  it("no write access to the order's warehouse: refused in core words before the function", async () => {
    const { stub, svc } = build();
    vi.mocked(assertWarehouseAccess).mockRejectedValueOnce(new ForbiddenError('no'));
    expect(await refusal(svc.draftShortfallPos(INPUT))).toEqual({
      code: 'forbidden',
      message: SHORTFALL_PO_NO_WAREHOUSE_ACCESS_COPY,
      details: { reason: 'forbidden' },
    });
    expect(stub.rpcCalls).toEqual([]);
  });

  it('a failed order read is a fault (reported), never "not found"', async () => {
    const { stub, svc } = build({ order: { data: null, error: { message: 'boom' } } });
    expect((await refusal(svc.draftShortfallPos(INPUT))).code).toBe('internal_error');
    expect(stub.rpcCalls).toEqual([]);
    expect(reportError).toHaveBeenCalled();
  });
});

describe("draft_order_shortfall_pos's refusals, in core words (pattern #28: exact messages)", () => {
  const CURRENT = `{"${ITEM_A}": 6, "${ITEM_B}": 0}`;
  const CASES: Array<[string, NonNullable<QueryResult['error']>, string, string, Record<string, unknown>]> = [
    ['not found', { message: 'order_request_not_found', code: 'P0002' }, 'not_found', SHORTFALL_PO_NOT_FOUND_COPY, { reason: 'not_found' }],
    ['orders off', { message: 'module_disabled', code: 'P0001', hint: 'module_disabled', details: 'orders' }, 'module_disabled', SHORTFALL_PO_ORDERS_OFF_COPY, { reason: 'module_disabled', module: 'orders' }],
    ['purchase orders off', { message: 'module_disabled', code: 'P0001', hint: 'module_disabled', details: 'purchase_orders' }, 'module_disabled', SHORTFALL_PO_PURCHASE_ORDERS_OFF_COPY, { reason: 'module_disabled', module: 'purchase_orders' }],
    ['not a manager', { message: 'forbidden', code: '42501', hint: 'manager_required' }, 'forbidden', SHORTFALL_PO_FORBIDDEN_COPY, { reason: 'forbidden' }],
    ['no PO permission', { message: 'forbidden', code: '42501', hint: 'purchase_orders_manage' }, 'forbidden', SHORTFALL_PO_FORBIDDEN_COPY, { reason: 'forbidden' }],
    ['no warehouse write', { message: 'forbidden', code: '42501', hint: 'warehouse_write' }, 'forbidden', SHORTFALL_PO_NO_WAREHOUSE_ACCESS_COPY, { reason: 'forbidden' }],
    ['signed out', { message: 'unauthenticated', code: '42501' }, 'unauthenticated', SHORTFALL_PO_SIGN_IN_COPY, { reason: 'forbidden' }],
    [
      'the numbers moved',
      { message: 'shortfall_changed', code: 'P0001', hint: 'shortfall_changed', details: CURRENT },
      'conflict',
      SHORTFALL_PO_CHANGED_COPY,
      { reason: 'shortfall_changed', current: { [ITEM_A]: 6, [ITEM_B]: 0 } },
    ],
    ['the key for another request', { message: 'idempotency_conflict', code: 'P0001', hint: 'idempotency_conflict' }, 'conflict', SHORTFALL_PO_CONFLICT_COPY, { reason: 'idempotency_conflict' }],
    ['picked', { message: 'readiness_not_applicable', code: 'P0001', hint: 'readiness_not_applicable', details: 'picking_complete' }, 'conflict', SHORTFALL_PO_NOT_APPLICABLE_COPY, { reason: 'not_applicable', status: 'picking_complete' }],
    ['more than 200 lines', { message: 'readiness_not_applicable', code: 'P0001', hint: 'readiness_not_applicable', details: 'approved' }, 'conflict', SHORTFALL_PO_LINES_CAPPED_COPY, { reason: 'not_applicable', status: 'approved' }],
    [
      'a kit',
      { message: 'item_not_draftable', code: 'P0001', hint: 'item_not_draftable', details: `{"${ITEM_A}": "kit_stock"}` },
      'validation_error',
      SHORTFALL_PO_ITEM_NOT_DRAFTABLE_COPY,
      { reason: 'item_not_draftable', items: { [ITEM_A]: 'kit_stock' } },
    ],
    ['not on the order', { message: 'line_not_on_order', code: '22023', hint: 'line_not_on_order', details: ITEM_B }, 'validation_error', SHORTFALL_PO_LINE_NOT_ON_ORDER_COPY, { reason: 'line_not_on_order', itemId: ITEM_B }],
    ['a malformed line', { message: 'line_invalid', code: '22023', hint: 'line_invalid' }, 'validation_error', SHORTFALL_PO_INVALID_COPY, { reason: 'invalid' }],
    ['the save refused a kit', { message: '"Box set" is a pre-assembled kit, and kits can\'t be ordered on a purchase order: they are built from their components. Order the components instead.', code: '22023', hint: 'po_line_bundle' }, 'validation_error', '"Box set" is a pre-assembled kit, and kits can\'t be ordered on a purchase order: they are built from their components. Order the components instead.', { reason: 'item_not_draftable' }],
    ['another org\'s item', { message: 'An item … is not part of this organization.', code: '42501', hint: 'po_not_in_org' }, 'validation_error', SHORTFALL_PO_ITEM_NOT_DRAFTABLE_COPY, { reason: 'item_not_draftable' }],
    ['a lock wait', { message: 'canceling statement due to lock timeout', code: '55P03' }, 'conflict', SHORTFALL_PO_BUSY_COPY, { reason: 'busy', retryable: true }],
    // Review: a timeout is not "being changed at the same time"; it rolled back.
    ['a statement timeout', { message: 'canceling statement due to statement timeout', code: '57014' }, 'conflict', SHORTFALL_PO_TIMEOUT_COPY, { reason: 'busy', retryable: true }],
    ['a PO number taken meanwhile', { message: 'duplicate key value violates unique constraint "purchase_orders_org_ponumber_active_key"', code: '23505' }, 'conflict', SHORTFALL_PO_BUSY_COPY, { reason: 'busy', retryable: true }],
  ];

  it.each(CASES)('%s', async (_label, error, code, message, details) => {
    const { svc } = build({ rpc: { data: null, error } });
    expect(await refusal(svc.draftShortfallPos(INPUT))).toEqual({ code, message, details });
    expect(auditMany).not.toHaveBeenCalled();
    expect(dispatchEvent).not.toHaveBeenCalled();
  });

  it('anything else is a fault: the generic message, the cause reported (a revoked grant is not "not allowed")', async () => {
    const { svc } = build({ rpc: { data: null, error: { message: 'permission denied for function draft_order_shortfall_pos', code: '42501' } } });
    const r = await refusal(svc.draftShortfallPos(INPUT));
    expect(r.code).toBe('internal_error');
    expect(r.details).toEqual({ reason: 'failed' });
    expect(r.message).not.toMatch(/permission denied/);
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('permission denied for function') }),
      expect.objectContaining({ tag: 'orders.shortfall_po_failed' }),
    );
  });

  it('shortfall_changed with a detail it cannot read still refuses, with no numbers (never guessed)', () => {
    expect(shortfallPoRpcError({ message: 'shortfall_changed', code: 'P0001', details: 'garbage' }).details).toEqual({
      reason: 'shortfall_changed',
      current: null,
    });
  });

  it('an answer of the wrong shape, or for another order, is a fault (reported), and nothing is audited', async () => {
    for (const data of [{ ...ANSWER, created: 'x' }, { ...ANSWER, orderId: '99999999-9999-4999-8999-999999999999' }, null]) {
      const { svc } = build({ rpc: { data, error: null } });
      expect((await refusal(svc.draftShortfallPos(INPUT))).code).toBe('internal_error');
    }
    expect(auditMany).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledTimes(3);
  });
});
