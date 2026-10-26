import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { ModuleId, Role } from '@stockpilot/core';

import { ForbiddenError } from '@/lib/auth/warehouse';
import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

import { OrderRequestsService } from './order-requests';

vi.mock('@/lib/auth/warehouse', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth/warehouse')>()),
  assertWarehouseAccess: vi.fn(),
}));
vi.mock('./audit', () => ({ audit: vi.fn(async () => {}) }));

// Since 0413 Add items never writes order_request_lines through a client: the
// whole change is ONE call of add_order_request_lines. The admin client is
// routed to the same stub so a stray service-role write would still be seen.
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => adminHandle.client,
}));
const adminHandle: { client: unknown } = { client: null };

// Adding items to an EXISTING order (owner request 2026-07-22). The rules that
// matter: allowed any time BEFORE the order ships, only for the requester or an
// approver, never for an unreceived (expected) item, never for an item hidden
// from new ordering (0413), and topping up an item already on the order must
// increment it rather than duplicate the line.

const ITEM = {
  id: 'item-1',
  name: 'Widget',
  warehouse_id: 'wh-1',
  unit_cost: 5,
  awaiting_first_receipt: false,
  order_catalog_visible: true,
};

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

type RpcAnswer = { data: unknown; error: { message: string; code?: string; hint?: string; details?: string } | null };

/** Header + item lookup, then the one call, in the order addLines makes them. */
function stubFor(
  header: Record<string, unknown>,
  answer: RpcAnswer = { data: { orderId: 'order-1', added: ['item-1'], merged: [] }, error: null },
  items: Array<Record<string, unknown>> = [ITEM],
) {
  return makeSupabaseStub({
    'order_requests.select': { data: header, error: null },
    'inventory_items.select': { data: items, error: null },
    'rpc:add_order_request_lines': answer,
  });
}

const OPEN_HEADER = {
  id: 'order-1',
  status: 'approved',
  warehouse_id: 'wh-1',
  requester_user_id: 'requester-1',
  pick_slip_generated_at: null,
  order_number: 12,
};

/** Nothing reached order_request_lines through a client (user or admin). */
function expectNoClientLineWrites(stub: ReturnType<typeof makeSupabaseStub>) {
  expect(stub.chainsAll.get('order_request_lines.insert')).toBeUndefined();
  expect(stub.chainsAll.get('order_request_lines.update')).toBeUndefined();
}

describe('OrderRequestsService.addLines', () => {
  it('adds a new line to an open order through ONE add_order_request_lines call', async () => {
    const stub = stubFor(OPEN_HEADER);
    const res = await svc(stub).addLines('order-1', [{ itemId: 'item-1', quantity: 3 }]);
    expect(res.added).toBe(1);
    expect(res.merged).toBe(0);
    expect(res.pickSlipStale).toBe(false);
    expect(stub.rpcCalls.filter((c) => c.name === 'add_order_request_lines')).toEqual([
      {
        name: 'add_order_request_lines',
        args: { p_order_id: 'order-1', p_lines: [{ itemId: 'item-1', quantity: 3 }] },
      },
    ]);
    expectNoClientLineWrites(stub);
  });

  it('TOPS UP an item already on the order (the database answers it as merged)', async () => {
    const stub = stubFor(OPEN_HEADER, {
      data: { orderId: 'order-1', added: [], merged: ['item-1'] },
      error: null,
    });
    const res = await svc(stub).addLines('order-1', [{ itemId: 'item-1', quantity: 6 }]);
    expect(res.merged).toBe(1);
    expect(res.added).toBe(0);
    expectNoClientLineWrites(stub);
  });

  it('sends the lines as given: the database sums repeats of one item', async () => {
    const stub = stubFor(OPEN_HEADER);
    await svc(stub).addLines('order-1', [
      { itemId: 'item-1', quantity: 2 },
      { itemId: 'item-1', quantity: 5 },
    ]);
    expect(stub.rpcCalls.find((c) => c.name === 'add_order_request_lines')?.args).toEqual({
      p_order_id: 'order-1',
      p_lines: [
        { itemId: 'item-1', quantity: 2 },
        { itemId: 'item-1', quantity: 5 },
      ],
    });
  });

  it('flags the printed pick slip as stale when one already exists', async () => {
    const stub = stubFor({ ...OPEN_HEADER, pick_slip_generated_at: '2026-07-22T10:00:00Z' });
    const res = await svc(stub).addLines('order-1', [{ itemId: 'item-1', quantity: 1 }]);
    expect(res.pickSlipStale).toBe(true);
  });

  it('still allows additions DURING picking / staging (owner: any time before it ships)', async () => {
    for (const status of ['pick_slip_generated', 'picking_in_progress', 'staged_for_delivery']) {
      const stub = stubFor({ ...OPEN_HEADER, status });
      const res = await svc(stub).addLines('order-1', [{ itemId: 'item-1', quantity: 1 }]);
      expect(res.added + res.merged).toBe(1);
    }
  });

  it('REFUSES once the order has shipped or closed, before the call', async () => {
    for (const status of ['in_transit', 'completed', 'cancelled', 'denied']) {
      const stub = stubFor({ ...OPEN_HEADER, status });
      await expect(
        svc(stub).addLines('order-1', [{ itemId: 'item-1', quantity: 1 }]),
      ).rejects.toMatchObject({ code: 'conflict' });
      expect(stub.rpcCalls).toEqual([]);
    }
  });

  it('lets the REQUESTER add to their own order without approve permission', async () => {
    const stub = stubFor(OPEN_HEADER);
    const res = await svc(stub, { role: 'staff', userId: 'requester-1' }).addLines('order-1', [
      { itemId: 'item-1', quantity: 2 },
    ]);
    expect(res.added).toBe(1);
  });

  it("REFUSES a non-requester who cannot approve orders", async () => {
    const stub = stubFor(OPEN_HEADER);
    await expect(
      svc(stub, { role: 'staff', userId: 'someone-else' }).addLines('order-1', [
        { itemId: 'item-1', quantity: 1 },
      ]),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(stub.rpcCalls).toEqual([]);
  });

  it('REFUSES an item that has never been received (expected phantom)', async () => {
    const stub = stubFor(OPEN_HEADER, undefined, [{ ...ITEM, awaiting_first_receipt: true }]);
    await expect(
      svc(stub).addLines('order-1', [{ itemId: 'item-1', quantity: 1 }]),
    ).rejects.toMatchObject({ code: 'validation_error' });
    expect(stub.rpcCalls).toEqual([]);
  });

  it('rejects a zero/negative quantity and an empty payload', async () => {
    const stub = stubFor(OPEN_HEADER);
    await expect(
      svc(stub).addLines('order-1', [{ itemId: 'item-1', quantity: 0 }]),
    ).rejects.toMatchObject({ code: 'validation_error' });
    await expect(svc(stub).addLines('order-1', [])).rejects.toMatchObject({
      code: 'validation_error',
    });
    expect(stub.rpcCalls).toEqual([]);
  });

  it('rejects more than 200 lines in one change (both callers cap there), before any read', async () => {
    const stub = stubFor(OPEN_HEADER);
    const lines = Array.from({ length: 201 }, () => ({ itemId: 'item-1', quantity: 1 }));
    await expect(svc(stub).addLines('order-1', lines)).rejects.toMatchObject({
      code: 'validation_error',
    });
    expect(stub.fromCalls).toEqual([]);
    expect(stub.rpcCalls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 0413: an item hidden from new ordering (order_catalog_visible = false) is
// never added. The friendly pre-check names it from the caller's own read; a
// hide that commits after that read is refused by the database gate inside
// the same call, and the whole change rolls back.
// ---------------------------------------------------------------------------
describe('addLines refuses an item hidden from new ordering', () => {
  it('pre-check: names the item and never calls the database function', async () => {
    const stub = stubFor(OPEN_HEADER, undefined, [{ ...ITEM, order_catalog_visible: false }]);
    await expect(
      svc(stub).addLines('order-1', [{ itemId: 'item-1', quantity: 1 }]),
    ).rejects.toMatchObject({
      code: 'validation_error',
      message: 'Widget is no longer available for new orders.',
      details: { reason: 'hidden_from_orders', itemId: 'item-1' },
    });
    expect(stub.rpcCalls).toEqual([]);
  });

  it('reads order_catalog_visible with the other line checks', async () => {
    const stub = stubFor(OPEN_HEADER);
    await svc(stub).addLines('order-1', [{ itemId: 'item-1', quantity: 1 }]);
    const select = stub.chainArgsAll.get('inventory_items.select')?.[0]?.[0]?.[0] as string;
    expect(select).toContain('order_catalog_visible');
  });

  it('the database gate (a hide after the read): the same sentence, nothing written', async () => {
    const stub = stubFor(OPEN_HEADER, {
      data: null,
      error: {
        message: 'This item is no longer available for new orders.',
        code: 'P0001',
        hint: 'order_item_hidden',
        details: 'item-1',
      },
    });
    await expect(
      svc(stub).addLines('order-1', [{ itemId: 'item-1', quantity: 1 }]),
    ).rejects.toMatchObject({
      code: 'validation_error',
      message: 'Widget is no longer available for new orders.',
      details: { reason: 'hidden_from_orders', itemId: 'item-1' },
    });
    expectNoClientLineWrites(stub);
  });

  it('a gate refusal naming an id the caller did not read says the item-free sentence', async () => {
    const stub = stubFor(OPEN_HEADER, {
      data: null,
      error: { message: 'x', code: 'P0001', hint: 'order_item_hidden', details: 'other-item' },
    });
    await expect(
      svc(stub).addLines('order-1', [{ itemId: 'item-1', quantity: 1 }]),
    ).rejects.toMatchObject({
      code: 'validation_error',
      message: 'This item is no longer available for new orders.',
    });
  });
});

// ---------------------------------------------------------------------------
// Every refusal of add_order_request_lines, mapped by its hint (never by its
// message), in the words the pre-checks already use.
// ---------------------------------------------------------------------------
describe('addLines maps the database refusals by hint', () => {
  const refuse = (error: NonNullable<RpcAnswer['error']>) =>
    svc(stubFor(OPEN_HEADER, { data: null, error })).addLines('order-1', [
      { itemId: 'item-1', quantity: 2 },
    ]);

  it.each([
    ['other_warehouse', "Widget isn't stocked at this order's warehouse."],
    [
      'awaiting_first_receipt',
      "This item hasn't been received yet: Widget. It can be ordered once its first stock arrives.",
    ],
    ['rental', 'Widget is a rental item. Check it out from Rentals instead of ordering it.'],
    ['kit', "Widget is a pre-assembled kit and can't be put on an order. Order the kit's items instead."],
    ['deleted', 'That item cannot be ordered: it is deleted, a rental item, or not received yet.'],
  ])('order_item_not_addable %s', async (reason, message) => {
    await expect(
      refuse({
        message: 'order_item_not_addable',
        code: 'P0001',
        hint: 'order_item_not_addable',
        details: JSON.stringify({ itemId: 'item-1', reason }),
      }),
    ).rejects.toMatchObject({ code: 'validation_error', message });
  });

  it('order_item_not_addable not_found keeps the not-found refusal', async () => {
    await expect(
      refuse({
        message: 'order_item_not_addable',
        code: 'P0001',
        hint: 'order_item_not_addable',
        details: JSON.stringify({ itemId: 'item-1', reason: 'not_found' }),
      }),
    ).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('order_not_found is not_found', async () => {
    await expect(
      refuse({ message: 'order_not_found', code: 'P0002', hint: 'order_not_found' }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('order_closed is the closed-order conflict', async () => {
    await expect(
      refuse({ message: 'order_closed', code: 'P0001', hint: 'order_closed', details: 'in_transit' }),
    ).rejects.toMatchObject({
      code: 'conflict',
      message: 'This order is already out for delivery — create a new order for the extra items.',
    });
    await expect(
      refuse({ message: 'order_closed', code: 'P0001', hint: 'order_closed', details: 'completed' }),
    ).rejects.toMatchObject({
      code: 'conflict',
      message: 'This order is completed and can no longer be changed.',
    });
  });

  it('order_edit_forbidden is the requester-or-approver refusal', async () => {
    await expect(
      refuse({ message: 'order_edit_forbidden', code: '42501', hint: 'order_edit_forbidden' }),
    ).rejects.toMatchObject({
      code: 'forbidden',
      message: 'Only the requester or someone who can approve orders may add items to it.',
    });
  });

  it('replacement_lines_fixed keeps its reason', async () => {
    await expect(
      refuse({ message: 'replacement_lines_fixed', code: '42501', hint: 'replacement_lines_fixed' }),
    ).rejects.toMatchObject({ code: 'forbidden', details: { reason: 'replacement_lines_fixed' } });
  });

  it('warehouse_read is the order warehouse refusal', async () => {
    await expect(
      refuse({ message: 'warehouse_read', code: '42501', hint: 'warehouse_read' }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('module_disabled is module_disabled', async () => {
    await expect(
      refuse({ message: 'module_disabled', code: '42501', hint: 'module_disabled' }),
    ).rejects.toMatchObject({ code: 'module_disabled' });
  });

  it('order_lines_invalid is a validation_error', async () => {
    await expect(
      refuse({ message: 'order_lines_invalid', code: '22023', hint: 'order_lines_invalid', details: 'quantity' }),
    ).rejects.toMatchObject({ code: 'validation_error' });
  });

  it.each([
    ['That item cannot be ordered: it is deleted, a rental item, or not received yet.', '42501'],
    ['A line needs a real quantity.', '23514'],
  ])('a line guard sentence passes through: "%s" (%s)', async (message, code) => {
    await expect(refuse({ message, code })).rejects.toMatchObject({ code: 'validation_error', message });
  });

  it('any other failure is internal_error', async () => {
    await expect(refuse({ message: 'relation secret', code: 'XX000' })).rejects.toMatchObject({
      code: 'internal_error',
    });
  });
});

// ---------------------------------------------------------------------------
// ONE TRANSACTION (0413; returns RX-3 fix round 1 named it "the later fix").
// Add items used to top up the lines already on the order as separately
// committed service-role UPDATEs and insert the new lines afterwards, so a
// failure after a top-up left part of the change saved and answered a
// non-retryable "partial" conflict. Now every failure means nothing was
// written, so busy is always true and "Try again" is honest.
// ---------------------------------------------------------------------------
describe('addLines is all or nothing', () => {
  it.each([
    ['55P03', 'canceling statement due to lock timeout'],
    ['57014', 'canceling statement due to statement timeout'],
    ['40P01', 'deadlock detected'],
  ])('a call that waited too long or lost a deadlock (%s) is busy: nothing written, send again', async (code, message) => {
    const { audit } = await import('./audit');
    vi.mocked(audit).mockClear();
    const stub = stubFor(OPEN_HEADER, { data: null, error: { message, code } });
    await expect(
      svc(stub).addLines('order-1', [
        { itemId: 'item-1', quantity: 2 },
        { itemId: 'item-1', quantity: 1 },
      ]),
    ).rejects.toMatchObject({
      code: 'conflict',
      message: 'Busy. Try again.',
      details: { reason: 'busy', retryable: true },
    });
    expectNoClientLineWrites(stub);
    // Nothing was written, so nothing is on the order's history.
    expect(vi.mocked(audit)).not.toHaveBeenCalled();
  });

  it('never reports a change the database did not confirm (a malformed answer fails closed)', async () => {
    for (const data of [null, {}, { added: 'x', merged: [] }, { added: [], merged: [1] }]) {
      const stub = stubFor(OPEN_HEADER, { data, error: null });
      await expect(
        svc(stub).addLines('order-1', [{ itemId: 'item-1', quantity: 3 }]),
      ).rejects.toMatchObject({ code: 'internal_error' });
    }
  });

  it('audits exactly what the database answered, with no partial flag', async () => {
    const { audit } = await import('./audit');
    vi.mocked(audit).mockClear();
    const stub = stubFor(OPEN_HEADER, {
      data: { orderId: 'order-1', added: [], merged: ['item-1'] },
      error: null,
    });
    await svc(stub).addLines('order-1', [{ itemId: 'item-1', quantity: 4 }]);
    expect(vi.mocked(audit)).toHaveBeenCalledTimes(1);
    const payload = vi.mocked(audit).mock.calls[0]?.[0] as { event: string; after: Record<string, unknown> };
    expect(payload).toMatchObject({
      event: 'order_request.lines_added',
      entityId: 'order-1',
      after: { added: 0, merged: 1, items: [{ itemId: 'item-1', name: 'Widget', quantity: 4 }] },
    });
    expect(payload.after).not.toHaveProperty('partial');
  });

  it('the partial path is gone from the service (no partial refusal, no service-role line write in addLines)', () => {
    const src = readFileSync(path.join(__dirname, 'order-requests.ts'), 'utf8');
    expect(src).not.toMatch(/addLinesPartialRefusal|ADD_LINES_PARTIAL_COPY|failAfterWrite/);
    expect(src).not.toMatch(/reason: 'partial'/);
    const start = src.indexOf('  async addLines(');
    const end = src.indexOf('\n  }\n', start);
    const body = src.slice(start, end);
    expect(body).toContain("rpc('add_order_request_lines'");
    expect(body).not.toMatch(/createAdminClient|from\('order_request_lines'\)/);
  });
});
