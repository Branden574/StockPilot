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
  createRequesterReturn,
  loadRequesterReturnContext,
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
 *  token lives in order_request_secrets (every return token since 0392). */
function makeStub(overrides: Record<string, unknown> = {}) {
  return makeSupabaseStub({
    'order_request_secrets.select': { data: [{ order_request_id: ORDER_ID }], error: null },
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
  it('a side-table token resolves its order by id, without asking the order column', async () => {
    const stub = makeStub({
      'order_request_secrets.select': { data: [{ order_request_id: ORDER_ID }], error: null },
    });
    const ctx = await loadRequesterReturnContext(stub.client, TOKEN);
    expect(ctx?.orderRequestId).toBe(ORDER_ID);
    expect(stub.chainArgsAll.get('order_request_secrets.select')?.[0]).toContainEqual(['return_token', TOKEN]);
    const orderReads = stub.chainArgsAll.get('order_requests.select') ?? [];
    expect(orderReads).toHaveLength(1);
    expect(orderReads[0]).toContainEqual(['id', ORDER_ID]);
    expect(JSON.stringify(orderReads)).not.toContain('return_token');
  });

  it('0392: a token the side table does not hold is a 404 (null), and the order column is never asked', async () => {
    const stub = makeStub({ 'order_request_secrets.select': { data: [], error: null } });
    expect(await loadRequesterReturnContext(stub.client, TOKEN)).toBeNull();
    expect(stub.fromCalls).not.toContain('order_requests');
  });

  it('0392: a failed side read is a 404 (null), never a column lookup', async () => {
    const stub = makeStub({
      'order_request_secrets.select': { data: null, error: { message: 'down' } },
    });
    expect(await loadRequesterReturnContext(stub.client, TOKEN)).toBeNull();
    expect(stub.fromCalls).not.toContain('order_requests');
  });
});

describe('createRequesterReturn (create_requester_return_request, 0395)', () => {
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

  it('rejects an unknown token with not_found (never calls the function)', async () => {
    const stub = makeStub({ 'order_request_secrets.select': { data: [], error: null } });
    await expect(createRequesterReturn(stub.client, TOKEN, VALID_INPUT)).rejects.toMatchObject({ code: 'not_found' });
    expect(stub.rpcCalls).toHaveLength(0);
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
    const body = (stub.rpcCalls[0]!.args as { p_request: { lines: Array<Record<string, unknown>> } }).p_request;
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
    expect((stub.rpcCalls[0]!.args as { p_key: string }).p_key).toBe(key);
    expect(auditRow).not.toHaveBeenCalled();
    expect(notifyRequester).not.toHaveBeenCalled();
  });
});
