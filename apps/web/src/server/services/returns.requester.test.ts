import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub } from '@/test/supabase-mock';

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
 *   • only the token's order is exposed — the load path selects by return_token
 *     and reads only that order's lines (no cross-order data).
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

/** A fully-wired stub for a valid token → returnable order with one line. */
function makeStub(overrides: Record<string, unknown> = {}) {
  return makeSupabaseStub({
    'order_requests.select': { data: [COMPLETED_ORDER], error: null },
    'organization_modules.select': RETURNS_MODULE_ENABLED,
    'order_request_lines.select': { data: [ORDER_LINE], error: null },
    'returns.insert': {
      data: [
        {
          id: 'ret-1',
          return_number: 'RMA-20260531-ABCDEF',
          organization_id: ORG_ID,
        },
      ],
      error: null,
    },
    'return_lines.insert': { data: [{ id: 'rline-1' }], error: null },
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
});

describe('createRequesterReturn (server-side re-validation)', () => {
  it('creates a source=requester, status=requested return for a valid token', async () => {
    const stub = makeStub();
    const result = await createRequesterReturn(stub.client, TOKEN, VALID_INPUT);

    expect(result.id).toBe('ret-1');
    expect(stub.fromCalls).toContain('returns');
    expect(stub.fromCalls).toContain('return_lines');

    // The insert must stamp source='requester', requested_by=null, and the
    // requester identity FROM THE ORDER (not the client).
    const insertArgs = stub.chainArgs.get('returns.insert')?.[0]?.[0] as Record<string, unknown>;
    expect(insertArgs.source).toBe('requester');
    expect(insertArgs.requested_by).toBeNull();
    expect(insertArgs.requester_email).toBe('requester@example.com');
    expect(insertArgs.requester_name).toBe('Reggie Requester');
    expect(insertArgs.status).toBe('requested');
  });

  it('rejects an unknown token with not_found (never inserts)', async () => {
    const stub = makeStub({ 'order_requests.select': { data: [], error: null } });
    await expect(createRequesterReturn(stub.client, TOKEN, VALID_INPUT)).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(stub.fromCalls).not.toContain('returns');
  });

  it('rejects a malformed token with not_found', async () => {
    const stub = makeStub();
    await expect(
      createRequesterReturn(stub.client, 'not-a-uuid', VALID_INPUT),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(stub.fromCalls).not.toContain('returns');
  });

  it('rejects an over-return beyond the DURABLE budget (server-side, client not trusted)', async () => {
    // Source line fulfilled 10, already returned 8 → remaining 2. A client
    // asking for 3 must be rejected even though the client "chose" 3.
    const stub = makeStub({
      'order_request_lines.select': {
        data: [{ ...ORDER_LINE, returned_quantity: 8 }],
        error: null,
      },
    });
    await expect(createRequesterReturn(stub.client, TOKEN, VALID_INPUT)).rejects.toMatchObject({
      code: 'validation_error',
    });
    expect(stub.fromCalls).not.toContain('returns');
  });

  it('rejects a quantity greater than fulfilled', async () => {
    const stub = makeStub();
    await expect(
      createRequesterReturn(stub.client, TOKEN, {
        lines: [{ orderRequestLineId: OLINE_ID, quantity: 11 }],
      }),
    ).rejects.toMatchObject({ code: 'validation_error' });
    expect(stub.fromCalls).not.toContain('returns');
  });

  it('rejects a line that does not belong to the token\'s order', async () => {
    const stub = makeStub();
    await expect(
      createRequesterReturn(stub.client, TOKEN, {
        lines: [
          { orderRequestLineId: '99999999-9999-4999-8999-999999999999', quantity: 1 },
        ],
      }),
    ).rejects.toMatchObject({ code: 'validation_error' });
    expect(stub.fromCalls).not.toContain('returns');
  });

  it('rejects duplicate lines in one request', async () => {
    const stub = makeStub();
    await expect(
      createRequesterReturn(stub.client, TOKEN, {
        lines: [
          { orderRequestLineId: OLINE_ID, quantity: 1 },
          { orderRequestLineId: OLINE_ID, quantity: 1 },
        ],
      }),
    ).rejects.toMatchObject({ code: 'validation_error' });
    expect(stub.fromCalls).not.toContain('returns');
  });

  it('stamps item_id from the source line (client cannot pick the item)', async () => {
    const stub = makeStub();
    await createRequesterReturn(stub.client, TOKEN, VALID_INPUT);
    const lineArgs = stub.chainArgs.get('return_lines.insert')?.[0]?.[0] as Array<
      Record<string, unknown>
    >;
    expect(lineArgs[0]!.item_id).toBe(ITEM_ID);
    expect(lineArgs[0]!.disposition).toBe('restock');
  });

  it('rolls back the header if line insert fails (no orphan return)', async () => {
    const stub = makeStub({
      'return_lines.insert': {
        data: null,
        error: { message: 'some db error' },
      },
    });
    await expect(createRequesterReturn(stub.client, TOKEN, VALID_INPUT)).rejects.toMatchObject({
      code: 'internal_error',
    });
    // The header delete is issued on the rollback path.
    const deleteChain = stub.chains.get('returns.delete');
    expect(deleteChain).toBeDefined();
  });
});
