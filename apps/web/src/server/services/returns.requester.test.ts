import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub } from '@/test/supabase-mock';

const auditRow = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => true));
vi.mock('./audit', () => ({ audit: vi.fn(async () => undefined), insertAuditRowReported: auditRow }));
const notifyStaff = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => undefined));
const notifyRequester = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => undefined));
vi.mock('./returns-notify', () => ({
  notifyStaffNewReturnRequest: notifyStaff,
  notifyRequesterReturnEvent: notifyRequester,
}));
vi.mock('./integration-events', () => ({ dispatchEvent: vi.fn(async () => undefined) }));

import {
  createMemberReturn,
  createRequesterReturn,
  loadRequesterReturnContext,
  requesterApprovalEvent,
} from './returns';

/**
 * Tests for the PUBLIC, UNAUTHENTICATED requester-return portal service path
 * (Returns Phase B, B4). These cover the load-bearing invariants of an anon
 * surface:
 *
 *   • token validation — an unknown/malformed/expired token resolves to nothing
 *     (the public route turns that into a 404); a non-returnable order or a
 *     returns-module-disabled org likewise resolves to null.
 *   • server-side over-return + durable-budget enforcement — the client's
 *     quantity is NEVER trusted; the cap is quantity_fulfilled -
 *     returned_quantity read off the source line.
 *   • only the token's order is exposed — the load path finds the token's one
 *     order in order_request_secrets (0389, 0392) and reads only that order's
 *     lines (no cross-order data).
 *   • item identity + requester identity are stamped server-side, not taken
 *     from the client.
 */

// A real uuid-shaped return token (the column is uuid, 0156).
const TOKEN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORDER_ID = '11111111-1111-4111-8111-111111111111';
const ORG_ID = 'org-test';
const OLINE_ID = '22222222-2222-4222-8222-222222222222';
const ITEM_ID = '33333333-3333-4333-8333-333333333333';

const COMPLETED_ORDER = {
  id: ORDER_ID,
  organization_id: ORG_ID,
  status: 'completed',
  requester_email: 'requester@example.com',
  requester_name: 'Reggie Requester',
};

// Fulfilled 10, none yet returned → durable remaining budget is 10.
const ORDER_LINE = {
  id: OLINE_ID,
  item_id: ITEM_ID,
  quantity_fulfilled: 10,
  returned_quantity: 0,
  item: { id: ITEM_ID, name: 'Algebra I', sku: 'BK-001' },
};

const RETURNS_MODULE_ENABLED = {
  data: [{ module_id: 'returns' }],
  error: null,
};

/** A fully-wired stub for a valid token → returnable order with one line. The
 *  token lives in order_request_secrets (every return token since 0392) and
 *  is looked up by POST through order_id_for_return_token (returns RX-4,
 *  0397, RX-3 security finding 1). */
function makeStub(overrides: Record<string, unknown> = {}) {
  return makeSupabaseStub({
    'rpc:order_id_for_return_token': { data: ORDER_ID, error: null },
    'order_requests.select': { data: [COMPLETED_ORDER], error: null },
    'organization_modules.select': RETURNS_MODULE_ENABLED,
    'order_request_lines.select': { data: [ORDER_LINE], error: null },
    'rpc:create_requester_return_request': {
      data: { changed: true, replay: false, organizationId: ORG_ID, returnId: 'ret-1', returnNumber: 'RMA-20260531-ABCDEF', status: 'requested' },
      error: null,
    },
    ...overrides,
  });
}

const VALID_INPUT = {
  reasonCode: 'damaged' as const,
  lines: [{ orderRequestLineId: OLINE_ID, quantity: 3 }],
};

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

describe('loadRequesterReturnContext (token validation)', () => {
  it('resolves a valid token to ONLY that order + its returnable lines', async () => {
    const stub = makeStub();
    const ctx = await loadRequesterReturnContext(stub.client, TOKEN);

    expect(ctx).not.toBeNull();
    expect(ctx!.orderRequestId).toBe(ORDER_ID);
    expect(ctx!.organizationId).toBe(ORG_ID);
    expect(ctx!.requesterEmail).toBe('requester@example.com');
    expect(ctx!.lines).toHaveLength(1);
    expect(ctx!.lines[0]).toMatchObject({
      orderRequestLineId: OLINE_ID,
      itemId: ITEM_ID,
      quantityRemaining: 10,
    });
    // The order lookup must be scoped by the token (no cross-order exposure).
    const chain = stub.chains.get('order_requests.select');
    expect(chain).toContain('eq');
  });

  it('rejects a malformed (non-uuid) token WITHOUT hitting the DB', async () => {
    const stub = makeStub();
    const ctx = await loadRequesterReturnContext(stub.client, 'not-a-uuid');
    expect(ctx).toBeNull();
    // Short-circuits before any query.
    expect(stub.fromCalls).not.toContain('order_requests');
  });

  it('rejects an empty token', async () => {
    const stub = makeStub();
    expect(await loadRequesterReturnContext(stub.client, '')).toBeNull();
    expect(stub.fromCalls).not.toContain('order_requests');
  });

  it('returns null for an unknown token (no order row)', async () => {
    const stub = makeStub({ 'order_requests.select': { data: [], error: null } });
    expect(await loadRequesterReturnContext(stub.client, TOKEN)).toBeNull();
  });

  it('returns null when the order is not returnable (not completed/delivered)', async () => {
    const stub = makeStub({
      'order_requests.select': {
        data: [{ ...COMPLETED_ORDER, status: 'in_transit' }],
        error: null,
      },
    });
    expect(await loadRequesterReturnContext(stub.client, TOKEN)).toBeNull();
  });

  it('returns null when the org no longer has the returns module enabled', async () => {
    const stub = makeStub({
      'organization_modules.select': { data: [], error: null },
    });
    expect(await loadRequesterReturnContext(stub.client, TOKEN)).toBeNull();
  });

  it('omits lines that are fully returned (durable budget exhausted)', async () => {
    const stub = makeStub({
      'order_request_lines.select': {
        data: [{ ...ORDER_LINE, returned_quantity: 10 }],
        error: null,
      },
    });
    const ctx = await loadRequesterReturnContext(stub.client, TOKEN);
    expect(ctx).not.toBeNull();
    expect(ctx!.lines).toHaveLength(0);
  });

  it('subtracts live PENDING return demand from remaining (matches the DB cap trigger)', async () => {
    // Fulfilled 10, durably returned 0, but 4 units already sit on a live
    // 'requested' (unapplied) return — the page must offer only 6, exactly
    // what the DB trigger would accept. A cancelled row's units don't count.
    const stub = makeStub({
      'return_lines.select': {
        data: [
          {
            order_request_line_id: OLINE_ID,
            quantity: 4,
            applied: false,
            return: { status: 'requested' },
          },
          {
            order_request_line_id: OLINE_ID,
            quantity: 5,
            applied: false,
            return: { status: 'cancelled' },
          },
        ],
        error: null,
      },
    });
    const ctx = await loadRequesterReturnContext(stub.client, TOKEN);
    expect(ctx).not.toBeNull();
    expect(ctx!.lines).toHaveLength(1);
    expect(ctx!.lines[0]).toMatchObject({ quantityFulfilled: 10, quantityRemaining: 6 });
  });
});

// Migrations 0389 and 0392: every return token lives in the service-only
// order_request_secrets (minted there since 0389; 0392 moved the older ones,
// same value, and nulled order_requests.return_token). It opens exactly its
// order; the order column is never asked.
describe('loadRequesterReturnContext (where the token is found, 0389 and 0392)', () => {
  // Re-pinned by returns RX-4 (0397; was: a PostgREST GET filtered on
  // return_token): one POST to the lookup function, no table read for it.
  it('a side-table token resolves its order by id through the lookup function (a POST), without asking the order column', async () => {
    const stub = makeStub();
    const ctx = await loadRequesterReturnContext(stub.client, TOKEN);
    expect(ctx?.orderRequestId).toBe(ORDER_ID);
    expect(stub.rpcCalls[0]).toEqual({ name: 'order_id_for_return_token', args: { p_token: TOKEN } });
    expect(stub.fromCalls).not.toContain('order_request_secrets');
    const orderReads = stub.chainArgsAll.get('order_requests.select') ?? [];
    expect(orderReads).toHaveLength(1);
    expect(orderReads[0]).toContainEqual(['id', ORDER_ID]);
    expect(JSON.stringify(orderReads)).not.toContain('return_token');
  });

  it('0392: a token the side table does not hold is a 404 (null), and the order column is never asked', async () => {
    const stub = makeStub({ 'rpc:order_id_for_return_token': { data: null, error: null } });
    expect(await loadRequesterReturnContext(stub.client, TOKEN)).toBeNull();
    expect(stub.fromCalls).not.toContain('order_requests');
  });

  it('0392: a failed side read is a 404 (null), never a column lookup', async () => {
    const stub = makeStub({
      'rpc:order_id_for_return_token': { data: null, error: { message: 'down' } },
    });
    expect(await loadRequesterReturnContext(stub.client, TOKEN)).toBeNull();
    expect(stub.fromCalls).not.toContain('order_requests');
  });
});

describe('createRequesterReturn (create_requester_return_request, 0394)', () => {
  function refusal(hint: string, code = 'P0001') {
    return { 'rpc:create_requester_return_request': { data: null, error: { code, hint, message: hint, details: null } } };
  }

  it('creates through the service-role function with the anonymous token actor, then audits and notifies once', async () => {
    const stub = makeStub();
    const result = await createRequesterReturn(stub.client, TOKEN, VALID_INPUT);
    expect(result).toMatchObject({ id: 'ret-1', returnNumber: 'RMA-20260531-ABCDEF', organizationId: ORG_ID, replay: false });
    const call = stub.rpcCalls.find((c) => c.name === 'create_requester_return_request')!;
    expect(call.args).toMatchObject({ p_order_id: ORDER_ID, p_actor: { channel: 'token', userId: null } });
    // The token is never handed to the database function; only the order the server resolved.
    expect(JSON.stringify(call.args)).not.toContain(TOKEN);
    expect(auditRow).toHaveBeenCalledWith(expect.objectContaining({ user_id: null, event: 'return.created' }));
    expect(notifyStaff).toHaveBeenCalledTimes(1);
    expect(notifyRequester).toHaveBeenCalledWith(expect.objectContaining({ event: 'request_received', channel: 'token' }));
  });

  it('rejects an unknown token with not_found (never calls the create function)', async () => {
    const stub = makeStub({ 'rpc:order_id_for_return_token': { data: null, error: null } });
    await expect(createRequesterReturn(stub.client, TOKEN, VALID_INPUT)).rejects.toMatchObject({ code: 'not_found' });
    // Only the token lookup ran (RX-4).
    expect(stub.rpcCalls.map((c) => c.name)).toEqual(['order_id_for_return_token']);
  });

  it('rejects a malformed token with not_found', async () => {
    const stub = makeStub();
    await expect(createRequesterReturn(stub.client, 'not-a-token', VALID_INPUT)).rejects.toMatchObject({ code: 'not_found' });
    expect(stub.rpcCalls).toHaveLength(0);
  });

  it.each([
    ['return_exceeds_fulfilled', 'validation_error'],
    ['return_invalid', 'validation_error'],
  ])('maps the database refusal %s (the client quantity and line are never trusted)', async (hint, code) => {
    const stub = makeStub(refusal(hint, hint === 'return_invalid' ? '22023' : 'P0001'));
    await expect(createRequesterReturn(stub.client, TOKEN, VALID_INPUT)).rejects.toMatchObject({ code, details: { reason: hint } });
    expect(auditRow).not.toHaveBeenCalled();
    expect(notifyStaff).not.toHaveBeenCalled();
  });

  it('rejects a fractional quantity or a repeated line before the database (whole units only)', async () => {
    const stub = makeStub();
    await expect(
      createRequesterReturn(stub.client, TOKEN, { lines: [{ orderRequestLineId: OLINE_ID, quantity: 1.5 }] }),
    ).rejects.toMatchObject({ code: 'validation_error' });
    await expect(
      createRequesterReturn(stub.client, TOKEN, {
        lines: [
          { orderRequestLineId: OLINE_ID, quantity: 1 },
          { orderRequestLineId: OLINE_ID, quantity: 1 },
        ],
      }),
    ).rejects.toMatchObject({ code: 'validation_error' });
    expect(stub.rpcCalls).toHaveLength(0);
  });

  it('never sends a disposition: the requester cannot choose scrap', async () => {
    const stub = makeStub();
    await createRequesterReturn(stub.client, TOKEN, {
      lines: [{ orderRequestLineId: OLINE_ID, quantity: 1, disposition: 'scrap' } as never],
    });
    const body = (stub.rpcCalls.find((c) => c.name === 'create_requester_return_request')!.args as { p_request: { lines: Array<Record<string, unknown>> } }).p_request;
    expect(body.lines[0]).toEqual({ orderRequestLineId: OLINE_ID, quantity: 1 });
  });

  it('a key replay answers the same RMA and sends nothing', async () => {
    const stub = makeStub({
      'rpc:create_requester_return_request': {
        data: { changed: false, replay: true, organizationId: ORG_ID, returnId: 'ret-1', returnNumber: 'RMA-1', status: 'requested' },
        error: null,
      },
    });
    const key = '44444444-4444-4444-8444-444444444444';
    const result = await createRequesterReturn(stub.client, TOKEN, VALID_INPUT, { idempotencyKey: key });
    expect(result.replay).toBe(true);
    expect((stub.rpcCalls.find((c) => c.name === 'create_requester_return_request')!.args as { p_key: string }).p_key).toBe(key);
    expect(auditRow).not.toHaveBeenCalled();
    expect(notifyRequester).not.toHaveBeenCalled();
  });
});

// ── Returns RX-3: the requester's own exchange ──────────────────────────────

describe('RX-3: an exchange on the token path (the database decides, one generic refusal)', () => {
  const EXCHANGE_INPUT = {
    lines: [{ orderRequestLineId: OLINE_ID, quantity: 2, exchange: { itemId: '44444444-4444-4444-8444-444444444444', quantity: 2 } }],
  };

  it('passes the exchange through unchanged; the staff ping and the receipt are worded as an exchange; the audit counts it', async () => {
    const stub = makeStub();
    await createRequesterReturn(stub.client, TOKEN, EXCHANGE_INPUT);
    const call = stub.rpcCalls.find((c) => c.name === 'create_requester_return_request')!;
    expect(call.args).toMatchObject({
      p_request: { lines: [{ orderRequestLineId: OLINE_ID, quantity: 2, exchange: { itemId: '44444444-4444-4444-8444-444444444444', quantity: 2 } }] },
      p_actor: { channel: 'token', userId: null },
    });
    expect(notifyStaff).toHaveBeenCalledWith(expect.objectContaining({ kind: 'exchange' }));
    expect(notifyRequester).toHaveBeenCalledWith(expect.objectContaining({ event: 'exchange_request_received', channel: 'token' }));
    expect(auditRow).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ exchangeLines: 1, channel: 'token' }) }),
    );
  });

  it('a return only stays "return" for staff and the requester', async () => {
    await createRequesterReturn(makeStub().client, TOKEN, VALID_INPUT);
    expect(notifyStaff).toHaveBeenCalledWith(expect.objectContaining({ kind: 'return' }));
    expect(notifyRequester).toHaveBeenCalledWith(expect.objectContaining({ event: 'request_received' }));
  });

  it('an unknown item and an item of another size group get the SAME answer (no oracle): the one generic hint', async () => {
    const refused = { 'rpc:create_requester_return_request': { data: null, error: { code: 'P0001', hint: 'exchange_item_not_eligible', message: 'exchange_item_not_eligible', details: null } } };
    const unknown = await createRequesterReturn(makeStub(refused).client, TOKEN, EXCHANGE_INPUT).catch((e: unknown) => e);
    const sibling = await createRequesterReturn(makeStub(refused).client, TOKEN, {
      lines: [{ orderRequestLineId: OLINE_ID, quantity: 2, exchange: { itemId: ITEM_ID } }],
    }).catch((e: unknown) => e);
    for (const e of [unknown, sibling]) {
      expect(e).toMatchObject({ code: 'validation_error', message: "That item can't be used as a replacement.", details: { reason: 'exchange_item_not_eligible' } });
    }
    expect(notifyStaff).not.toHaveBeenCalled();
  });

  it.each([
    ['a quantity of 0', { lines: [{ orderRequestLineId: OLINE_ID, quantity: 0 }] }],
    ['a fractional quantity', { lines: [{ orderRequestLineId: OLINE_ID, quantity: 1.5 }] }],
    ['an exchange above the returned quantity', { lines: [{ orderRequestLineId: OLINE_ID, quantity: 1, exchange: { itemId: ITEM_ID, quantity: 2 } }] }],
    ['a fractional exchange quantity', { lines: [{ orderRequestLineId: OLINE_ID, quantity: 2, exchange: { itemId: ITEM_ID, quantity: 1.5 } }] }],
    ['an exchange with neither an item nor a note', { lines: [{ orderRequestLineId: OLINE_ID, quantity: 1, exchange: {} }] }],
    ['a forged approved item inside the exchange', { lines: [{ orderRequestLineId: OLINE_ID, quantity: 1, exchange: { itemId: ITEM_ID, approvedItemId: ITEM_ID } }] }],
    ['a forged replacement order inside the exchange', { lines: [{ orderRequestLineId: OLINE_ID, quantity: 1, exchange: { note: 'L please', replacementOrderId: ORDER_ID } }] }],
  ])('refuses %s before the database', async (_label, input) => {
    const stub = makeStub();
    await expect(createRequesterReturn(stub.client, TOKEN, input as never)).rejects.toMatchObject({ code: 'validation_error' });
    expect(stub.rpcCalls).toHaveLength(0);
  });

  it('strips forged line and header fields (disposition, status, warehouse, organization, location)', async () => {
    const stub = makeStub();
    await createRequesterReturn(stub.client, TOKEN, {
      lines: [
        {
          orderRequestLineId: OLINE_ID,
          quantity: 1,
          disposition: 'scrap',
          status: 'approved',
          warehouseId: 'w',
          locationId: 'l',
          approvedItemId: ITEM_ID,
          replacementOrderId: ORDER_ID,
          exchange: { note: 'A larger size' },
        },
      ],
      organizationId: 'org-forged',
      status: 'approved',
    } as never);
    const body = (stub.rpcCalls.find((c) => c.name === 'create_requester_return_request')!.args as { p_request: Record<string, unknown> }).p_request;
    expect(body).toEqual({
      reasonCode: null,
      notes: null,
      lines: [{ orderRequestLineId: OLINE_ID, quantity: 1, exchange: { note: 'A larger size' } }],
    });
  });
});

describe('RX-3: a member asks on their own order (channel member)', () => {
  const MEMBER = { organizationId: ORG_ID, userId: 'member-1', orderRequestId: ORDER_ID };

  it('resolves the order as the caller own (requester, organization) and creates as the member', async () => {
    const stub = makeStub();
    const result = await createMemberReturn(stub.client, MEMBER, VALID_INPUT, { idempotencyKey: '44444444-4444-4444-8444-444444444444' });
    expect(result).toMatchObject({ id: 'ret-1', replay: false });
    const read = stub.chainArgsAll.get('order_requests.select')![0]!;
    expect(read).toContainEqual(['requester_user_id', 'member-1']);
    expect(read).toContainEqual(['organization_id', ORG_ID]);
    const call = stub.rpcCalls.find((c) => c.name === 'create_requester_return_request')!;
    expect(call.args).toMatchObject({ p_actor: { channel: 'member', userId: 'member-1' }, p_key: '44444444-4444-4444-8444-444444444444' });
    expect(notifyRequester).toHaveBeenCalledWith(expect.objectContaining({ channel: 'member', event: 'request_received' }));
    expect(notifyStaff).toHaveBeenCalledWith(expect.objectContaining({ actorUserId: 'member-1' }));
  });

  it("another member's order, or a portal order, is the closed door in the member's words; nothing is created", async () => {
    const none = makeStub({ 'order_requests.select': { data: [], error: null } });
    await expect(createMemberReturn(none.client, MEMBER, VALID_INPUT)).rejects.toMatchObject({
      code: 'not_found',
      message: "This order isn't available.",
    });
    expect(none.rpcCalls).toHaveLength(0);
    const portal = makeStub({ 'order_requests.select': { data: [{ ...COMPLETED_ORDER, source: 'portal' }], error: null } });
    await expect(createMemberReturn(portal.client, MEMBER, VALID_INPUT)).rejects.toMatchObject({ code: 'not_found' });
    expect(portal.rpcCalls).toHaveLength(0);
  });

  it('a database closed door (order gone, module off) answers the same words', async () => {
    const stub = makeStub({
      'rpc:create_requester_return_request': { data: null, error: { code: 'P0001', hint: 'module_disabled', message: 'module_disabled', details: null } },
    });
    await expect(createMemberReturn(stub.client, MEMBER, VALID_INPUT)).rejects.toMatchObject({
      code: 'not_found',
      message: "This order isn't available.",
    });
  });
});

describe("RX-3: the requester's approval message (requesterApprovalEvent, plan 3.6.8)", () => {
  const held = { short: false };
  const short = { short: true };
  it.each([
    ['a return only', null, [], 'approved'],
    ['unread lines, no replacement', null, null, 'approved'],
    ['the requester asked, every line declined', null, [{ status: 'declined', requested_by_kind: 'requester' }], 'exchange_declined'],
    ['a portal customer asked, declined', null, [{ status: 'declined', requested_by_kind: 'portal_customer' }], 'exchange_declined'],
    ['staff added and declined their own add', null, [{ status: 'declined', requested_by_kind: 'staff' }], 'approved'],
    ['the requester asked, reserved', held, [{ status: 'approved', requested_by_kind: 'requester' }], 'exchange_approved'],
    ['the requester asked, not in stock', short, [{ status: 'approved', requested_by_kind: 'requester' }], 'exchange_approved_short'],
    ['unread lines, a replacement', held, null, 'exchange_approved'],
    ['staff added every line', held, [{ status: 'approved', requested_by_kind: 'staff' }], 'return_approved_replacement_added'],
    ['staff added every line, short', short, [{ status: 'approved', requested_by_kind: 'staff' }], 'return_approved_replacement_added_short'],
    [
      'one asked line declined, one staff line approved',
      held,
      [
        { status: 'declined', requested_by_kind: 'requester' },
        { status: 'approved', requested_by_kind: 'staff' },
      ],
      'exchange_approved',
    ],
  ] as const)('%s -> %s', (_label, replacement, lines, expected) => {
    expect(requesterApprovalEvent(replacement, lines as never)).toBe(expected);
  });
});
