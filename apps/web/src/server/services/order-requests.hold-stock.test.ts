import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  HOLD_BUSY_COPY,
  HOLD_FAILED_COPY,
  HOLD_MODULE_OFF_COPY,
  HOLD_NO_WAREHOUSE_ACCESS_COPY,
  HOLD_NOT_APPLICABLE_COPY,
  HOLD_NOT_APPROVER_COPY,
  HOLD_ORDER_NOT_FOUND_COPY,
  type ModuleId,
  type Role,
} from '@stockpilot/core';

import { assertWarehouseAccess, ForbiddenError } from '@/lib/auth/warehouse';
import { reportError } from '@/lib/error-reporter';
import { broadcastOrderChanged } from '@/lib/realtime/broadcast';
import { makeServiceContext, makeSupabaseStub, type QueryResult } from '@/test/supabase-mock';

import { audit } from './audit';
import { ServiceError } from './context';
import { OrderRequestsService } from './order-requests';

// F2-2 (0378): "Hold available stock", and the automatic top-up after an
// approver adds or raises a line at a hold status. The function is the
// authority (its own gates, the item lock, the arithmetic, pgTAP 0378); these
// pin the service around it: its gates, the order id it passes, the refusals
// it words, the audit and broadcast, and that a top-up never undoes a line
// edit and is never swallowed.

vi.mock('@/lib/auth/warehouse', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/auth/warehouse')>();
  return { ...real, assertWarehouseAccess: vi.fn(async () => {}) };
});
vi.mock('./audit', () => ({ audit: vi.fn(async () => {}) }));
vi.mock('./notifications', () => ({ createNotification: vi.fn(async () => 'notif-1') }));
vi.mock('@/lib/realtime/broadcast', () => ({ broadcastOrderChanged: vi.fn(async () => {}) }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => adminHandle.client }));
const adminHandle: { client: unknown } = { client: null };

const ORDER = 'order-1';
const HELD = {
  held: [{ itemId: 'item-1', added: 8 }],
  stillShort: [{ itemId: 'item-2', quantity: 6 }],
  hiddenHeldItems: 0,
  hiddenShortItems: 0,
};
/** What the audit entry records: the answer as it came, and what started it. */
const HELD_AFTER = {
  held: HELD.held,
  stillShort: HELD.stillShort,
  hiddenHeldItems: 0,
  hiddenShortItems: 0,
};

function svc(
  stub: ReturnType<typeof makeSupabaseStub>,
  opts: {
    role?: Role;
    userId?: string;
    modules?: ModuleId[];
    permissions?: string[];
    mfaRequired?: boolean;
    mfaSatisfied?: boolean;
  } = {},
) {
  adminHandle.client = stub.client;
  return new (OrderRequestsService as unknown as new (ctx: unknown) => OrderRequestsService)(
    makeServiceContext(stub.client, {
      role: opts.role ?? 'manager',
      userId: opts.userId ?? 'approver-1',
      enabledModules: new Set<ModuleId>(opts.modules ?? ['orders']),
      ...(opts.permissions ? { permissions: new Set(opts.permissions) } : {}),
      ...(opts.mfaRequired !== undefined ? { mfaRequired: opts.mfaRequired } : {}),
      ...(opts.mfaSatisfied !== undefined ? { mfaSatisfied: opts.mfaSatisfied } : {}),
    }),
  );
}

type Rpc = QueryResult | ((call: unknown) => QueryResult);

/** One order header row (read by requireWarehouseAccess and the line edits). */
function header(status = 'approved', over: Record<string, unknown> = {}) {
  return {
    id: ORDER,
    status,
    warehouse_id: 'wh-1',
    requester_user_id: 'requester-1',
    pick_slip_generated_at: null,
    order_number: 12,
    ...over,
  };
}

beforeEach(() => {
  vi.mocked(audit).mockClear();
  vi.mocked(broadcastOrderChanged).mockClear();
  vi.mocked(reportError).mockClear();
  vi.mocked(assertWarehouseAccess).mockReset();
  vi.mocked(assertWarehouseAccess).mockImplementation(async () => {});
});

// ── holdStock ───────────────────────────────────────────────────────────────

describe('OrderRequestsService.holdStock', () => {
  function stubWith(rpc: Rpc) {
    return makeSupabaseStub({
      'order_requests.select': { data: { warehouse_id: 'wh-1' }, error: null },
      'rpc:hold_order_stock': rpc,
    });
  }

  it('passes the order id only, reads the answer, audits what was held and broadcasts', async () => {
    const stub = stubWith({ data: HELD, error: null });
    await expect(svc(stub).holdStock(ORDER)).resolves.toEqual(HELD);
    expect(stub.rpcCalls).toEqual([{ name: 'hold_order_stock', args: { p_order_id: ORDER } }]);
    expect(assertWarehouseAccess).toHaveBeenCalledWith('wh-1', 'write', expect.anything());
    expect(audit).toHaveBeenCalledTimes(1);
    expect(vi.mocked(audit).mock.calls[0]![0]).toEqual({
      event: 'order.stock_held',
      entityType: 'order_request',
      entityId: ORDER,
      after: { trigger: 'manual', ...HELD_AFTER },
    });
    // No costs on the audit entry.
    expect(JSON.stringify(vi.mocked(audit).mock.calls[0]![0])).not.toMatch(/cost/i);
    expect(broadcastOrderChanged).toHaveBeenCalledWith('org-test', ORDER);
  });

  it('a call that held nothing changed nothing: no audit, no broadcast', async () => {
    const nothing = { held: [], stillShort: [{ itemId: 'item-2', quantity: 6 }], hiddenHeldItems: 0, hiddenShortItems: 1 };
    const stub = stubWith({ data: nothing, error: null });
    await expect(svc(stub).holdStock(ORDER)).resolves.toEqual(nothing);
    expect(audit).not.toHaveBeenCalled();
    expect(broadcastOrderChanged).not.toHaveBeenCalled();
  });

  it('a call that held only for an item the caller cannot read still changed the order: audited (a count, no numbers) and broadcast', async () => {
    // 0378: a charter-scoped approver's order can carry an item they cannot
    // read; it is held all the same and only counted in the answer.
    const hidden = { held: [], stillShort: [], hiddenHeldItems: 1, hiddenShortItems: 1 };
    const stub = stubWith({ data: hidden, error: null });
    await expect(svc(stub).holdStock(ORDER)).resolves.toEqual(hidden);
    expect(audit).toHaveBeenCalledTimes(1);
    expect(vi.mocked(audit).mock.calls[0]![0].after).toEqual({ trigger: 'manual', ...hidden });
    expect(broadcastOrderChanged).toHaveBeenCalledWith('org-test', ORDER);
  });

  it('gates: the orders module, orders:approve (with the MFA step-up), write access to the warehouse; none reaches the function', async () => {
    const off = stubWith({ data: HELD, error: null });
    await expect(svc(off, { modules: [] }).holdStock(ORDER)).rejects.toMatchObject({ code: 'module_disabled' });
    expect(off.rpcCalls).toEqual([]);

    const staff = stubWith({ data: HELD, error: null });
    await expect(svc(staff, { role: 'staff' }).holdStock(ORDER)).rejects.toMatchObject({ code: 'forbidden' });
    expect(staff.rpcCalls).toEqual([]);

    const stepUp = stubWith({ data: HELD, error: null });
    await expect(
      svc(stepUp, { mfaRequired: true, mfaSatisfied: false }).holdStock(ORDER),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(stepUp.rpcCalls).toEqual([]);

    vi.mocked(assertWarehouseAccess).mockRejectedValueOnce(new ForbiddenError('User does not have write access to warehouse wh-1.'));
    const scoped = stubWith({ data: HELD, error: null });
    const e = await svc(scoped).holdStock(ORDER).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ServiceError);
    expect(e).toMatchObject({ code: 'forbidden', message: HOLD_NO_WAREHOUSE_ACCESS_COPY });
    expect(scoped.rpcCalls).toEqual([]);
  });

  it("a caller who may not approve orders is refused in core's words, as the function's own refusal is; the MFA step-up keeps its own", async () => {
    // Found by the F2-2 local e2e: staff hold_stock on /api/v1 answered
    // "Missing permission: orders:approve", while both platforms show the
    // refusal as it comes (core HOLD_* copy).
    const staff = stubWith({ data: HELD, error: null });
    const e = await svc(staff, { role: 'staff' }).holdStock(ORDER).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ServiceError);
    expect(e).toMatchObject({ code: 'forbidden', message: HOLD_NOT_APPROVER_COPY, details: { reason: 'forbidden' } });
    expect(staff.rpcCalls).toEqual([]);

    // A manager at AAL1 where MFA is required: the step-up refusal, untouched
    // (its reason is what the web's step-up prompt reads), never "not an approver".
    const stepUp = stubWith({ data: HELD, error: null });
    const s = await svc(stepUp, { mfaRequired: true, mfaSatisfied: false }).holdStock(ORDER).catch((x: unknown) => x);
    expect(s).toMatchObject({ code: 'forbidden' });
    expect((s as Error).message).not.toBe(HOLD_NOT_APPROVER_COPY);
    expect((s as ServiceError).details).not.toEqual({ reason: 'forbidden' });
    expect(stepUp.rpcCalls).toEqual([]);

    // A staffer who may not approve AND is at AAL1: the step-up comes first,
    // exactly as assertPermission orders it.
    const both = stubWith({ data: HELD, error: null });
    const b = await svc(both, { role: 'staff', mfaRequired: true, mfaSatisfied: false }).holdStock(ORDER).catch((x: unknown) => x);
    expect((b as Error).message).toBe((s as Error).message);
    expect(both.rpcCalls).toEqual([]);
  });

  it('staff with an orders:approve override may hold (pattern #4: the approve gate)', async () => {
    const stub = stubWith({ data: HELD, error: null });
    await expect(
      svc(stub, { role: 'staff', permissions: ['orders:approve', 'orders:request'] }).holdStock(ORDER),
    ).resolves.toEqual(HELD);
    expect(stub.rpcCalls).toHaveLength(1);
  });

  it('an order in another org (or none) is not_found before the function', async () => {
    const stub = makeSupabaseStub({ 'order_requests.select': { data: null, error: null } });
    await expect(svc(stub).holdStock(ORDER)).rejects.toMatchObject({ code: 'not_found' });
    expect(stub.rpcCalls).toEqual([]);
  });

  // Every refusal hold_order_stock raises (0378), as PostgREST hands it back.
  it.each([
    [{ message: 'order_request_not_found', code: 'P0002' }, 'not_found', HOLD_ORDER_NOT_FOUND_COPY, 'not_found'],
    [{ message: 'module_disabled', code: 'P0001', hint: 'module_disabled' }, 'module_disabled', HOLD_MODULE_OFF_COPY, 'module_disabled'],
    [{ message: 'forbidden', code: '42501', hint: 'orders_approve' }, 'forbidden', HOLD_NOT_APPROVER_COPY, 'forbidden'],
    [{ message: 'forbidden', code: '42501', hint: 'warehouse_write' }, 'forbidden', HOLD_NO_WAREHOUSE_ACCESS_COPY, 'forbidden'],
    [{ message: 'unauthenticated', code: '42501' }, 'unauthenticated', 'Sign in again to hold stock.', 'forbidden'],
    [{ message: 'hold_not_applicable', code: 'P0001', hint: 'hold_not_applicable', details: 'picking_complete' }, 'conflict', HOLD_NOT_APPLICABLE_COPY, 'not_applicable'],
    [{ message: 'canceling statement due to lock timeout', code: '55P03' }, 'conflict', HOLD_BUSY_COPY, 'busy'],
    // The authenticated role's statement_timeout (8 s) can end a call that
    // waited on the order row and then an item (5 s lock_timeout each): the
    // same "someone else is changing it" as a lock timeout.
    [{ message: 'canceling statement due to statement timeout', code: '57014' }, 'conflict', HOLD_BUSY_COPY, 'busy'],
  ] as const)('maps %o to %s', async (error, code, message, reason) => {
    const stub = stubWith({ data: null, error: { ...error } });
    const e = await svc(stub).holdStock(ORDER).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ServiceError);
    expect(e).toMatchObject({ code, message, details: { reason } });
    expect(audit).not.toHaveBeenCalled();
  });

  it('anything else is internal_error, never shows the raw text, and is reported with its cause (a revoked grant, a deadlock, a fault, an unreadable answer)', async () => {
    for (const [rpc, cause] of [
      [
        { data: null, error: { message: 'permission denied for function hold_order_stock', code: '42501' } },
        '42501: permission denied for function hold_order_stock',
      ],
      [{ data: null, error: { message: 'deadlock detected', code: '40P01' } }, '40P01: deadlock detected'],
      [{ data: null, error: { message: 'boom', code: 'XX000' } }, 'XX000: boom'],
      [{ data: { held: 'nope' }, error: null }, 'held is not a list'],
      [{ data: null, error: null }, 'the answer is not an object'],
    ] as Array<[QueryResult, string]>) {
      vi.mocked(reportError).mockClear();
      const e = await svc(stubWith(rpc)).holdStock(ORDER).catch((x: unknown) => x);
      expect(e).toMatchObject({ code: 'internal_error' });
      expect((e as Error).message).toBe('An internal error occurred. Please try again.');
      // The manual "Hold available stock" is reported too, and the report
      // keeps what went wrong (the public message is the generic sentence).
      expect(reportError, cause).toHaveBeenCalledTimes(1);
      const [reported, context] = vi.mocked(reportError).mock.calls[0]!;
      expect((reported as Error).message, cause).toContain(cause);
      expect(context).toMatchObject({
        tag: 'orders.hold_failed',
        organizationId: 'org-test',
        extra: { orderId: ORDER, trigger: 'manual', reason: 'failed' },
      });
      expect(JSON.stringify(context.extra), cause).toContain(cause);
    }
  });

  it('a refusal of the manual hold is the caller\'s answer, not an error report', async () => {
    const e = await svc(stubWith({ data: null, error: { message: 'hold_not_applicable', code: 'P0001' } }))
      .holdStock(ORDER)
      .catch((x: unknown) => x);
    expect(e).toMatchObject({ code: 'conflict' });
    expect(reportError).not.toHaveBeenCalled();
  });
});

// ── The automatic top-up after an add ───────────────────────────────────────

const ITEM = { id: 'item-1', name: 'Widget', warehouse_id: 'wh-1', unit_cost: 5, awaiting_first_receipt: false };

function addStub(status: string, rpc: Rpc, log: string[] = []) {
  return makeSupabaseStub({
    'order_requests.select': { data: header(status), error: null },
    'inventory_items.select': { data: [ITEM], error: null },
    'order_request_lines.select': { data: [], error: null },
    'order_request_lines.insert': () => {
      log.push('line insert');
      return { data: null, error: null };
    },
    'rpc:hold_order_stock': typeof rpc === 'function'
      ? rpc
      : () => {
          log.push('hold');
          return rpc;
        },
  });
}

describe('addLines holds what an approver adds at a hold status (D15)', () => {
  it.each(['approved', 'pick_slip_generated', 'picking_in_progress'])(
    'an approver at %s: the line is written, then held, and the outcome returned',
    async (status) => {
      const log: string[] = [];
      const stub = addStub(status, { data: HELD, error: null }, log);
      const res = await svc(stub).addLines(ORDER, [{ itemId: 'item-1', quantity: 3 }]);
      expect(res).toEqual({ added: 1, merged: 0, pickSlipStale: false, hold: { ok: true, ...HELD } });
      expect(log).toEqual(['line insert', 'hold']);
      expect(stub.rpcCalls).toEqual([{ name: 'hold_order_stock', args: { p_order_id: ORDER } }]);
      const held = vi.mocked(audit).mock.calls.map((c) => c[0]).find((p) => p.event === 'order.stock_held');
      expect(held?.after).toEqual({ trigger: 'lines_added', ...HELD_AFTER });
    },
  );

  it.each(['pending_approval', 'backordered', 'picking_complete', 'packing_slip_generated', 'staged_for_pickup'])(
    'an approver at %s: nothing to hold here (approve, resume or no hold at all), hold null',
    async (status) => {
      const stub = addStub(status, { data: HELD, error: null });
      const res = await svc(stub).addLines(ORDER, [{ itemId: 'item-1', quantity: 3 }]);
      expect(res.hold).toBeNull();
      expect(stub.rpcCalls).toEqual([]);
    },
  );

  it('a requester who may not approve never creates a commitment: hold null, the function never called', async () => {
    const stub = addStub('approved', { data: HELD, error: null });
    const res = await svc(stub, { role: 'staff', userId: 'requester-1' }).addLines(ORDER, [
      { itemId: 'item-1', quantity: 3 },
    ]);
    expect(res).toEqual({ added: 1, merged: 0, pickSlipStale: false, hold: null });
    expect(stub.rpcCalls).toEqual([]);
  });

  it('a hold failure never undoes the add: it is returned, and reported', async () => {
    const log: string[] = [];
    const stub = addStub('approved', { data: null, error: { message: 'canceling statement due to lock timeout', code: '55P03' } }, log);
    const res = await svc(stub).addLines(ORDER, [{ itemId: 'item-1', quantity: 3 }]);
    expect(log).toEqual(['line insert', 'hold']);
    expect(res).toEqual({
      added: 1,
      merged: 0,
      pickSlipStale: false,
      hold: { ok: false, reason: 'busy', message: HOLD_BUSY_COPY },
    });
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(vi.mocked(reportError).mock.calls[0]![1]).toMatchObject({
      tag: 'orders.hold_failed',
      extra: { orderId: ORDER, trigger: 'lines_added', reason: 'busy' },
    });
    // The add itself is on record either way.
    expect(vi.mocked(audit).mock.calls.map((c) => c[0].event)).toEqual(['order_request.lines_added']);
  });

  it('an internal failure is returned in plain words, and reported with its cause', async () => {
    const stub = addStub('approved', { data: null, error: { message: 'boom', code: 'XX000' } });
    const res = await svc(stub).addLines(ORDER, [{ itemId: 'item-1', quantity: 3 }]);
    expect(res.hold).toEqual({ ok: false, reason: 'failed', message: HOLD_FAILED_COPY });
    // Reported once (not again by the manual path), with the Postgres code
    // and text, which the ServiceError's public message no longer carries.
    expect(reportError).toHaveBeenCalledTimes(1);
    const [reported, context] = vi.mocked(reportError).mock.calls[0]!;
    expect((reported as Error).message).toContain('XX000: boom');
    expect(context).toMatchObject({
      tag: 'orders.hold_failed',
      extra: { orderId: ORDER, trigger: 'lines_added', reason: 'failed' },
    });
    expect(JSON.stringify(context.extra)).toContain('XX000: boom');
  });

  it('an approver who cannot write the warehouse (a viewer with an orders:approve override): the add stands, the hold says why', async () => {
    // loadEditableOrderHeader checks READ access; holding needs WRITE.
    vi.mocked(assertWarehouseAccess).mockImplementation(async (_wh, op) => {
      if (op === 'write') throw new ForbiddenError('Read-only auditor cannot perform write operations.');
    });
    const stub = addStub('approved', { data: HELD, error: null });
    const res = await svc(stub, { role: 'viewer', permissions: ['orders:approve', 'orders:request'] }).addLines(ORDER, [
      { itemId: 'item-1', quantity: 3 },
    ]);
    expect(res.added).toBe(1);
    expect(res.hold).toEqual({ ok: false, reason: 'forbidden', message: HOLD_NO_WAREHOUSE_ACCESS_COPY });
    expect(stub.rpcCalls).toEqual([]);
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it('an approver who has not done the MFA step-up: the add stands, the hold says why (forbidden, the step-up sentence)', async () => {
    const stub = addStub('approved', { data: HELD, error: null });
    const res = await svc(stub, { mfaRequired: true, mfaSatisfied: false }).addLines(ORDER, [
      { itemId: 'item-1', quantity: 3 },
    ]);
    expect(res.added).toBe(1);
    expect(res.hold).toEqual({
      ok: false,
      reason: 'forbidden',
      message: 'Multi-factor authentication required. Enroll in MFA before performing this action.',
    });
    expect(stub.rpcCalls).toEqual([]);
  });

  it('the top-up uses the header it already read: one order read, no second one for the warehouse', async () => {
    const stub = addStub('approved', { data: HELD, error: null });
    await svc(stub).addLines(ORDER, [{ itemId: 'item-1', quantity: 3 }]);
    expect(stub.fromCalls.filter((t) => t === 'order_requests')).toHaveLength(1);
    expect(assertWarehouseAccess).toHaveBeenCalledWith('wh-1', 'write', expect.anything());
  });
});

// ── The automatic top-up after a raise ──────────────────────────────────────

const LINE = {
  id: 'line-1',
  item_id: 'item-1',
  quantity_requested: 10,
  quantity_fulfilled: 0,
  quantity_picked: null,
  returned_quantity: 0,
};

function editStub(status: string, rpc: Rpc, log: string[] = []) {
  return makeSupabaseStub({
    'order_requests.select': { data: header(status), error: null },
    'order_requests.update': { data: null, error: null },
    'order_request_lines.select.maybeSingle': { data: LINE, error: null },
    'order_request_lines.select': {
      data: [{ id: 'line-1', item_id: 'item-1', quantity_requested: 10, quantity_fulfilled: 0 }],
      error: null,
    },
    'order_request_lines.update': () => {
      log.push('line update');
      return { data: { id: 'line-1' }, error: null };
    },
    'stock_reservations.select': { data: [{ id: 'res-1', quantity: 10, created_at: '2026-09-01T00:00:00Z' }], error: null },
    'stock_reservations.update': { data: { id: 'res-1' }, error: null },
    'inventory_items.select': { data: { id: 'item-1', name: 'Widget' }, error: null },
    'rpc:hold_order_stock': typeof rpc === 'function'
      ? rpc
      : () => {
          log.push('hold');
          return rpc;
        },
  });
}

describe('updateLineQuantity holds a raise an approver makes at a hold status (D15)', () => {
  it('a raise: the line is written, then held; the outcome is returned', async () => {
    const log: string[] = [];
    const stub = editStub('pick_slip_generated', { data: HELD, error: null }, log);
    const res = await svc(stub).updateLineQuantity(ORDER, 'line-1', 14);
    expect(res).toEqual({ pickSlipStale: false, quantity: 14, hold: { ok: true, ...HELD } });
    expect(log).toEqual(['line update', 'hold']);
    const held = vi.mocked(audit).mock.calls.map((c) => c[0]).find((p) => p.event === 'order.stock_held');
    expect(held?.after).toMatchObject({ trigger: 'line_raised' });
  });

  it('a lowering never tops up (the edit releases what is no longer owed): hold null', async () => {
    const stub = editStub('approved', { data: HELD, error: null });
    const res = await svc(stub).updateLineQuantity(ORDER, 'line-1', 4);
    expect(res.hold).toBeNull();
    expect(stub.rpcCalls).toEqual([]);
  });

  it('no change: hold null, nothing called', async () => {
    const stub = editStub('approved', { data: HELD, error: null });
    const res = await svc(stub).updateLineQuantity(ORDER, 'line-1', 10);
    expect(res).toEqual({ pickSlipStale: false, quantity: 10, hold: null });
    expect(stub.rpcCalls).toEqual([]);
  });

  it("a requester's raise stays unheld until an approver holds it", async () => {
    const stub = editStub('approved', { data: HELD, error: null });
    const res = await svc(stub, { role: 'staff', userId: 'requester-1' }).updateLineQuantity(ORDER, 'line-1', 14);
    expect(res.hold).toBeNull();
    expect(stub.rpcCalls).toEqual([]);
  });

  it('a raise at a status with no holds (picking complete): hold null', async () => {
    const stub = editStub('picking_complete', { data: HELD, error: null });
    const res = await svc(stub).updateLineQuantity(ORDER, 'line-1', 14);
    expect(res.hold).toBeNull();
    expect(stub.rpcCalls).toEqual([]);
  });

  it('a hold failure never undoes the raise: it is returned and reported', async () => {
    const stub = editStub('approved', { data: null, error: { message: 'hold_not_applicable', code: 'P0001', hint: 'hold_not_applicable' } });
    const res = await svc(stub).updateLineQuantity(ORDER, 'line-1', 14);
    expect(res).toEqual({
      pickSlipStale: false,
      quantity: 14,
      hold: { ok: false, reason: 'not_applicable', message: HOLD_NOT_APPLICABLE_COPY },
    });
    expect(vi.mocked(reportError).mock.calls[0]![1]).toMatchObject({
      tag: 'orders.hold_failed',
      extra: { trigger: 'line_raised', reason: 'not_applicable' },
    });
  });
});
