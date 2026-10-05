import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ORDER_CANCEL_REQUESTER_PENDING_ONLY_COPY,
  ORDER_WAREHOUSE_WRITE_REFUSED_COPY,
  type ModuleId,
  type Role,
} from '@stockpilot/core';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

vi.mock('./audit', () => ({ audit: vi.fn(async () => {}) }));
vi.mock('./integration-events', () => ({ dispatchEvent: vi.fn(async () => {}) }));
vi.mock('@/lib/email/order-requests', () => ({ sendOrderRequestEmail: vi.fn(async () => {}) }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => makeSupabaseStub().client }));

import { OrderRequestsService } from './order-requests';
import { invalidateInventoryListAfterWrite } from './lib/inventory-list-cache';

/**
 * Migration 0395 (small fixes slice 2) makes the database refuse what the
 * order service already refused, and the service maps each refusal to words.
 *
 *   N1    cancel_order_request refuses a requester past pending approval
 *         (42501 forbidden, hint requester_pending_only). The service's own
 *         read normally stops it first; the database answers when the status
 *         changes between that read and the call. Both answer 403 forbidden
 *         with the same sentence (core ORDER_CANCEL_REQUESTER_PENDING_ONLY_COPY).
 *   L129a order_requests_update requires write access to the order's
 *         warehouse, so the notes editor asks 'write' like every other
 *         user-client write to the order.
 */

function svc(
  stub: ReturnType<typeof makeSupabaseStub>,
  opts: { role?: Role; userId?: string; permissions?: string[] } = {},
) {
  return new (OrderRequestsService as unknown as new (ctx: unknown) => OrderRequestsService)(
    makeServiceContext(stub.client, {
      role: opts.role ?? 'staff',
      userId: opts.userId ?? 'u1',
      enabledModules: new Set<ModuleId>(['orders']),
      ...(opts.permissions ? { permissions: new Set(opts.permissions) } : {}),
    }),
  );
}

beforeEach(() => vi.clearAllMocks());

describe('OrderRequestsService.cancel — the requester window answered by the database (0395 N1)', () => {
  it('maps the function refusal to a 403 with the cancel sentence, not "someone else\'s order"', async () => {
    // The service read the order at pending_approval; it was approved before
    // the function locked it.
    const stub = makeSupabaseStub({
      'order_requests.select.maybeSingle': {
        data: { status: 'pending_approval', requester_user_id: 'u1' },
        error: null,
      },
      'rpc:cancel_order_request': {
        data: null,
        error: { message: 'forbidden', code: '42501', hint: 'requester_pending_only' },
      },
    });
    await expect(svc(stub).cancel('ord-1', null)).rejects.toMatchObject({
      code: 'forbidden',
      message: ORDER_CANCEL_REQUESTER_PENDING_ONLY_COPY,
    });
    expect(stub.rpcCalls.map((c) => c.name)).toEqual(['cancel_order_request']);
    expect(invalidateInventoryListAfterWrite).not.toHaveBeenCalled();
  });

  it('answers the same 403 and sentence whichever layer refuses first (the service read or the function)', async () => {
    // Service first: the read already shows the order approved, so the
    // function is never called.
    const early = makeSupabaseStub({
      'order_requests.select.maybeSingle': {
        data: { status: 'approved', requester_user_id: 'u1' },
        error: null,
      },
    });
    const first = await svc(early).cancel('ord-1', null).catch((e: unknown) => e);
    expect(early.rpcCalls).toHaveLength(0);
    // Function first: the read saw pending_approval, the function did not.
    const late = makeSupabaseStub({
      'order_requests.select.maybeSingle': {
        data: { status: 'pending_approval', requester_user_id: 'u1' },
        error: null,
      },
      'rpc:cancel_order_request': {
        data: null,
        error: { message: 'forbidden', code: '42501', hint: 'requester_pending_only' },
      },
    });
    const second = await svc(late).cancel('ord-1', null).catch((e: unknown) => e);
    const shape = (e: unknown) => ({ code: (e as { code?: string }).code, message: (e as Error).message });
    expect(shape(first)).toEqual({ code: 'forbidden', message: ORDER_CANCEL_REQUESTER_PENDING_ONLY_COPY });
    expect(shape(second)).toEqual(shape(first));
  });

  it("keeps 'forbidden' without the hint as the someone-else's-order refusal", async () => {
    const stub = makeSupabaseStub({
      'order_requests.select.maybeSingle': {
        data: { status: 'approved', requester_user_id: 'someone-else' },
        error: null,
      },
      'rpc:cancel_order_request': { data: null, error: { message: 'forbidden', code: '42501' } },
    });
    await expect(svc(stub).cancel('ord-1', null)).rejects.toMatchObject({
      code: 'forbidden',
      message: 'You can only cancel your own requests',
    });
  });

  it("the service's own refusal says the same sentence with the same 403 (one rule, one answer, from core)", async () => {
    const stub = makeSupabaseStub({
      'order_requests.select.maybeSingle': {
        data: { status: 'approved', requester_user_id: 'u1' },
        error: null,
      },
    });
    await expect(svc(stub).cancel('ord-1', null)).rejects.toMatchObject({
      code: 'forbidden',
      message: ORDER_CANCEL_REQUESTER_PENDING_ONLY_COPY,
    });
    expect(stub.rpcCalls).toHaveLength(0);
  });
});

describe('OrderRequestsService.setInternalNotes — write access to the order\'s warehouse (0395 L129a)', () => {
  it('refuses a viewer granted orders:approve before any write (the policy would match no row)', async () => {
    const stub = makeSupabaseStub({
      'order_requests.select.maybeSingle': { data: { warehouse_id: 'wh-a' }, error: null },
      'user_warehouse_assignments.select': { data: [{ warehouse_id: 'wh-a', is_primary: true }], error: null },
      'organization_members.select.maybeSingle': { data: { all_warehouses: false }, error: null },
      'order_requests.update.maybeSingle': { data: { id: 'ord-1' }, error: null },
    });
    await expect(
      svc(stub, { role: 'viewer', permissions: ['orders:approve'] }).setInternalNotes('ord-1', 'Gate code 12'),
    ).rejects.toThrow('Read-only auditor cannot perform write operations.');
    expect(stub.chains.get('order_requests.update')).toBeUndefined();
  });

  it('lets staff granted orders:approve save notes on their own warehouse\'s order', async () => {
    const stub = makeSupabaseStub({
      'order_requests.select.maybeSingle': { data: { warehouse_id: 'wh-a' }, error: null },
      'user_warehouse_assignments.select': { data: [{ warehouse_id: 'wh-a', is_primary: true }], error: null },
      'organization_members.select.maybeSingle': { data: { all_warehouses: false }, error: null },
      'order_requests.update.maybeSingle': { data: { id: 'ord-1' }, error: null },
    });
    await svc(stub, { role: 'staff', permissions: ['orders:approve'] }).setInternalNotes('ord-1', 'Gate code 12');
    expect(stub.chainArgs.get('order_requests.update')?.[0]).toEqual([{ internal_notes: 'Gate code 12' }]);
  });

  it("refuses staff granted orders:approve on another warehouse's order", async () => {
    const stub = makeSupabaseStub({
      'order_requests.select.maybeSingle': { data: { warehouse_id: 'wh-b' }, error: null },
      'user_warehouse_assignments.select': { data: [{ warehouse_id: 'wh-a', is_primary: true }], error: null },
      'organization_members.select.maybeSingle': { data: { all_warehouses: false }, error: null },
    });
    await expect(
      svc(stub, { role: 'staff', permissions: ['orders:approve'] }).setInternalNotes('ord-1', 'Gate code 12'),
    ).rejects.toThrow(ORDER_WAREHOUSE_WRITE_REFUSED_COPY);
    expect(stub.chains.get('order_requests.update')).toBeUndefined();
  });
});
