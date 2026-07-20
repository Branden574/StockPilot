import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

import type { ModuleId } from '@stockpilot/core';

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

const SCOPE = { organizationId: ORG_ID, customerId: CUSTOMER_ID, orderRequestId: ORDER_ID };

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
    'returns.insert': {
      data: [
        { id: 'ret-1', return_number: 'RMA-20260720-ABCDEF', organization_id: ORG_ID },
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
});

describe('createPortalReturn (shared requester-return core)', () => {
  it("rejects a cross-customer / foreign order id with not_found (never inserts)", async () => {
    // The id+org+customer filter finds no row — exactly what another
    // customer's (or another org's) order id produces.
    const stub = makeStub({ 'order_requests.select': { data: [], error: null } });
    await expect(createPortalReturn(stub.client, SCOPE, VALID_INPUT)).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(stub.fromCalls).not.toContain('returns');
  });

  it('rejects an over-return beyond the DURABLE budget (client quantity never trusted)', async () => {
    // Fulfilled 10, already returned 8 → remaining 2. Asking for 3 must fail.
    const stub = makeStub({
      'order_request_lines.select': {
        data: [{ ...ORDER_LINE, returned_quantity: 8 }],
        error: null,
      },
    });
    await expect(createPortalReturn(stub.client, SCOPE, VALID_INPUT)).rejects.toMatchObject({
      code: 'validation_error',
    });
    expect(stub.fromCalls).not.toContain('returns');
  });

  it("rejects a line that does not belong to the customer's order", async () => {
    const stub = makeStub();
    await expect(
      createPortalReturn(stub.client, SCOPE, {
        lines: [{ orderRequestLineId: '99999999-9999-4999-8999-999999999999', quantity: 1 }],
      }),
    ).rejects.toMatchObject({ code: 'validation_error' });
    expect(stub.fromCalls).not.toContain('returns');
  });

  it("creates a source='requester', status='requested' return with identity from the ORDER", async () => {
    const stub = makeStub();
    const result = await createPortalReturn(stub.client, SCOPE, VALID_INPUT);

    expect(result.id).toBe('ret-1');
    expect(result.organizationId).toBe(ORG_ID);

    const insertArgs = stub.chainArgs.get('returns.insert')?.[0]?.[0] as Record<string, unknown>;
    expect(insertArgs.status).toBe('requested');
    expect(insertArgs.source).toBe('requester');
    expect(insertArgs.organization_id).toBe(ORG_ID);
    expect(insertArgs.order_request_id).toBe(ORDER_ID);
    expect(insertArgs.requested_by).toBeNull();
    // Requester identity comes from the ORDER row, never the client.
    expect(insertArgs.requester_email).toBe('buyer@customer.example.com');
    expect(insertArgs.requester_name).toBe('Casey Customer');

    // item_id is STAMPED from the source line; disposition stays staff-decided.
    const lineArgs = stub.chainArgs.get('return_lines.insert')?.[0]?.[0] as Array<
      Record<string, unknown>
    >;
    expect(lineArgs[0]!.item_id).toBe(ITEM_ID);
    expect(lineArgs[0]!.disposition).toBe('restock');
  });

  it('lands in the staff Returns queue (RMAService.list picks up the created row)', async () => {
    // Create through the portal path…
    const createStub = makeStub();
    const created = await createPortalReturn(createStub.client, SCOPE, VALID_INPUT);
    const insertedHeader = createStub.chainArgs.get('returns.insert')?.[0]?.[0] as Record<
      string,
      unknown
    >;

    // …then read the queue the way the staff Returns page does: an org-scoped
    // RMAService.list filtered to status='requested'. Seed the staff stub with
    // exactly the row the portal path inserted.
    const staffStub = makeSupabaseStub({
      'returns.select': {
        data: [{ id: created.id, ...insertedHeader }],
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
    // The queue read is org-scoped and filtered to the requested status.
    const chainArgs = staffStub.chainArgs.get('returns.select') ?? [];
    expect(chainArgs).toContainEqual(['organization_id', ORG_ID]);
    expect(chainArgs).toContainEqual(['status', ['requested']]);
  });
});
