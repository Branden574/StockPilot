import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId, Role } from '@stockpilot/core';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

vi.mock('./audit', () => ({ audit: vi.fn(async () => {}) }));
vi.mock('./integration-events', () => ({ dispatchEvent: vi.fn(async () => {}) }));
vi.mock('@/lib/email/order-requests', () => ({ sendOrderRequestEmail: vi.fn(async () => {}) }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => makeSupabaseStub().client }));

import { OrderRequestsService } from './order-requests';
import { audit } from './audit';

/**
 * SP-050 — the M7 requester self-cancel rule had NO test at any layer.
 *
 * The TypeScript guard in `cancel()` is the ONLY enforcement of "a requester
 * may only cancel their OWN request while it is still pending approval". The
 * RPC deliberately does not back it up: 0290_cancel_restock_guard refuses only
 * terminal statuses and then accepts owner-or-manager, so a requester reaching
 * the DB directly could cancel an APPROVED, mid-pick order — releasing its
 * reservations and restocking picked units out from under the picker who
 * claimed it. A role-allowlist edit or a status rename would have silently
 * disabled the guard with the whole suite green; these tests pin it.
 */

function svc(
  stub: ReturnType<typeof makeSupabaseStub>,
  opts: { role?: Role; userId?: string } = {},
) {
  return new (OrderRequestsService as unknown as new (ctx: unknown) => OrderRequestsService)(
    makeServiceContext(stub.client, {
      role: opts.role ?? 'staff',
      userId: opts.userId ?? 'u1',
      enabledModules: new Set<ModuleId>(['orders']),
    }),
  );
}

const OK_RPC = {
  'rpc:cancel_order_request': {
    data: { id: 'ord-1', status: 'cancelled', order_number: 7 },
    error: null,
  },
};

beforeEach(() => vi.clearAllMocks());

describe('OrderRequestsService.cancel — requester self-cancel window', () => {
  it('refuses a requester cancelling their own APPROVED order, without reaching the RPC', async () => {
    const stub = makeSupabaseStub({
      'order_requests.select.maybeSingle': {
        data: { status: 'approved', requester_user_id: 'u1' },
        error: null,
      },
      ...OK_RPC,
    });
    await expect(svc(stub).cancel('ord-1', null)).rejects.toMatchObject({
      code: 'validation_error',
    });
    expect(stub.rpcCalls).toHaveLength(0);
  });

  it('refuses at every other non-terminal status too (the rule is pending_approval ONLY)', async () => {
    for (const status of [
      'pick_slip_generated',
      'picking_in_progress',
      'picking_complete',
      'packing_slip_generated',
      'staged_for_pickup',
      'staged_for_delivery',
      'in_transit',
    ]) {
      const stub = makeSupabaseStub({
        'order_requests.select.maybeSingle': {
          data: { status, requester_user_id: 'u1' },
          error: null,
        },
        ...OK_RPC,
      });
      await expect(svc(stub).cancel('ord-1', null)).rejects.toMatchObject({
        code: 'validation_error',
      });
      expect(stub.rpcCalls).toHaveLength(0);
    }
  });

  it('allows a requester to cancel their own pending-approval order', async () => {
    const stub = makeSupabaseStub({
      'order_requests.select.maybeSingle': {
        data: { status: 'pending_approval', requester_user_id: 'u1' },
        error: null,
      },
      ...OK_RPC,
    });
    const row = await svc(stub).cancel('ord-1', null);
    expect(stub.rpcCalls[0]).toEqual({
      name: 'cancel_order_request',
      args: { p_id: 'ord-1', p_reason: null },
    });
    expect((row as { status: string }).status).toBe('cancelled');
  });

  it('does not apply the requester window to a manager (no ownership probe at all)', async () => {
    const stub = makeSupabaseStub({
      'order_requests.select.maybeSingle': {
        data: { status: 'approved', requester_user_id: 'u1' },
        error: null,
      },
      ...OK_RPC,
    });
    await svc(stub, { role: 'manager', userId: 'mgr-1' }).cancel('ord-1', null);
    expect(stub.rpcCalls[0]?.name).toBe('cancel_order_request');
    // The manager path must not even read the row to decide.
    expect(stub.fromCalls).not.toContain('order_requests');
  });

  it("does not apply the window to a staff member cancelling SOMEONE ELSE's order (the RPC decides)", async () => {
    const stub = makeSupabaseStub({
      'order_requests.select.maybeSingle': {
        data: { status: 'approved', requester_user_id: 'someone-else' },
        error: null,
      },
      'rpc:cancel_order_request': { data: null, error: { message: 'forbidden' } },
    });
    await expect(svc(stub).cancel('ord-1', null)).rejects.toMatchObject({ code: 'forbidden' });
    expect(stub.rpcCalls).toHaveLength(1);
  });

  it('forwards the reason to the RPC and to the audit trail', async () => {
    const stub = makeSupabaseStub({
      'order_requests.select.maybeSingle': {
        data: { status: 'pending_approval', requester_user_id: 'u1' },
        error: null,
      },
      ...OK_RPC,
    });
    await svc(stub).cancel('ord-1', 'dup');
    expect(stub.rpcCalls[0]).toEqual({
      name: 'cancel_order_request',
      args: { p_id: 'ord-1', p_reason: 'dup' },
    });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'order_request.cancelled',
        entityId: 'ord-1',
        reason: 'dup',
      }),
      expect.anything(),
    );
  });
});

describe('OrderRequestsService.cancel — RPC error mapping', () => {
  const cases: Array<[string, string]> = [
    ['order_request_not_found', 'not_found'],
    ['forbidden', 'forbidden'],
    ['invalid_status_transition', 'validation_error'],
    ['something else entirely', 'internal_error'],
  ];
  for (const [message, code] of cases) {
    it(`maps "${message}" to ${code}`, async () => {
      const stub = makeSupabaseStub({
        'order_requests.select.maybeSingle': {
          data: { status: 'pending_approval', requester_user_id: 'u1' },
          error: null,
        },
        'rpc:cancel_order_request': { data: null, error: { message } },
      });
      await expect(svc(stub).cancel('ord-1', null)).rejects.toMatchObject({ code });
    });
  }
});
