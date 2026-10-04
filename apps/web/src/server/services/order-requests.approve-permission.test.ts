import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId, Role } from '@stockpilot/core';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

vi.mock('@/lib/auth/warehouse', () => ({ assertWarehouseAccess: vi.fn() }));
vi.mock('./audit', () => ({ audit: vi.fn(async () => {}) }));
vi.mock('./notifications', () => ({ createNotification: vi.fn(async () => {}) }));
vi.mock('./integration-events', () => ({ dispatchEvent: vi.fn(async () => {}) }));
vi.mock('@/lib/email/order-requests', () => ({ sendOrderRequestEmail: vi.fn(async () => {}) }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => makeSupabaseStub().client }));

import { IN_TRANSIT_NOT_APPROVER_COPY, OrderRequestsService } from './order-requests';
import { audit } from './audit';
import { dispatchEvent } from './integration-events';

/**
 * Security slice D (migration 0390): approval follows the EFFECTIVE
 * orders:approve permission, not the role.
 *
 * - assignDelivery and markInTransit write through the two new SECURITY
 *   DEFINER functions (assign_order_delivery, mark_order_in_transit), because
 *   the order update policy now admits orders:approve holders only and
 *   assignDelivery's permission is orders:assign_delivery. No user-client
 *   UPDATE of order_requests is left in either.
 * - markInTransit asks orders:approve (owner decision O3, default): an
 *   assigned staff driver without it is refused in words that are true, where
 *   it used to read "the assigned driver or a manager" and then fail in the
 *   database.
 * - The requester self-cancel window applies to anyone without
 *   orders:approve: a manager whose orders:approve was revoked gets it, a
 *   staff member granted it does not.
 */

const MANAGER_DEFAULTS = ['orders:approve', 'orders:assign_delivery', 'orders:request'];

function svc(
  stub: ReturnType<typeof makeSupabaseStub>,
  opts: { role?: Role; userId?: string; permissions?: string[] } = {},
) {
  return new (OrderRequestsService as unknown as new (ctx: unknown) => OrderRequestsService)(
    makeServiceContext(stub.client, {
      role: opts.role ?? 'manager',
      userId: opts.userId ?? 'mgr-1',
      enabledModules: new Set<ModuleId>(['orders']),
      ...(opts.permissions ? { permissions: new Set(opts.permissions) } : {}),
    }),
  );
}

/** What the stub answers for an rpc() call (its error type: no null hint). */
type RpcResult = {
  data: unknown;
  error: { message: string; code?: string; hint?: string; details?: string } | null;
};

const STAGED_DELIVERY = {
  warehouse_id: 'wh-1',
  status: 'staged_for_delivery',
  fulfillment_type: 'delivery',
  assigned_delivery_user_id: 'drv-1',
};

beforeEach(() => vi.clearAllMocks());

describe('assignDelivery writes through assign_order_delivery (0390)', () => {
  function assignStub(rpc: RpcResult) {
    return makeSupabaseStub({
      'order_requests.select.maybeSingle': { data: STAGED_DELIVERY, error: null },
      'organization_members.select.maybeSingle': { data: { user_id: 'drv-2' }, error: null },
      'rpc:assign_order_delivery': rpc,
    });
  }

  it('calls the function with the order and the driver, and never updates the row through the user client', async () => {
    const stub = assignStub({
      data: { id: 'ord-1', assigned_delivery_user_id: 'drv-2', requester_name: 'Pat' },
      error: null,
    });
    const row = await svc(stub).assignDelivery('ord-1', 'drv-2');
    expect(row).toMatchObject({ id: 'ord-1', assigned_delivery_user_id: 'drv-2' });
    expect(stub.rpcCalls).toEqual([
      { name: 'assign_order_delivery', args: { p_id: 'ord-1', p_driver: 'drv-2' } },
    ]);
    expect(stub.chains.get('order_requests.update')).toBeUndefined();
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'order.delivery_assigned', entityId: 'ord-1' }),
      expect.anything(),
    );
  });

  it('a manager whose orders:approve was revoked still assigns (they keep orders:assign_delivery)', async () => {
    const stub = assignStub({ data: { id: 'ord-1', assigned_delivery_user_id: 'drv-2' }, error: null });
    await svc(stub, { permissions: ['orders:assign_delivery', 'orders:request'] }).assignDelivery('ord-1', 'drv-2');
    expect(stub.rpcCalls.map((c) => c.name)).toEqual(['assign_order_delivery']);
  });

  it('refuses without orders:assign_delivery before any database call', async () => {
    const stub = assignStub({ data: null, error: null });
    await expect(
      svc(stub, { permissions: ['orders:approve', 'orders:request'] }).assignDelivery('ord-1', 'drv-2'),
    ).rejects.toMatchObject({ code: 'forbidden', message: 'Missing permission: orders:assign_delivery' });
    expect(stub.rpcCalls).toHaveLength(0);
  });

  it.each([
    [{ code: '42501', message: 'forbidden', hint: 'orders_assign_delivery' }, 'forbidden', 'Missing permission: orders:assign_delivery'],
    [{ code: '42501', message: 'forbidden', hint: 'warehouse_write' }, 'forbidden', "You don't have write access to this order's warehouse."],
    [{ code: 'P0001', message: 'delivery_not_assignable', hint: 'not_staged_for_delivery' }, 'validation_error', 'Delivery can only be assigned to staged-for-delivery orders.'],
    [{ code: 'P0001', message: 'driver_not_member', hint: 'driver_not_member' }, 'validation_error', 'That user is not an active member of this organization.'],
    [{ code: 'P0002', message: 'order_request_not_found' }, 'not_found', 'Order not found'],
    [{ code: 'P0001', message: 'module_disabled', hint: 'module_disabled' }, 'module_disabled', 'Module not enabled for this organization: orders'],
    [{ code: '55P03', message: 'canceling statement due to lock timeout' }, 'conflict', 'Someone else is changing this order right now. Try again.'],
    [{ code: '42501', message: 'unauthenticated' }, 'unauthenticated', 'Sign in again to change this order.'],
  ])('maps the function refusal %o to %s', async (error, code, message) => {
    const stub = assignStub({ data: null, error });
    await expect(svc(stub).assignDelivery('ord-1', 'drv-2')).rejects.toMatchObject({ code, message });
    expect(audit).not.toHaveBeenCalled();
  });

  it('an unknown database error is an internal error whose public message carries no database text', async () => {
    const stub = assignStub({ data: null, error: { code: 'XX000', message: 'relation "order_requests" secret' } });
    const e = await svc(stub).assignDelivery('ord-1', 'drv-2').catch((x: unknown) => x);
    expect(e).toMatchObject({ code: 'internal_error' });
    expect((e as Error).message).not.toMatch(/order_requests/);
  });
});

describe('markInTransit follows orders:approve and writes through mark_order_in_transit (0390, O3 default)', () => {
  function transitStub(rpc: RpcResult, row = STAGED_DELIVERY) {
    return makeSupabaseStub({
      'order_requests.select.maybeSingle': { data: row, error: null },
      'rpc:mark_order_in_transit': rpc,
    });
  }
  const DONE = { data: { id: 'ord-1', status: 'in_transit', order_number: 12 }, error: null };

  it('an approver who is not the driver marks it in transit through the function, with no user-client update', async () => {
    const stub = transitStub(DONE);
    const row = await svc(stub).markInTransit('ord-1');
    expect(row).toMatchObject({ status: 'in_transit' });
    expect(stub.rpcCalls).toEqual([{ name: 'mark_order_in_transit', args: { p_id: 'ord-1' } }]);
    expect(stub.chains.get('order_requests.update')).toBeUndefined();
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'order.in_transit', entityId: 'ord-1' }),
      expect.anything(),
    );
    expect(dispatchEvent).toHaveBeenCalledWith('org-test', 'order.in_transit', expect.objectContaining({ id: 'ord-1' }));
  });

  it('refuses an assigned staff driver without orders:approve, in true words, before the database', async () => {
    const stub = transitStub(DONE);
    await expect(svc(stub, { role: 'staff', userId: 'drv-1' }).markInTransit('ord-1')).rejects.toMatchObject({
      code: 'forbidden',
      message: IN_TRANSIT_NOT_APPROVER_COPY,
    });
    expect(IN_TRANSIT_NOT_APPROVER_COPY).toBe('Only someone who can approve orders can mark a delivery in transit.');
    expect(stub.rpcCalls).toHaveLength(0);
    expect(audit).not.toHaveBeenCalled();
  });

  it('refuses a manager whose orders:approve was revoked, even as the driver', async () => {
    const stub = transitStub(DONE);
    await expect(
      svc(stub, { userId: 'drv-1', permissions: ['orders:assign_delivery', 'orders:request'] }).markInTransit('ord-1'),
    ).rejects.toMatchObject({ code: 'forbidden', message: IN_TRANSIT_NOT_APPROVER_COPY });
    expect(stub.rpcCalls).toHaveLength(0);
  });

  it('lets a staff member granted orders:approve mark it, driver or not', async () => {
    for (const userId of ['drv-1', 'stf-9']) {
      const stub = transitStub(DONE);
      await svc(stub, { role: 'staff', userId, permissions: ['orders:approve', 'orders:request'] }).markInTransit('ord-1');
      expect(stub.rpcCalls.map((c) => c.name)).toEqual(['mark_order_in_transit']);
    }
  });

  it('keeps the validation messages it gave before the permission check', async () => {
    const pickup = transitStub(DONE, { ...STAGED_DELIVERY, fulfillment_type: 'pickup' });
    await expect(svc(pickup, { role: 'staff' }).markInTransit('ord-1')).rejects.toMatchObject({
      code: 'validation_error',
      message: 'Only delivery orders can be marked in transit.',
    });
    const noDriver = transitStub(DONE, { ...STAGED_DELIVERY, assigned_delivery_user_id: null as unknown as string });
    await expect(svc(noDriver).markInTransit('ord-1')).rejects.toMatchObject({
      code: 'validation_error',
      message: 'Assign a driver before marking in transit.',
    });
  });

  it.each([
    [{ code: 'P0001', message: 'order_status_changed', hint: 'status_changed' }, 'conflict', 'Order status changed — refresh and try again.'],
    [{ code: 'P0001', message: 'not_a_delivery', hint: 'not_a_delivery' }, 'validation_error', 'Only delivery orders can be marked in transit.'],
    [{ code: 'P0001', message: 'no_driver', hint: 'no_driver' }, 'validation_error', 'Assign a driver before marking in transit.'],
    [{ code: '42501', message: 'forbidden', hint: 'orders_approve' }, 'forbidden', IN_TRANSIT_NOT_APPROVER_COPY],
    [{ code: '42501', message: 'forbidden', hint: 'warehouse_write' }, 'forbidden', "You don't have write access to this order's warehouse."],
    [{ code: '57014', message: 'canceling statement due to statement timeout' }, 'conflict', 'Someone else is changing this order right now. Try again.'],
  ])('maps the function refusal %o to %s, and notifies no one', async (error, code, message) => {
    const stub = transitStub({ data: null, error });
    await expect(svc(stub).markInTransit('ord-1')).rejects.toMatchObject({ code, message });
    expect(audit).not.toHaveBeenCalled();
    expect(dispatchEvent).not.toHaveBeenCalled();
  });
});

describe('cancel: the requester self-cancel window follows orders:approve (0390)', () => {
  const OK_RPC = {
    'rpc:cancel_order_request': { data: { id: 'ord-1', status: 'cancelled', order_number: 7 }, error: null },
  };
  function cancelStub(status: string, requester = 'u1') {
    return makeSupabaseStub({
      'order_requests.select.maybeSingle': { data: { status, requester_user_id: requester }, error: null },
      ...OK_RPC,
    });
  }

  it('a manager whose orders:approve was revoked may cancel their own order only while it is pending', async () => {
    const approved = cancelStub('approved');
    await expect(
      svc(approved, { userId: 'u1', permissions: ['orders:assign_delivery', 'orders:request'] }).cancel('ord-1', null),
    ).rejects.toMatchObject({ code: 'validation_error' });
    expect(approved.rpcCalls).toHaveLength(0);

    const pending = cancelStub('pending_approval');
    await svc(pending, { userId: 'u1', permissions: ['orders:assign_delivery', 'orders:request'] }).cancel('ord-1', null);
    expect(pending.rpcCalls.map((c) => c.name)).toEqual(['cancel_order_request']);
  });

  it('a staff member granted orders:approve cancels an approved order (their own included) without the requester window', async () => {
    const stub = cancelStub('approved');
    await svc(stub, { role: 'staff', userId: 'u1', permissions: ['orders:approve', 'orders:request'] }).cancel('ord-1', null);
    expect(stub.rpcCalls.map((c) => c.name)).toEqual(['cancel_order_request']);
    expect(stub.chains.get('order_requests.select')).toBeUndefined();
  });

  it('a manager by role default skips the window, and staff without the grant keep it', async () => {
    const mgr = cancelStub('approved');
    await svc(mgr, { userId: 'u1', permissions: MANAGER_DEFAULTS }).cancel('ord-1', null);
    expect(mgr.rpcCalls).toHaveLength(1);

    const staff = cancelStub('approved');
    await expect(svc(staff, { role: 'staff', userId: 'u1' }).cancel('ord-1', null)).rejects.toMatchObject({
      code: 'validation_error',
      message:
        'You can only cancel your own request while it is still pending approval. Ask someone who approves orders to cancel approved or in-progress requests.',
    });
  });
});
