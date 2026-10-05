import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

import type { ModuleId } from '@stockpilot/core';

// The created path's side effects are asserted through these mocks.
const auditRow = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => true));
vi.mock('./audit', () => ({ audit: vi.fn(async () => undefined), insertAuditRowReported: auditRow }));
const notifyStaff = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => undefined));
const notifyRequester = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => undefined));
vi.mock('./returns-notify', () => ({
  notifyStaffNewReturnRequest: notifyStaff,
  notifyRequesterReturnEvent: notifyRequester,
}));
vi.mock('./integration-events', () => ({ dispatchEvent: vi.fn(async () => undefined) }));

import { RMAService, createPortalReturn, loadPortalReturnContext } from './returns';

/**
 * Tests for the B2B portal "Request a return" service path (returns-access
 * Unit B). The portal principal is an external CUSTOMER (customer_users —
 * never org_members), so the load-bearing invariants are:
 *
 *   • the order lookup is scoped by id AND organization_id AND customer_id —
 *     a cross-customer or foreign order id resolves to nothing (not_found;
 *     existence never leaks).
 *   • everything downstream of the order row is the SAME shared requester-
 *     return core the public token path uses: durable budget
 *     (quantity_fulfilled - returned_quantity), line belonging, item identity
 *     stamped server-side, source='requester', status='requested'.
 *   • the created row lands in the staff Returns approval queue (the
 *     RMAService.list({ status: 'requested' }) read path picks it up).
 */

const ORDER_ID = '11111111-1111-4111-8111-111111111111';
const ORG_ID = 'org-test';
const CUSTOMER_ID = '44444444-4444-4444-8444-444444444444';
const OLINE_ID = '22222222-2222-4222-8222-222222222222';
const ITEM_ID = '33333333-3333-4333-8333-333333333333';

const PORTAL_USER = '55555555-5555-4555-8555-555555555555';
const SCOPE = { organizationId: ORG_ID, customerId: CUSTOMER_ID, orderRequestId: ORDER_ID, portalUserId: PORTAL_USER };

const COMPLETED_ORDER = {
  id: ORDER_ID,
  organization_id: ORG_ID,
  status: 'completed',
  requester_email: 'buyer@customer.example.com',
  requester_name: 'Casey Customer',
};

// Fulfilled 10, none yet returned → durable remaining budget is 10.
const ORDER_LINE = {
  id: OLINE_ID,
  item_id: ITEM_ID,
  quantity_fulfilled: 10,
  returned_quantity: 0,
  item: { id: ITEM_ID, name: 'Algebra I', sku: 'BK-001' },
};

/** A fully-wired stub for the customer's own returnable order with one line. */
function makeStub(overrides: Record<string, unknown> = {}) {
  return makeSupabaseStub({
    'order_requests.select': { data: [COMPLETED_ORDER], error: null },
    'organization_modules.select': { data: [{ module_id: 'returns' }], error: null },
    'order_request_lines.select': { data: [ORDER_LINE], error: null },
    'rpc:create_requester_return_request': {
      data: {
        changed: true,
        replay: false,
        organizationId: ORG_ID,
        returnId: 'ret-1',
        returnNumber: 'RMA-20260720-ABCDEF',
        status: 'requested',
      },
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

describe('loadPortalReturnContext (customer-own-order scoping)', () => {
  it('scopes the order lookup by id AND organization_id AND customer_id', async () => {
    const stub = makeStub();
    const ctx = await loadPortalReturnContext(stub.client, SCOPE);

    expect(ctx).not.toBeNull();
    expect(ctx!.orderRequestId).toBe(ORDER_ID);
    expect(ctx!.organizationId).toBe(ORG_ID);
    expect(ctx!.lines).toHaveLength(1);
    expect(ctx!.lines[0]).toMatchObject({
      orderRequestLineId: OLINE_ID,
      itemId: ITEM_ID,
      quantityRemaining: 10,
    });

    // The THREE eq filters are the cross-customer defense — assert each pair.
    const eqArgs = (stub.chainArgs.get('order_requests.select') ?? []).filter(
      (a) => a.length === 2,
    );
    expect(eqArgs).toContainEqual(['id', ORDER_ID]);
    expect(eqArgs).toContainEqual(['organization_id', ORG_ID]);
    expect(eqArgs).toContainEqual(['customer_id', CUSTOMER_ID]);
  });

  it('rejects a malformed (non-uuid) order id WITHOUT hitting the DB', async () => {
    const stub = makeStub();
    const ctx = await loadPortalReturnContext(stub.client, {
      ...SCOPE,
      orderRequestId: 'not-a-uuid',
    });
    expect(ctx).toBeNull();
    expect(stub.fromCalls).not.toContain('order_requests');
  });

  it('returns null when the order is not returnable (not completed/delivered)', async () => {
    const stub = makeStub({
      'order_requests.select': {
        data: [{ ...COMPLETED_ORDER, status: 'in_transit' }],
        error: null,
      },
    });
    expect(await loadPortalReturnContext(stub.client, SCOPE)).toBeNull();
  });

  it('returns null when the org no longer has the returns module enabled', async () => {
    const stub = makeStub({ 'organization_modules.select': { data: [], error: null } });
    expect(await loadPortalReturnContext(stub.client, SCOPE)).toBeNull();
  });

  it('subtracts live PENDING return demand from remaining (matches the DB cap trigger)', async () => {
    // Fulfilled 10 with 4 units pending on the customer's earlier (unapplied)
    // request → the portal must offer only 6, exactly what the DB trigger
    // would accept at insert.
    const stub = makeStub({
      'return_lines.select': {
        data: [
          {
            order_request_line_id: OLINE_ID,
            quantity: 4,
            applied: false,
            return: { status: 'requested' },
          },
        ],
        error: null,
      },
    });
    const ctx = await loadPortalReturnContext(stub.client, SCOPE);
    expect(ctx).not.toBeNull();
    expect(ctx!.lines).toHaveLength(1);
    expect(ctx!.lines[0]).toMatchObject({ quantityFulfilled: 10, quantityRemaining: 6 });
  });
});

describe('createPortalReturn (create_requester_return_request, 0394)', () => {
  it("rejects a cross-customer / foreign order id with not_found (never calls the function)", async () => {
    const stub = makeStub({ 'order_requests.select': { data: [], error: null } });
    await expect(createPortalReturn(stub.client, SCOPE, VALID_INPUT)).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(stub.rpcCalls.map((c) => c.name)).not.toContain('create_requester_return_request');
  });

  it('maps an over-return refused by the database (durable budget, cap trigger) to validation_error', async () => {
    const stub = makeStub({
      'rpc:create_requester_return_request': {
        data: null,
        error: { code: 'P0001', hint: 'return_exceeds_fulfilled', message: 'return_exceeds_fulfilled', details: null },
      },
    });
    await expect(createPortalReturn(stub.client, SCOPE, VALID_INPUT)).rejects.toMatchObject({
      code: 'validation_error',
      details: { reason: 'return_exceeds_fulfilled' },
    });
    expect(auditRow).not.toHaveBeenCalled();
    expect(notifyStaff).not.toHaveBeenCalled();
  });

  it("maps a line that does not belong to the customer's order (return_invalid) to validation_error", async () => {
    const stub = makeStub({
      'rpc:create_requester_return_request': {
        data: null,
        error: { code: '22023', hint: 'return_invalid', message: 'return_invalid', details: 'orderRequestLineId' },
      },
    });
    await expect(createPortalReturn(stub.client, SCOPE, VALID_INPUT)).rejects.toMatchObject({
      code: 'validation_error',
      details: { reason: 'return_invalid' },
    });
  });

  it('calls the service-role function with the portal actor and no disposition, then audits and notifies once', async () => {
    const stub = makeStub();
    const result = await createPortalReturn(stub.client, SCOPE, {
      ...VALID_INPUT,
      // A forged disposition is stripped by the requester schema.
      lines: [{ orderRequestLineId: OLINE_ID, quantity: 3, disposition: 'scrap' } as never],
    });
    expect(result).toMatchObject({ id: 'ret-1', organizationId: ORG_ID, replay: false });

    const call = stub.rpcCalls.find((c) => c.name === 'create_requester_return_request')!;
    const args = call.args as { p_order_id: string; p_request: { lines: Array<Record<string, unknown>> }; p_key: string; p_actor: unknown };
    expect(args.p_order_id).toBe(ORDER_ID);
    expect(args.p_actor).toEqual({ channel: 'portal', userId: PORTAL_USER });
    expect(args.p_request.lines).toEqual([{ orderRequestLineId: OLINE_ID, quantity: 3 }]);
    expect(args.p_key).toMatch(/^[0-9a-f-]{36}$/);

    expect(auditRow).toHaveBeenCalledTimes(1);
    expect(auditRow.mock.calls[0]![0]).toMatchObject({
      organization_id: ORG_ID,
      user_id: PORTAL_USER,
      event: 'return.created',
      metadata: { entity_id: 'ret-1', source: 'requester', channel: 'portal' },
    });
    expect(notifyStaff).toHaveBeenCalledTimes(1);
    expect(notifyRequester).toHaveBeenCalledWith(expect.objectContaining({ event: 'request_received', returnId: 'ret-1' }));
  });

  it('a replay (same key, same body) writes no audit and sends nothing', async () => {
    const stub = makeStub({
      'rpc:create_requester_return_request': {
        data: { changed: false, replay: true, organizationId: ORG_ID, returnId: 'ret-1', returnNumber: 'RMA-1', status: 'requested' },
        error: null,
      },
    });
    const result = await createPortalReturn(stub.client, SCOPE, VALID_INPUT, {
      idempotencyKey: '66666666-6666-4666-8666-666666666666',
    });
    expect(result.replay).toBe(true);
    expect((stub.rpcCalls[0]?.args as { p_key: string }).p_key).toBe('66666666-6666-4666-8666-666666666666');
    expect(auditRow).not.toHaveBeenCalled();
    expect(notifyStaff).not.toHaveBeenCalled();
    expect(notifyRequester).not.toHaveBeenCalled();
  });

  it('a module switched off between load and create answers the same closed door (not_found)', async () => {
    const stub = makeStub({
      'rpc:create_requester_return_request': {
        data: null,
        error: { code: 'P0001', hint: 'module_disabled', message: 'module_disabled', details: null },
      },
    });
    await expect(createPortalReturn(stub.client, SCOPE, VALID_INPUT)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('lands in the staff Returns queue (RMAService.list reads requested rows)', async () => {
    const staffStub = makeSupabaseStub({
      'returns.select': {
        data: [{ id: 'ret-1', organization_id: ORG_ID, status: 'requested', source: 'requester' }],
        error: null,
      },
    });
    const service = new RMAService(
      makeServiceContext(staffStub.client, {
        organizationId: ORG_ID,
        role: 'admin',
        enabledModules: new Set<ModuleId>(['returns']),
      }),
    );
    const queue = await service.list({ status: 'requested' });
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ id: 'ret-1', status: 'requested', source: 'requester' });
    const chainArgs = staffStub.chainArgs.get('returns.select') ?? [];
    expect(chainArgs).toContainEqual(['organization_id', ORG_ID]);
    expect(chainArgs).toContainEqual(['status', ['requested']]);
  });
});
