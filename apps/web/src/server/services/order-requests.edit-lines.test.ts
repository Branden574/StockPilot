import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId, Role } from '@stockpilot/core';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

import { OrderRequestsService } from './order-requests';

vi.mock('@/lib/auth/warehouse', () => ({ assertWarehouseAccess: vi.fn() }));
vi.mock('./audit', () => ({ audit: vi.fn(async () => {}) }));
const notifySpy = vi.fn(async (_args: unknown) => 'notif-1' as string | null);
vi.mock('./notifications', () => ({ createNotification: (a: unknown) => notifySpy(a) }));

// Line UPDATE/DELETE are RLS-forbidden for end users by design (mig 0049), so
// the service performs them through the service role. The stub is a fake DB —
// routing both handles to the same one keeps every chain assertion below
// meaningful while exercising the real code path.
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => adminHandle.client,
}));
const adminHandle: { client: unknown } = { client: null };

// Correcting an order after the fact (owner, 2026-07-22: "theres no way to
// delete the item you added if you added the wrong one or edit the amount").
// The rules that matter: the same gate as adding, plus hard floors so an edit
// can never contradict what physically happened — units handed over, units
// staged on a cart, returns recorded, or stock still reserved.

function svc(
  stub: ReturnType<typeof makeSupabaseStub>,
  opts: { role?: Role; userId?: string } = {},
) {
  return new (OrderRequestsService as unknown as new (ctx: unknown) => OrderRequestsService)(
    (adminHandle.client = stub.client,
    makeServiceContext(stub.client, {
      role: opts.role ?? 'admin',
      userId: opts.userId ?? 'approver-1',
      enabledModules: new Set<ModuleId>(['orders']),
    })),
  );
}

const OPEN_HEADER = {
  id: 'order-1',
  status: 'approved',
  warehouse_id: 'wh-1',
  requester_user_id: 'requester-1',
  pick_slip_generated_at: null,
  order_number: 12,
};

const CLEAN_LINE = {
  id: 'line-1',
  item_id: 'item-1',
  quantity_requested: 10,
  quantity_fulfilled: 0,
  quantity_picked: null,
  returned_quantity: 0,
};

/**
 * The single-line read uses .maybeSingle() (keyed `.select.maybeSingle`) while
 * the sibling-count read is a plain select, so the two order_request_lines
 * queries can be stubbed independently.
 */
function stubFor(
  opts: {
    header?: Record<string, unknown> | null;
    line?: Record<string, unknown> | null;
    siblings?: Array<Record<string, unknown>>;
    reservations?: Array<Record<string, unknown>>;
    reservationWrite?: { data: unknown; error: { message: string } | null };
  } = {},
) {
  return makeSupabaseStub({
    'order_requests.select': {
      data: opts.header === undefined ? OPEN_HEADER : opts.header,
      error: null,
    },
    'order_request_lines.select.maybeSingle': {
      data: opts.line === undefined ? CLEAN_LINE : opts.line,
      error: null,
    },
    'order_request_lines.select': {
      data: opts.siblings ?? [
        { id: 'line-1', item_id: 'item-1', quantity_requested: 10 },
        { id: 'line-2', item_id: 'item-2', quantity_requested: 5 },
      ],
      error: null,
    },
    // The service now FAILS CLOSED on these: a write that affects no row is
    // reported as a conflict rather than a silent success, so the stub must
    // return the affected row on the happy paths.
    'order_request_lines.update': { data: { id: 'line-1' }, error: null },
    'order_request_lines.delete': { data: { id: 'line-1' }, error: null },
    'stock_reservations.select': { data: opts.reservations ?? [], error: null },
    // The reservation write fails CLOSED the same way the line writes do, so
    // the happy path must hand back the affected row.
    'stock_reservations.update': opts.reservationWrite ?? { data: { id: 'res-1' }, error: null },
    'inventory_items.select': { data: { id: 'item-1', name: 'Widget' }, error: null },
  });
}

/** The shape approve_order_request mints: one active row per line. */
const RESERVATION = { id: 'res-1', item_id: 'item-1', quantity: 10, created_at: '2026-07-22T18:42:45Z' };

/** Patch handed to the LAST stock_reservations UPDATE the service issued. */
function reservationPatch(stub: ReturnType<typeof makeSupabaseStub>) {
  return stub.chainArgs.get('stock_reservations.update')?.[0]?.[0] as
    | Record<string, unknown>
    | undefined;
}

beforeEach(() => notifySpy.mockClear());

describe('OrderRequestsService.updateLineQuantity', () => {
  it('lowers the quantity on an untouched line', async () => {
    const stub = stubFor();
    const res = await svc(stub).updateLineQuantity('order-1', 'line-1', 4);
    expect(res.quantity).toBe(4);
    expect(res.pickSlipStale).toBe(false);
    expect(stub.chainArgs.get('order_request_lines.update')?.[0]?.[0]).toMatchObject({
      quantity_requested: 4,
    });
  });

  it('RAISES freely — same act as adding more (U4)', async () => {
    const stub = stubFor({ line: { ...CLEAN_LINE, quantity_fulfilled: 6, quantity_picked: 8 } });
    const res = await svc(stub).updateLineQuantity('order-1', 'line-1', 25);
    expect(res.quantity).toBe(25);
  });

  it('flags a printed pick slip as stale (A1)', async () => {
    const stub = stubFor({
      header: { ...OPEN_HEADER, pick_slip_generated_at: '2026-07-22T10:00:00Z' },
    });
    const res = await svc(stub).updateLineQuantity('order-1', 'line-1', 3);
    expect(res.pickSlipStale).toBe(true);
  });

  it('treats an unchanged quantity as a quiet no-op — no write, no audit (U5)', async () => {
    const stub = stubFor();
    const res = await svc(stub).updateLineQuantity('order-1', 'line-1', 10);
    expect(res.quantity).toBe(10);
    expect(stub.chains.has('order_request_lines.update')).toBe(false);
  });

  it('REFUSES a zero or negative quantity (U1)', async () => {
    const stub = stubFor();
    await expect(svc(stub).updateLineQuantity('order-1', 'line-1', 0)).rejects.toMatchObject({
      code: 'validation_error',
    });
    await expect(svc(stub).updateLineQuantity('order-1', 'line-1', -2)).rejects.toMatchObject({
      code: 'validation_error',
    });
  });

  it('REFUSES dropping below what has been handed over (U2)', async () => {
    const stub = stubFor({ line: { ...CLEAN_LINE, quantity_fulfilled: 6 } });
    await expect(svc(stub).updateLineQuantity('order-1', 'line-1', 4)).rejects.toMatchObject({
      code: 'conflict',
      message: expect.stringContaining('6'),
    });
  });

  it('REFUSES dropping below what is already staged (U3)', async () => {
    const stub = stubFor({ line: { ...CLEAN_LINE, quantity_picked: 7 } });
    await expect(svc(stub).updateLineQuantity('order-1', 'line-1', 5)).rejects.toMatchObject({
      code: 'conflict',
      message: expect.stringContaining('unstage'),
    });
  });

  it('REFUSES once the order has shipped or closed (G1)', async () => {
    for (const status of ['in_transit', 'completed', 'cancelled', 'denied']) {
      const stub = stubFor({ header: { ...OPEN_HEADER, status } });
      await expect(svc(stub).updateLineQuantity('order-1', 'line-1', 2)).rejects.toMatchObject({
        code: 'conflict',
      });
    }
  });

  it('lets the REQUESTER edit their own order, refuses an unrelated staffer (G2)', async () => {
    const okStub = stubFor();
    await expect(
      svc(okStub, { role: 'staff', userId: 'requester-1' }).updateLineQuantity(
        'order-1',
        'line-1',
        2,
      ),
    ).resolves.toMatchObject({ quantity: 2 });

    const badStub = stubFor();
    await expect(
      svc(badStub, { role: 'staff', userId: 'someone-else' }).updateLineQuantity(
        'order-1',
        'line-1',
        2,
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('reports a line from ANOTHER order as not_found, never a silent no-op (G4)', async () => {
    const stub = stubFor({ line: null });
    await expect(
      svc(stub).updateLineQuantity('order-1', 'line-from-order-2', 2),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(stub.chains.has('order_request_lines.update')).toBe(false);
  });

  it('scopes the line read to this order and this org (G4)', async () => {
    const stub = stubFor();
    await svc(stub).updateLineQuantity('order-1', 'line-1', 2);
    expect(stub.chainArgs.get('order_requests.select')).toEqual(
      expect.arrayContaining([['organization_id', 'org-test']]),
    );
    expect(stub.chainArgsAll.get('order_request_lines.select')?.[0]).toEqual(
      expect.arrayContaining([['order_request_id', 'order-1']]),
    );
  });

  it('reports a missing order as not_found (G4)', async () => {
    const stub = stubFor({ header: null });
    await expect(svc(stub).updateLineQuantity('nope', 'line-1', 2)).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});

describe('OrderRequestsService.removeLine', () => {
  it('removes an untouched line from a multi-line order (R6)', async () => {
    const stub = stubFor();
    const res = await svc(stub).removeLine('order-1', 'line-1');
    expect(res.removedItemId).toBe('item-1');
    expect(stub.chains.has('order_request_lines.delete')).toBe(true);
  });

  it('REFUSES when units were already handed over (R1)', async () => {
    const stub = stubFor({ line: { ...CLEAN_LINE, quantity_fulfilled: 2 } });
    await expect(svc(stub).removeLine('order-1', 'line-1')).rejects.toMatchObject({
      code: 'conflict',
    });
    expect(stub.chains.has('order_request_lines.delete')).toBe(false);
  });

  it('REFUSES when units are staged, and says to unstage (R2)', async () => {
    const stub = stubFor({ line: { ...CLEAN_LINE, quantity_picked: 3 } });
    await expect(svc(stub).removeLine('order-1', 'line-1')).rejects.toMatchObject({
      code: 'conflict',
      message: expect.stringContaining('unstage'),
    });
  });

  it('REFUSES when returns are recorded against the line (R3)', async () => {
    const stub = stubFor({ line: { ...CLEAN_LINE, returned_quantity: 1 } });
    await expect(svc(stub).removeLine('order-1', 'line-1')).rejects.toMatchObject({
      code: 'conflict',
    });
  });

  // R4 as a REFUSAL is gone. A reservation is a soft hold minted at APPROVAL,
  // not evidence of staged stock, so refusing on it made every approved order
  // un-editable — the production defect on SO-000060, where nothing had been
  // picked and the error told the user to do something that releases nothing.
  it('REMOVES a line whose item still has an active reservation, and releases it (R4)', async () => {
    const stub = stubFor({ reservations: [RESERVATION] });
    await expect(svc(stub).removeLine('order-1', 'line-1')).resolves.toMatchObject({
      removedItemId: 'item-1',
    });
    expect(stub.chains.has('order_request_lines.delete')).toBe(true);
    expect(reservationPatch(stub)).toMatchObject({ released_reason: 'line_removed' });
    expect(reservationPatch(stub)?.released_at).toEqual(expect.any(String));
  });

  it('REFUSES removing the LAST line — cancel the order instead (R5)', async () => {
    const stub = stubFor({ siblings: [{ id: 'line-1' }] });
    await expect(svc(stub).removeLine('order-1', 'line-1')).rejects.toMatchObject({
      code: 'conflict',
      message: expect.stringContaining('cancel'),
    });
    expect(stub.chains.has('order_request_lines.delete')).toBe(false);
  });

  it('REFUSES once the order has shipped or closed (G1)', async () => {
    for (const status of ['in_transit', 'completed', 'cancelled', 'denied']) {
      const stub = stubFor({ header: { ...OPEN_HEADER, status } });
      await expect(svc(stub).removeLine('order-1', 'line-1')).rejects.toMatchObject({
        code: 'conflict',
      });
    }
  });

  it('REFUSES a staffer who is neither requester nor approver (G2)', async () => {
    const stub = stubFor();
    await expect(
      svc(stub, { role: 'staff', userId: 'someone-else' }).removeLine('order-1', 'line-1'),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('reports a line from ANOTHER order as not_found (G4)', async () => {
    const stub = stubFor({ line: null });
    await expect(svc(stub).removeLine('order-1', 'foreign-line')).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(stub.chains.has('order_request_lines.delete')).toBe(false);
  });

  it('flags a printed pick slip as stale (A1)', async () => {
    const stub = stubFor({
      header: { ...OPEN_HEADER, pick_slip_generated_at: '2026-07-22T10:00:00Z' },
    });
    const res = await svc(stub).removeLine('order-1', 'line-1');
    expect(res.pickSlipStale).toBe(true);
  });
});

describe('line edits write their own audit events (A2)', () => {
  it('records line_quantity_changed with before and after', async () => {
    const { audit } = await import('./audit');
    vi.mocked(audit).mockClear();
    await svc(stubFor()).updateLineQuantity('order-1', 'line-1', 4);
    expect(vi.mocked(audit).mock.calls[0]?.[0]).toMatchObject({
      event: 'order_request.line_quantity_changed',
      before: { lineId: 'line-1', itemId: 'item-1', quantity: 10 },
      after: { quantity: 4 },
    });
  });

  it('records line_removed with the removed quantity', async () => {
    const { audit } = await import('./audit');
    vi.mocked(audit).mockClear();
    await svc(stubFor()).removeLine('order-1', 'line-1');
    expect(vi.mocked(audit).mock.calls[0]?.[0]).toMatchObject({
      event: 'order_request.line_removed',
      before: { lineId: 'line-1', itemId: 'item-1', quantity: 10 },
      after: { quantity: 0 },
    });
  });
});

// ---------------------------------------------------------------------------
// The defect these guard against actually shipped (2026-07-22, same day).
//
// order_request_lines carries RLS policies order_request_lines_no_update and
// _no_delete, both USING false — migration 0049 locked the table so lines can
// only be mutated by privileged SQL. Writing through the USER client therefore
// matched ZERO rows, and PostgREST returns no error for that, so addLines'
// top-up branch reported "merged" while changing nothing in production.
//
// Two things have to hold forever: the write goes through the service role,
// and a write that affects no row is never reported as success.
// ---------------------------------------------------------------------------

describe('line writes fail CLOSED when they affect no row', () => {
  it('updateLineQuantity reports a conflict instead of a phantom success', async () => {
    // What an RLS-denied (or already-changed) write looks like over PostgREST:
    // no row, and no error.
    const denied = makeSupabaseStub({
      'order_requests.select': { data: OPEN_HEADER, error: null },
      'order_request_lines.select.maybeSingle': { data: CLEAN_LINE, error: null },
      'order_request_lines.select': { data: [{ id: 'line-1' }, { id: 'line-2' }], error: null },
      'order_request_lines.update': { data: null, error: null },
      'stock_reservations.select': { data: [], error: null },
      'inventory_items.select': { data: { id: 'item-1', name: 'Widget' }, error: null },
    });
    await expect(svc(denied).updateLineQuantity('order-1', 'line-1', 4)).rejects.toMatchObject({
      code: 'conflict',
    });
  });

  it('removeLine reports a conflict instead of a phantom success', async () => {
    const denied = makeSupabaseStub({
      'order_requests.select': { data: OPEN_HEADER, error: null },
      'order_request_lines.select.maybeSingle': { data: CLEAN_LINE, error: null },
      'order_request_lines.select': { data: [{ id: 'line-1' }, { id: 'line-2' }], error: null },
      'order_request_lines.delete': { data: null, error: null },
      'stock_reservations.select': { data: [], error: null },
      'inventory_items.select': { data: { id: 'item-1', name: 'Widget' }, error: null },
    });
    await expect(svc(denied).removeLine('order-1', 'line-1')).rejects.toMatchObject({
      code: 'conflict',
    });
  });
});

// ---------------------------------------------------------------------------
// Reservation synchronisation (the SO-000060 fix, 2026-07-22).
//
// stock_reservations rows are SOFT HOLDS minted for every line at APPROVAL,
// released by stamping released_at + released_reason. They move no stock. The
// invariant these lock in: after any line edit, the item's ACTIVE reservation
// total equals what the order's remaining lines still ask for of that item —
// released outright when that total reaches zero, because the table has
// CHECK (quantity > 0) and zero is not representable.
// ---------------------------------------------------------------------------

describe('reservation synchronisation', () => {
  it('RELEASES the sole reservation when its only line is removed', async () => {
    const stub = stubFor({ reservations: [RESERVATION] });
    await svc(stub).removeLine('order-1', 'line-1');
    expect(reservationPatch(stub)).toMatchObject({ released_reason: 'line_removed' });
    // Never a quantity-zero write: CHECK (quantity > 0) forbids it.
    expect(reservationPatch(stub)).not.toHaveProperty('quantity');
  });

  it('REDUCES rather than releases when another line still wants the item', async () => {
    const stub = stubFor({
      reservations: [{ ...RESERVATION, quantity: 14 }],
      siblings: [
        { id: 'line-1', item_id: 'item-1', quantity_requested: 10 },
        { id: 'line-3', item_id: 'item-1', quantity_requested: 4 },
      ],
    });
    await svc(stub).removeLine('order-1', 'line-1');
    expect(reservationPatch(stub)).toEqual({ quantity: 4 });
  });

  // CRITICAL (confirmed twice in review). The invariant is requested-and-
  // UNFULFILLED. Summing quantity_requested alone leaves a hold covering units
  // that have ALREADY been handed over, which is the exact over-hold this sync
  // was built to remove — and it bites hardest on a partially fulfilled or
  // resumed backordered order, where the gap is largest.
  it('sizes the hold to what is still OWED, not what was requested', async () => {
    const stub = stubFor({
      reservations: [{ ...RESERVATION, quantity: 14 }],
      siblings: [
        { id: 'line-1', item_id: 'item-1', quantity_requested: 10, quantity_fulfilled: 0 },
        // 4 requested, 3 already handed over: only 1 is still owed.
        { id: 'line-3', item_id: 'item-1', quantity_requested: 4, quantity_fulfilled: 3 },
      ],
    });
    await svc(stub).removeLine('order-1', 'line-1');
    expect(reservationPatch(stub)).toEqual({ quantity: 1 });
  });

  it('never lets an over-receipt drive the hold negative', async () => {
    // quantity_fulfilled above quantity_requested is reachable — over-receipt
    // is permitted (mig 0285). A negative share would silently eat into a
    // sibling's legitimate hold, so each line is floored at zero.
    const stub = stubFor({
      reservations: [{ ...RESERVATION, quantity: 14 }],
      siblings: [
        { id: 'line-1', item_id: 'item-1', quantity_requested: 10, quantity_fulfilled: 0 },
        { id: 'line-3', item_id: 'item-1', quantity_requested: 4, quantity_fulfilled: 9 },
        { id: 'line-4', item_id: 'item-1', quantity_requested: 5, quantity_fulfilled: 0 },
      ],
    });
    await svc(stub).removeLine('order-1', 'line-1');
    // 0 (over-received) + 5 still owed — never 5 - 5 = 0, and never negative.
    expect(reservationPatch(stub)).toEqual({ quantity: 5 });
  });

  it('subtracts the EDITED line\'s own fulfilled units when lowering', async () => {
    const stub = stubFor({
      line: { ...CLEAN_LINE, quantity_requested: 10, quantity_fulfilled: 3 },
      reservations: [{ ...RESERVATION, quantity: 10 }],
    });
    // Lowering to 6 with 3 already handed over leaves 3 still owed.
    await svc(stub).updateLineQuantity('order-1', 'line-1', 6);
    expect(reservationPatch(stub)).toEqual({ quantity: 3 });
  });

  it('SHRINKS the reservation when the line quantity is lowered', async () => {
    const stub = stubFor({ reservations: [RESERVATION] });
    await svc(stub).updateLineQuantity('order-1', 'line-1', 4);
    expect(reservationPatch(stub)).toEqual({ quantity: 4 });
  });

  it('RELEASES on a lower that leaves an extra row with no share', async () => {
    // Two active rows (an item that sat on two lines at approval). Lowering to
    // 6 fills the first row and leaves the second with nothing.
    const stub = stubFor({
      reservations: [
        { ...RESERVATION, quantity: 6 },
        { ...RESERVATION, id: 'res-2', quantity: 4, created_at: '2026-07-22T18:42:46Z' },
      ],
    });
    await svc(stub).updateLineQuantity('order-1', 'line-1', 6);
    expect(reservationPatch(stub)).toMatchObject({ released_reason: 'line_quantity_lowered' });
  });

  it('leaves the reservation ALONE when the quantity is RAISED', async () => {
    // Deliberate asymmetry: minting/growing holds belongs to the approval and
    // pick-slip paths, and addLines has never created one either.
    const stub = stubFor({ reservations: [RESERVATION] });
    await svc(stub).updateLineQuantity('order-1', 'line-1', 25);
    expect(stub.chains.has('stock_reservations.update')).toBe(false);
  });

  it('removes a line whose item has NO active reservation, writing nothing', async () => {
    const stub = stubFor({ reservations: [] });
    await expect(svc(stub).removeLine('order-1', 'line-1')).resolves.toMatchObject({
      removedItemId: 'item-1',
    });
    expect(stub.chains.has('stock_reservations.update')).toBe(false);
  });

  it('scopes the reservation write by org, order, item and still-active', async () => {
    const stub = stubFor({ reservations: [RESERVATION] });
    await svc(stub).removeLine('order-1', 'line-1');
    expect(stub.chainArgs.get('stock_reservations.update')).toEqual(
      expect.arrayContaining([
        ['id', 'res-1'],
        ['organization_id', 'org-test'],
        ['order_request_id', 'order-1'],
        ['item_id', 'item-1'],
        ['released_at', null],
      ]),
    );
  });

  it('SURFACES a reservation write that affected no row (never a silent success)', async () => {
    // What an RLS-denied or already-released write looks like: no row, no error.
    const stub = stubFor({
      reservations: [RESERVATION],
      reservationWrite: { data: null, error: null },
    });
    await expect(svc(stub).removeLine('order-1', 'line-1')).rejects.toMatchObject({
      code: 'conflict',
    });
  });

  it('writes the LINE first, so a failed sync over-HOLDS rather than over-releases', async () => {
    // Over-holding self-corrects: cancel/deliver release every active row for
    // the order. Over-releasing would leave a live line with no hold at all,
    // and nothing later repairs that.
    const stub = stubFor({
      reservations: [RESERVATION],
      reservationWrite: { data: null, error: null },
    });
    await expect(svc(stub).removeLine('order-1', 'line-1')).rejects.toThrow();
    expect(stub.chains.has('order_request_lines.delete')).toBe(true);
  });

  it('records the reservation effect on the existing line events, not a new one', async () => {
    const { audit } = await import('./audit');
    vi.mocked(audit).mockClear();
    await svc(stubFor({ reservations: [RESERVATION] })).removeLine('order-1', 'line-1');
    expect(vi.mocked(audit).mock.calls.length).toBe(1);
    expect(vi.mocked(audit).mock.calls[0]?.[0]).toMatchObject({
      event: 'order_request.line_removed',
      after: { reservation: { synced: true, action: 'released', from: 10, to: 0 } },
    });

    vi.mocked(audit).mockClear();
    await svc(stubFor({ reservations: [RESERVATION] })).updateLineQuantity('order-1', 'line-1', 4);
    expect(vi.mocked(audit).mock.calls[0]?.[0]).toMatchObject({
      event: 'order_request.line_quantity_changed',
      after: { reservation: { synced: true, action: 'reduced', from: 10, to: 4 } },
    });
  });

  it('records a FAILED sync in the audit trail before surfacing the error', async () => {
    const { audit } = await import('./audit');
    vi.mocked(audit).mockClear();
    const stub = stubFor({
      reservations: [RESERVATION],
      reservationWrite: { data: null, error: null },
    });
    await expect(svc(stub).removeLine('order-1', 'line-1')).rejects.toThrow();
    expect(vi.mocked(audit).mock.calls[0]?.[0]).toMatchObject({
      after: { reservation: { synced: false } },
    });
  });
});

// ---------------------------------------------------------------------------
// The requester has to find out (owner decision 2026-07-22: "yes she should be
// notified"), and their open page has to update.
//
// The page live-refreshes via a postgres_changes subscription on the
// order_requests ROW. Line edits touch only order_request_lines, which has no
// trigger onto its parent — verified against production — so without an
// explicit header touch the requester stares at stale quantities.
// ---------------------------------------------------------------------------

describe('telling the requester', () => {
  it('touches the order header so the open page live-refreshes', async () => {
    const stub = stubFor();
    await svc(stub).removeLine('order-1', 'line-1');
    const patch = stub.chainArgs.get('order_requests.update')?.[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(patch).toHaveProperty('updated_at');
  });

  it('notifies the requester when someone ELSE edits their order', async () => {
    // svc() acts as 'approver-1'; the order was raised by 'requester-1'.
    const stub = stubFor();
    await svc(stub).removeLine('order-1', 'line-1');
    expect(notifySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'requester-1',
        type: 'order_request.line_removed',
        // Resolves on mobile too: web-path-rewrite maps this to /order/<id>.
        link: '/dashboard/orders/order-1',
      }),
    );
  });

  it('does NOT notify the requester about their own edit', async () => {
    const stub = stubFor();
    await svc(stub, { userId: 'requester-1' }).removeLine('order-1', 'line-1');
    expect(notifySpy).not.toHaveBeenCalled();
  });

  it('says what actually changed rather than "your order was updated"', async () => {
    const stub = stubFor();
    await svc(stub).updateLineQuantity('order-1', 'line-1', 4);
    expect(notifySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'order_request.line_quantity_changed',
        body: expect.stringContaining('4'),
      }),
    );
  });
});
