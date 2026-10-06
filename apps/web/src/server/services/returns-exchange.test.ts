import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub, type MockCall } from '@/test/supabase-mock';

import type { ModuleId } from '@stockpilot/core';

/**
 * RMAService's exchange (returns RX-2, migration 0396): the approval that
 * creates the linked replacement order, changing, cancelling, releasing and
 * preparing it, the candidates search, the kill switch and the requester
 * paths held back until RX-3. Every write is one database function; the
 * replacement order's own trail (audit, events) and every message run only
 * for the call that answered `changed: true`.
 */

const auditMock = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => undefined));
vi.mock('@/server/services/audit', () => ({ audit: auditMock, insertAuditRowReported: vi.fn(async () => true) }));
vi.mock('./audit', () => ({ audit: auditMock, insertAuditRowReported: vi.fn(async () => true) }));

const dispatchMock = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => undefined));
vi.mock('./integration-events', () => ({ dispatchEvent: dispatchMock }));

const notifyRequester = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => undefined));
vi.mock('./returns-notify', () => ({
  notifyRequesterReturnEvent: notifyRequester,
  notifyStaffNewReturnRequest: vi.fn(async () => undefined),
}));

vi.mock('./returns-workbench', () => ({
  buildReturnWorkbench: vi.fn(async (_ctx: unknown, id: string) => ({ return: { id } })),
  buildReturnListPage: vi.fn(async () => ({ rows: [] })),
}));

const invalidateMock = vi.hoisted(() => vi.fn());
vi.mock('./lib/inventory-list-cache', () => ({ invalidateInventoryListAfterWrite: invalidateMock }));

const broadcastMock = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('@/lib/realtime/broadcast', () => ({ broadcastOrderChanged: broadcastMock }));

// The completion email when an RMA cancel closes a part-handed-over replacement.
const returnPromptMock = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => ({ sent: true })));
vi.mock('@/server/email/return-prompt', () => ({ maybeSendReturnPrompt: returnPromptMock }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ admin: true }) }));

const prepareMock = vi.hoisted(() =>
  vi.fn(async (_id: string, _opts: unknown) => ({
    ran: [{ step: 'pick_slip', outcome: 'done' }],
    status: 'staged_for_pickup',
    fulfillmentType: 'pickup',
  })),
);
vi.mock('./order-requests', () => ({
  OrderRequestsService: vi.fn(function () {
    return { prepareForHandover: prepareMock };
  }),
}));

import { ServiceError } from './context';
import { createPortalReturn, createRequesterReturn, parseReplacementSummary, RMAService, returnRpcError } from './returns';

const MODULES = new Set<ModuleId>(['returns', 'orders']);
const ORDER_ID = '11111111-1111-4111-8111-111111111111';
const OLINE_ID = '22222222-2222-4222-8222-222222222222';
const ITEM_L = '33333333-3333-4333-8333-333333333333';
const RET_ID = '55555555-5555-4555-8555-555555555555';
const RLINE_ID = '66666666-6666-4666-8666-666666666666';
const XLINE_ID = '77777777-7777-4777-8777-777777777777';
const REPL_ID = '88888888-8888-4888-8888-888888888888';
const OLD_REPL_ID = '99999999-9999-4999-8999-999999999999';

const HEADER = {
  id: RET_ID,
  organization_id: 'org-test',
  order_request_id: ORDER_ID,
  return_number: 'RMA-20261005-ABC123',
  status: 'approved',
  source: 'requester',
  order_request: { order_number: 103, warehouse_id: 'wh-1' },
};

const SUMMARY = {
  orderId: REPL_ID,
  orderNumber: 104,
  status: 'approved',
  short: false,
  revision: 1,
  lines: [{ itemId: ITEM_L, orderLineId: 'ol-1', requested: 1, held: 1 }],
};

/** order_requests reads, told apart by what they select. */
function orderReads(opts: { live?: { id: string; status: string; order_number: number } | null; after?: string }) {
  return (call: MockCall) => {
    const sel = String(call.args[call.methods.indexOf('select')]?.[0] ?? '');
    if (sel === 'id, status, order_number') return { data: opts.live ? [opts.live] : [], error: null };
    if (sel === 'status') return { data: [{ status: opts.after ?? 'cancelled' }], error: null };
    return { data: [{ id: ORDER_ID, status: 'completed' }], error: null };
  };
}

function svcFor(results: Record<string, unknown>, ctx: Parameters<typeof makeServiceContext>[1] = {}) {
  const stub = makeSupabaseStub({
    'returns.select': { data: [HEADER], error: null },
    'return_lines.select': { data: [{ id: RLINE_ID, item_id: 'item-m', quantity: 1 }], error: null },
    'return_exchange_lines.select': {
      data: [{ return_line_id: RLINE_ID, approved_item_id: ITEM_L, approved_quantity: 1 }],
      error: null,
    },
    'order_requests.select': orderReads({}),
    ...results,
  } as never);
  const svc = new RMAService(makeServiceContext(stub.client, { role: 'manager', enabledModules: MODULES, ...ctx }));
  return { stub, svc };
}

const rpcError = (hint: string, code = 'P0001', details: string | null = null) => ({
  data: null,
  error: { code, hint, message: hint, details },
});

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('the exchange hints (plan 3.11), each mapped by hint', () => {
  it.each([
    ['replacement_unavailable', 'validation_error'],
    ['exchange_item_not_eligible', 'validation_error'],
    ['exchange_quantity_exceeds_return', 'validation_error'],
    ['replacement_site_not_available', 'validation_error'],
    ['replacement_already_drawn', 'conflict'],
    ['replacement_handed_over', 'conflict'],
    ['replacement_not_waiting', 'conflict'],
    ['replacement_waiting_for_return', 'conflict'],
    ['replacement_cancel_via_return', 'forbidden'],
    ['replacement_lines_fixed', 'forbidden'],
    ['replacement_link_server_only', 'forbidden'],
    ['replacement_link_immutable', 'forbidden'],
    ['return_exchange_through_rpc', 'forbidden'],
    ['exchange_not_available', 'validation_error'],
    ['replacement_requester_unavailable', 'validation_error'],
    ['exchange_line_invalid', 'validation_error'],
    ['exchange_request_immutable', 'forbidden'],
    ['orders_approve', 'forbidden'],
  ])('%s -> %s', (hint, code) => {
    const e = returnRpcError({ code: 'P0001', hint, message: 'raw database words' });
    expect(e.code).toBe(code);
    expect(e.details?.reason).toBe(hint);
    expect(e.message).not.toBe('raw database words');
  });

  it('replacement_unavailable carries the short items as structured detail', () => {
    const e = returnRpcError({
      code: 'P0001',
      hint: 'replacement_unavailable',
      message: 'x',
      details: JSON.stringify([{ itemId: ITEM_L, needed: 1, available: 0 }]),
    });
    expect(e.details?.detail).toEqual([{ itemId: ITEM_L, needed: 1, available: 0 }]);
  });
});

describe('parseReplacementSummary', () => {
  it('reads the summary defensively; no order id is no replacement', () => {
    expect(parseReplacementSummary(SUMMARY)).toEqual(SUMMARY);
    expect(parseReplacementSummary({ status: 'approved' })).toBeNull();
    expect(parseReplacementSummary(null)).toBeNull();
    expect(parseReplacementSummary({ orderId: REPL_ID, lines: 'x' })).toMatchObject({ lines: [], short: false });
  });
});

describe('approve with an exchange (approve_return + the 0396 hook)', () => {
  const DECISION = {
    lines: [{ returnLineId: RLINE_ID, disposition: 'restock' as const, restock: { target: 'original' as const } }],
    exchange: [{ action: 'approve' as const, exchangeLineId: XLINE_ID }],
    replacement: { whenShort: 'refuse' as const },
  };

  it('passes the exchange decisions through; the replacement order gets its own created/approved trail and events', async () => {
    const { stub, svc } = svcFor({
      'rpc:approve_return': {
        data: { changed: true, replay: false, returnId: RET_ID, revision: 1, status: 'approved', replacement: SUMMARY },
        error: null,
      },
    });
    const answer = await svc.approve(RET_ID, { expectedRevision: 0, decision: DECISION });
    expect(stub.rpcCalls.find((c) => c.name === 'approve_return')!.args).toMatchObject({
      p_decision: { exchange: [{ action: 'approve', exchangeLineId: XLINE_ID }], replacement: { whenShort: 'refuse' } },
    });
    expect(answer.replacement).toEqual(SUMMARY);
    const events = auditMock.mock.calls.map((c) => (c[0] as { event: string }).event);
    expect(events).toEqual([
      'return.approved',
      'return.disposition_planned',
      'return.exchange_approved',
      'order_request.created',
      'order_request.approved',
    ]);
    const created = auditMock.mock.calls[3]![0] as { entityId: string; extra: Record<string, unknown> };
    expect(created.entityId).toBe(REPL_ID);
    expect(created.extra).toEqual({
      replacementForReturnId: RET_ID,
      returnNumber: 'RMA-20261005-ABC123',
      originalOrderId: ORDER_ID,
      revision: 1,
    });
    expect(dispatchMock.mock.calls.map((c) => c[1])).toEqual([
      'return.approved',
      'return.exchange_approved',
      'order.created',
      'order.approved',
    ]);
    expect(dispatchMock.mock.calls[1]![2]).toEqual({
      returnId: RET_ID,
      returnNumber: 'RMA-20261005-ABC123',
      originalOrderId: ORDER_ID,
      exchangeLines: [{ returnedItemId: 'item-m', quantity: 1, replacementItemId: ITEM_L, approvedQuantity: 1 }],
      replacementOrderId: REPL_ID,
      replacementOrderNumber: 'SO-000104',
    });
    expect(dispatchMock.mock.calls[2]![2]).toMatchObject({ id: REPL_ID, replacementForReturnId: RET_ID, returnNumber: 'RMA-20261005-ABC123' });
    expect(notifyRequester).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'exchange_approved', linkOrderId: REPL_ID, channel: 'staff' }),
    );
    expect(invalidateMock).toHaveBeenCalledWith('org-test', 'return.replacement');
  });

  it('a backordered replacement tells the requester it is not in stock yet', async () => {
    const { svc } = svcFor({
      'rpc:approve_return': {
        data: { changed: true, replay: false, revision: 1, status: 'approved', replacement: { ...SUMMARY, short: true } },
        error: null,
      },
    });
    await svc.approve(RET_ID, { expectedRevision: 0, decision: { ...DECISION, replacement: { whenShort: 'backorder' } } });
    expect(notifyRequester).toHaveBeenCalledWith(expect.objectContaining({ event: 'exchange_approved_short' }));
  });

  // RX-2 review fix P28: the requester asked for a return only and staff
  // added the replacement at approval: never "Your exchange was approved".
  it('a requester return whose every exchange line staff added hears "The warehouse added a replacement for you"', async () => {
    const staffLines = {
      'return_exchange_lines.select': {
        data: [{ return_line_id: RLINE_ID, approved_item_id: ITEM_L, approved_quantity: 1, requested_by_kind: 'staff' }],
        error: null,
      },
    };
    const reserved = svcFor({
      ...staffLines,
      'rpc:approve_return': { data: { changed: true, replay: false, revision: 1, status: 'approved', replacement: SUMMARY }, error: null },
    });
    await reserved.svc.approve(RET_ID, { expectedRevision: 0, decision: DECISION });
    expect(notifyRequester).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'return_approved_replacement_added', linkOrderId: REPL_ID, channel: 'staff' }),
    );
    vi.clearAllMocks();
    const short = svcFor({
      ...staffLines,
      'rpc:approve_return': {
        data: { changed: true, replay: false, revision: 1, status: 'approved', replacement: { ...SUMMARY, short: true } },
        error: null,
      },
    });
    await short.svc.approve(RET_ID, { expectedRevision: 0, decision: DECISION });
    expect(notifyRequester).toHaveBeenCalledWith(expect.objectContaining({ event: 'return_approved_replacement_added_short' }));
    vi.clearAllMocks();
    // The requester's own exchange request keeps the exchange words.
    const own = svcFor({
      'return_exchange_lines.select': {
        data: [{ return_line_id: RLINE_ID, approved_item_id: ITEM_L, approved_quantity: 1, requested_by_kind: 'requester' }],
        error: null,
      },
      'rpc:approve_return': { data: { changed: true, replay: false, revision: 1, status: 'approved', replacement: SUMMARY }, error: null },
    });
    await own.svc.approve(RET_ID, { expectedRevision: 0, decision: DECISION });
    expect(notifyRequester).toHaveBeenCalledWith(expect.objectContaining({ event: 'exchange_approved' }));
  });

  // RX-2 review fix P23: the steps answer carries what the approval created,
  // so both screens say it ("Approved. Replacement order SO-000104 created
  // and 1 reserved."), never only "Return approved.".
  it('the steps answer carries the approval\'s status and replacement for the outcome words', async () => {
    const { svc } = svcFor({
      'rpc:approve_return': { data: { changed: true, replay: false, revision: 1, status: 'approved', replacement: SUMMARY }, error: null },
    });
    const { ran } = await svc.runSteps(RET_ID, { steps: ['approve'], expectedRevision: 0, approve: DECISION } as never);
    expect(ran).toEqual([{ step: 'approve', outcome: 'done', approval: { status: 'approved', replacement: SUMMARY } }]);
  });

  it('a replay (changed false) writes and sends nothing', async () => {
    const { svc } = svcFor({
      'rpc:approve_return': {
        data: { changed: false, replay: true, revision: 1, status: 'approved', replacement: SUMMARY },
        error: null,
      },
    });
    const answer = await svc.approve(RET_ID, { expectedRevision: 0, decision: DECISION });
    expect(answer).toMatchObject({ changed: false, replay: true, replacement: SUMMARY });
    expect(auditMock).not.toHaveBeenCalled();
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(notifyRequester).not.toHaveBeenCalled();
  });

  it('short with refuse: the numbers come back as the refusal, nothing is written', async () => {
    const { svc } = svcFor({
      'rpc:approve_return': rpcError('replacement_unavailable', 'P0001', JSON.stringify([{ itemId: ITEM_L, needed: 1, available: 0 }])),
    });
    const e = await svc.approve(RET_ID, { expectedRevision: 0, decision: DECISION }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ServiceError);
    expect((e as ServiceError).details).toMatchObject({ reason: 'replacement_unavailable', detail: [{ itemId: ITEM_L, needed: 1, available: 0 }] });
    expect(auditMock).not.toHaveBeenCalled();
  });
});

describe('the kill switch (RETURNS_EXCHANGE_CREATE=off, plan 10.2)', () => {
  it('refuses a new exchange on create before anything runs; a plain return still goes through', async () => {
    vi.stubEnv('RETURNS_EXCHANGE_CREATE', 'off');
    const { stub, svc } = svcFor({
      'rpc:create_return_request': { data: { changed: true, returnId: RET_ID, channel: 'staff' }, error: null },
    });
    const e = await svc
      .createFromOrder(ORDER_ID, { lines: [{ orderRequestLineId: OLINE_ID, quantity: 1, exchange: { itemId: ITEM_L } }] })
      .catch((x: unknown) => x);
    expect((e as ServiceError).details?.reason).toBe('exchange_not_available');
    expect((e as ServiceError).message).toBe('Exchanges are turned off right now. Request a return only.');
    expect(stub.rpcCalls).toEqual([]);
    await svc.createFromOrder(ORDER_ID, { lines: [{ orderRequestLineId: OLINE_ID, quantity: 1 }] });
    expect(stub.rpcCalls[0]!.name).toBe('create_return_request');
  });

  it('refuses "Add a replacement" at approval, but approving a requested exchange is the lifecycle and goes on', async () => {
    vi.stubEnv('RETURNS_EXCHANGE_CREATE', 'off');
    const { stub, svc } = svcFor({
      'rpc:approve_return': { data: { changed: false, replay: true, revision: 1, status: 'approved' }, error: null },
    });
    const lines = [{ returnLineId: RLINE_ID, disposition: 'restock' as const }];
    const add = await svc
      .approve(RET_ID, { expectedRevision: 0, decision: { lines, exchange: [{ action: 'add', returnLineId: RLINE_ID, itemId: ITEM_L }] } })
      .catch((x: unknown) => x);
    expect((add as ServiceError).details?.reason).toBe('exchange_not_available');
    expect(stub.rpcCalls).toEqual([]);
    await svc.approve(RET_ID, { expectedRevision: 0, decision: { lines, exchange: [{ action: 'approve', exchangeLineId: XLINE_ID }] } });
    expect(stub.rpcCalls.map((c) => c.name)).toEqual(['approve_return']);
  });

  it('any other value leaves exchanges on', async () => {
    vi.stubEnv('RETURNS_EXCHANGE_CREATE', 'on');
    const { stub, svc } = svcFor({
      'rpc:create_return_request': { data: { changed: false, replay: true, returnId: RET_ID, channel: 'staff' }, error: null },
    });
    await svc.createFromOrder(ORDER_ID, { lines: [{ orderRequestLineId: OLINE_ID, quantity: 1, exchange: { itemId: ITEM_L } }] });
    expect(stub.rpcCalls[0]!.args).toMatchObject({ p_request: { lines: [{ exchange: { itemId: ITEM_L } }] } });
  });
});

describe('the requester paths hold exchanges back until RX-3', () => {
  it('a token or portal body naming an exchange is refused before any read or call', async () => {
    const admin = makeSupabaseStub({});
    const body = { lines: [{ orderRequestLineId: OLINE_ID, quantity: 1, exchange: { itemId: ITEM_L } }] };
    const a = await createRequesterReturn(admin.client, 'a'.repeat(8) + '-aaaa-4aaa-8aaa-' + 'a'.repeat(12), body).catch((x: unknown) => x);
    expect((a as ServiceError).details?.reason).toBe('exchange_not_available');
    const b = await createPortalReturn(
      admin.client,
      { organizationId: 'org-test', customerId: 'c1', orderRequestId: ORDER_ID, portalUserId: 'u1' },
      body,
    ).catch((x: unknown) => x);
    expect((b as ServiceError).details?.reason).toBe('exchange_not_available');
    expect(admin.fromCalls).toEqual([]);
    expect(admin.rpcCalls).toEqual([]);
  });
});

describe('changeReplacement (change_return_replacement)', () => {
  const BODY = {
    expectedRevision: 1,
    lines: [{ exchangeLineId: XLINE_ID, itemId: ITEM_L }],
    reason: '  Swapped for the navy one  ',
    whenShort: 'refuse' as const,
  };

  it('sends the six arguments; a substitution cancels the old order and issues the new one, with their own trail', async () => {
    const { stub, svc } = svcFor({
      'rpc:change_return_replacement': {
        data: {
          changed: true,
          replay: false,
          revision: 2,
          status: 'approved',
          mode: 'substitute',
          cancelledOrderId: OLD_REPL_ID,
          replacement: { ...SUMMARY, revision: 2 },
        },
        error: null,
      },
    });
    const answer = await svc.changeReplacement(RET_ID, BODY);
    expect(stub.rpcCalls[0]).toEqual({
      name: 'change_return_replacement',
      args: {
        p_return_id: RET_ID,
        p_expected_revision: 1,
        p_lines: [{ exchangeLineId: XLINE_ID, itemId: ITEM_L }],
        p_reason: 'Swapped for the navy one',
        p_when_short: 'refuse',
        p_replacement: null,
      },
    });
    expect(answer).toMatchObject({ changed: true, mode: 'substitute', cancelledOrderId: OLD_REPL_ID, revision: 2 });
    expect(auditMock.mock.calls.map((c) => [(c[0] as { event: string }).event, (c[0] as { entityId: string }).entityId])).toEqual([
      ['order_request.cancelled', OLD_REPL_ID],
      ['return.replacement_changed', RET_ID],
      ['order_request.created', REPL_ID],
      ['order_request.approved', REPL_ID],
    ]);
    expect(dispatchMock.mock.calls.map((c) => c[1])).toEqual(['order.cancelled', 'order.created', 'order.approved']);
    expect(notifyRequester).toHaveBeenCalledWith(expect.objectContaining({ event: 'replacement_changed', linkOrderId: REPL_ID }));
    // The requester never gets the reason.
    expect(JSON.stringify(notifyRequester.mock.calls)).not.toContain('navy');
  });

  it('a re-issue after a cancel is audited as replacement_issued', async () => {
    const { svc } = svcFor({
      'rpc:change_return_replacement': {
        data: { changed: true, revision: 3, status: 'received', mode: 'reissue', cancelledOrderId: null, replacement: SUMMARY },
        error: null,
      },
    });
    await svc.changeReplacement(RET_ID, { ...BODY, lines: [] });
    expect(auditMock.mock.calls.map((c) => (c[0] as { event: string }).event)).toEqual([
      'return.replacement_issued',
      'order_request.created',
      'order_request.approved',
    ]);
  });

  it('a replay or a refusal writes and sends nothing', async () => {
    const replay = svcFor({
      'rpc:change_return_replacement': { data: { changed: false, replay: true, revision: 2, status: 'approved', replacement: SUMMARY }, error: null },
    });
    expect(await replay.svc.changeReplacement(RET_ID, BODY)).toMatchObject({ changed: false, replay: true });
    const drawn = svcFor({ 'rpc:change_return_replacement': rpcError('replacement_already_drawn') });
    const e = await drawn.svc.changeReplacement(RET_ID, BODY).catch((x: unknown) => x);
    expect((e as ServiceError).details?.reason).toBe('replacement_already_drawn');
    expect(auditMock).not.toHaveBeenCalled();
    expect(notifyRequester).not.toHaveBeenCalled();
  });

  it('needs a reason (core schema) before any call', async () => {
    const { stub, svc } = svcFor({});
    const e = await svc.changeReplacement(RET_ID, { ...BODY, reason: '   ' }).catch((x: unknown) => x);
    expect((e as ServiceError).code).toBe('validation_error');
    expect(stub.rpcCalls).toEqual([]);
  });
});

describe('cancelReplacement (cancel_return_replacement)', () => {
  it('a picked replacement goes back to Staging on record: the inventory lists refresh, the order gets its trail', async () => {
    const { stub, svc } = svcFor({
      'order_requests.select': orderReads({ live: { id: REPL_ID, status: 'staged_for_pickup', order_number: 104 } }),
      'rpc:cancel_return_replacement': {
        data: { changed: true, status: 'approved', revision: 2, cancelledOrderId: REPL_ID, drawn: true, inTransit: false },
        error: null,
      },
    });
    const answer = await svc.cancelReplacement(RET_ID, { expectedRevision: 1, reason: 'Wrong colour' });
    expect(stub.rpcCalls[0]).toEqual({
      name: 'cancel_return_replacement',
      args: { p_return_id: RET_ID, p_expected_revision: 1, p_reason: 'Wrong colour' },
    });
    expect(answer).toMatchObject({ changed: true, drawn: true, cancelledOrderId: REPL_ID });
    expect(invalidateMock).toHaveBeenCalledWith('org-test', 'return.replacement_cancel');
    expect(auditMock.mock.calls.map((c) => (c[0] as { event: string }).event)).toEqual([
      'order_request.cancelled',
      'return.replacement_cancelled',
    ]);
    expect(dispatchMock).toHaveBeenCalledWith('org-test', 'order.cancelled', expect.objectContaining({ id: REPL_ID, orderNumber: 'SO-000104' }));
    expect(notifyRequester).toHaveBeenCalledWith(expect.objectContaining({ event: 'replacement_cancelled' }));
  });

  it('nothing live answers changed false and writes nothing; no reason is refused before the call', async () => {
    const { stub, svc } = svcFor({
      'rpc:cancel_return_replacement': { data: { changed: false, status: 'approved', replacement: 'none' }, error: null },
    });
    expect(await svc.cancelReplacement(RET_ID, { expectedRevision: 1, reason: 'x' })).toMatchObject({ changed: false, cancelledOrderId: null });
    expect(auditMock).not.toHaveBeenCalled();
    const e = await svc.cancelReplacement(RET_ID, { expectedRevision: 1, reason: '' }).catch((x: unknown) => x);
    expect((e as ServiceError).details?.reason).toBe('reason_required');
    // Desk check F7: the revision the caller saw is required.
    const noRevision = await svc.cancelReplacement(RET_ID, { reason: 'x' }).catch((x: unknown) => x);
    expect((noRevision as ServiceError).code).toBe('validation_error');
    expect(stub.rpcCalls).toHaveLength(1);
  });
});

// Desk check F9: "Close as return only" after a replacement cancel.
describe('declineReplacement (decline_return_replacement)', () => {
  it('closes the cancelled lines as return only with the revision and reason, audits once; nothing to close writes nothing', async () => {
    const { stub, svc } = svcFor({
      'rpc:decline_return_replacement': { data: { changed: true, status: 'closed', revision: 2, declined: 1 }, error: null },
    });
    const answer = await svc.declineReplacement(RET_ID, { expectedRevision: 2, reason: 'Refund instead' });
    expect(stub.rpcCalls[0]).toEqual({
      name: 'decline_return_replacement',
      args: { p_return_id: RET_ID, p_expected_revision: 2, p_reason: 'Refund instead' },
    });
    expect(answer).toEqual({ changed: true, status: 'closed', revision: 2, declined: 1 });
    expect(auditMock.mock.calls.map((c) => (c[0] as { event: string }).event)).toEqual(['return.replacement_declined']);
    // RX-2 review fix P15: the requester of a requester-sourced RMA hears that
    // no replacement will be sent (in-app or email), never the reason.
    expect(notifyRequester).toHaveBeenCalledTimes(1);
    const told = notifyRequester.mock.calls[0]![0] as Record<string, unknown>;
    expect(told).toMatchObject({ event: 'replacement_closed_return_only', source: 'requester', returnId: RET_ID, orderId: ORDER_ID });
    expect(Object.keys(told)).not.toContain('reason');
    expect(JSON.stringify(told)).not.toContain('Refund instead');

    vi.clearAllMocks();
    const none = svcFor({ 'rpc:decline_return_replacement': { data: { changed: false, status: 'closed', revision: 2, declined: 0 }, error: null } });
    expect(await none.svc.declineReplacement(RET_ID, { expectedRevision: 2, reason: 'x' })).toMatchObject({ changed: false, declined: 0 });
    expect(auditMock).not.toHaveBeenCalled();
    expect(notifyRequester).not.toHaveBeenCalled();
  });

  it('the revision and a reason are required before the call; a stale revision is the database\'s return_changed', async () => {
    const { stub, svc } = svcFor({
      'rpc:decline_return_replacement': { data: null, error: { code: 'P0001', hint: 'return_changed', message: 'return_changed' } },
    });
    for (const body of [{ reason: 'x' }, { expectedRevision: 2, reason: '' }]) {
      const e = await svc.declineReplacement(RET_ID, body).catch((x: unknown) => x);
      expect((e as ServiceError).code).toBe('validation_error');
    }
    expect(stub.rpcCalls).toEqual([]);
    const stale = await svc.declineReplacement(RET_ID, { expectedRevision: 1, reason: 'x' }).catch((x: unknown) => x);
    expect((stale as ServiceError).details?.reason).toBe('return_changed');
  });
});

describe('releaseEarly (release_return_replacement_early)', () => {
  it('releases with the reason, audits once and pings the order page', async () => {
    const { stub, svc } = svcFor({
      'rpc:release_return_replacement_early': {
        data: { changed: true, replay: false, status: 'approved', orderId: REPL_ID, releasedAt: '2026-10-05T12:00:00Z' },
        error: null,
      },
    });
    const answer = await svc.releaseEarly(RET_ID, { orderId: REPL_ID, reason: 'Swap at delivery: the driver collects the returned item.' });
    // Desk check F7: the database releases only the replacement the caller saw.
    expect(stub.rpcCalls[0]!.args).toEqual({
      p_return_id: RET_ID,
      p_order_id: REPL_ID,
      p_reason: 'Swap at delivery: the driver collects the returned item.',
    });
    expect(answer).toMatchObject({ changed: true, orderId: REPL_ID, notNeeded: false });
    expect(auditMock.mock.calls.map((c) => [(c[0] as { event: string }).event, (c[0] as { entityId: string }).entityId])).toEqual([
      ['return.replacement_released', RET_ID],
      // The replacement order's own timeline names the release.
      ['order_request.released_early', REPL_ID],
    ]);
    expect(broadcastMock).toHaveBeenCalledWith('org-test', REPL_ID);
  });

  it('a received return answers not needed; a repeat answers replay; neither writes', async () => {
    const notNeeded = svcFor({
      'rpc:release_return_replacement_early': { data: { changed: false, status: 'received', reason: 'not_needed' }, error: null },
    });
    expect(await notNeeded.svc.releaseEarly(RET_ID, { orderId: REPL_ID, reason: 'x' })).toMatchObject({ changed: false, notNeeded: true });
    const replay = svcFor({
      'rpc:release_return_replacement_early': { data: { changed: false, replay: true, status: 'approved', orderId: REPL_ID }, error: null },
    });
    expect(await replay.svc.releaseEarly(RET_ID, { orderId: REPL_ID, reason: 'x' })).toMatchObject({ replay: true, notNeeded: false });
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('a reason over 500 characters is refused before the call', async () => {
    const { stub, svc } = svcFor({});
    const e = await svc.releaseEarly(RET_ID, { orderId: REPL_ID, reason: 'x'.repeat(501) }).catch((x: unknown) => x);
    expect((e as ServiceError).code).toBe('validation_error');
    const noOrder = await svc.releaseEarly(RET_ID, { reason: 'x' }).catch((x: unknown) => x);
    expect((noOrder as ServiceError).code).toBe('validation_error');
    expect(stub.rpcCalls).toEqual([]);
  });
});

describe('candidates (return_exchange_candidates)', () => {
  const ANSWER = {
    orderId: ORDER_ID,
    orderRequestLineId: OLINE_ID,
    returnedItemId: 'item-m',
    groupId: 'g1',
    siblings: [{ itemId: ITEM_L, name: 'Shirt', variantSize: 'L', sibling: true, onHand: 3, held: 1, free: 2 }],
    matches: [],
  };

  it('asks for the RMA order line; a query under two characters is no query', async () => {
    const { stub, svc } = svcFor({ 'rpc:return_exchange_candidates': { data: ANSWER, error: null } });
    const got = await svc.candidates(RET_ID, { line: OLINE_ID, q: 'n' });
    expect(stub.rpcCalls[0]!.args).toEqual({ p_order_id: ORDER_ID, p_order_request_line_id: OLINE_ID, p_query: null, p_limit: 30 });
    expect(got.siblings[0]).toMatchObject({ itemId: ITEM_L, free: 2 });
    await svc.candidates(RET_ID, { line: OLINE_ID, q: '  navy  ' });
    expect(stub.rpcCalls[1]!.args).toMatchObject({ p_query: 'navy' });
  });

  it('the create dialog asks before the RMA exists, for an order in the active organization', async () => {
    const { stub, svc } = svcFor({ 'rpc:return_exchange_candidates': { data: ANSWER, error: null } });
    await svc.candidatesForOrder(ORDER_ID, { line: OLINE_ID });
    expect(stub.rpcCalls[0]!.args).toMatchObject({ p_order_id: ORDER_ID });
    const viewer = svcFor({}, { role: 'viewer' });
    await expect(viewer.svc.candidatesForOrder(ORDER_ID, { line: OLINE_ID })).rejects.toBeInstanceOf(ServiceError);
  });
});

describe('prepareReplacement (plan 3.3.8)', () => {
  it('runs the order steps on the live replacement and never signs', async () => {
    const { svc } = svcFor({
      'order_requests.select': orderReads({ live: { id: REPL_ID, status: 'approved', order_number: 104 } }),
    });
    const answer = await svc.prepareReplacement(RET_ID, {});
    expect(prepareMock).toHaveBeenCalledWith(REPL_ID, { stopAt: 'staged' });
    expect(answer).toMatchObject({ orderId: REPL_ID, status: 'staged_for_pickup' });
  });

  it('no live replacement is a conflict, not a call', async () => {
    const { svc } = svcFor({ 'order_requests.select': orderReads({ live: null }) });
    const e = await svc.prepareReplacement(RET_ID, {}).catch((x: unknown) => x);
    expect((e as ServiceError).details?.reason).toBe('replacement_not_live');
    expect(prepareMock).not.toHaveBeenCalled();
  });
});

describe('cancel with a live replacement (X-2)', () => {
  it('the replacement cancelled by cancel_return gets its own trail; the return keeps its own', async () => {
    const { svc } = svcFor({
      'order_requests.select': orderReads({ live: { id: REPL_ID, status: 'approved', order_number: 104 }, after: 'cancelled' }),
      'rpc:cancel_return': { data: { changed: true, status: 'cancelled' }, error: null },
    });
    await svc.cancel(RET_ID, { reason: 'Customer kept it' });
    expect(auditMock.mock.calls.map((c) => [(c[0] as { event: string }).event, (c[0] as { entityId: string }).entityId])).toEqual([
      ['order_request.cancelled', REPL_ID],
      ['return.cancelled', RET_ID],
    ]);
  });

  it('a handed-over replacement stays as it is: only the return is cancelled', async () => {
    const { svc } = svcFor({
      'order_requests.select': orderReads({ live: { id: REPL_ID, status: 'completed', order_number: 104 }, after: 'completed' }),
      'rpc:cancel_return': { data: { changed: true, status: 'cancelled' }, error: null },
    });
    await svc.cancel(RET_ID, { reason: 'Customer kept it' });
    expect(auditMock.mock.calls.map((c) => (c[0] as { event: string }).event)).toEqual(['return.cancelled']);
    // Already completed before the cancel: its email went then.
    expect(returnPromptMock).not.toHaveBeenCalled();
  });

  // RX-2 review fix: 0396's cancel closes a part-handed-over replacement as
  // delivered-partial; an email-only requester then gets "Your replacement
  // order was closed" through the same one-time return prompt a close-partial
  // sends from the order page.
  it('a part-handed-over replacement the cancel closed gets its completion email; one cancelled with it does not', async () => {
    const closed = svcFor({
      'order_requests.select': orderReads({ live: { id: REPL_ID, status: 'backordered', order_number: 104 }, after: 'completed' }),
      'rpc:cancel_return': { data: { changed: true, status: 'cancelled' }, error: null },
    });
    await closed.svc.cancel(RET_ID, { reason: 'Customer kept it' });
    expect(returnPromptMock).toHaveBeenCalledTimes(1);
    expect(returnPromptMock.mock.calls[0]![1]).toBe(REPL_ID);
    vi.clearAllMocks();
    const cancelled = svcFor({
      'order_requests.select': orderReads({ live: { id: REPL_ID, status: 'approved', order_number: 104 }, after: 'cancelled' }),
      'rpc:cancel_return': { data: { changed: true, status: 'cancelled' }, error: null },
    });
    await cancelled.svc.cancel(RET_ID, { reason: 'Customer kept it' });
    expect(returnPromptMock).not.toHaveBeenCalled();
  });
});

describe('the replacement order\'s timeline learns of the receipt', () => {
  it('a staff receipt writes return_received on the live replacement', async () => {
    const { svc } = svcFor({
      'order_requests.select': orderReads({ live: { id: REPL_ID, status: 'approved', order_number: 104 } }),
      'rpc:receive_return': { data: { changed: true, status: 'received' }, error: null },
    });
    await svc.receive(RET_ID);
    expect(auditMock.mock.calls.map((c) => [(c[0] as { event: string }).event, (c[0] as { entityId: string }).entityId])).toEqual([
      ['return.received', RET_ID],
      ['order_request.return_received', REPL_ID],
    ]);
  });

  it('a step refusal carries the short numbers (the steps endpoint answers them)', async () => {
    const { svc } = svcFor({
      'rpc:approve_return': rpcError('replacement_unavailable', 'P0001', JSON.stringify([{ itemId: ITEM_L, needed: 1, available: 0 }])),
    });
    const out = await svc.runSteps(RET_ID, {
      steps: ['approve'],
      expectedRevision: 0,
      approve: { lines: [{ returnLineId: RLINE_ID, disposition: 'restock' }], exchange: [{ action: 'approve', exchangeLineId: XLINE_ID }] },
    } as never);
    expect(out.ran).toEqual([
      {
        step: 'approve',
        outcome: 'refused',
        reason: 'replacement_unavailable',
        message: expect.any(String),
        detail: [{ itemId: ITEM_L, needed: 1, available: 0 }],
      },
    ]);
  });
});
