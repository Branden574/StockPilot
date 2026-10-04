import { beforeEach, describe, expect, it, vi } from 'vitest';

import { NEEDED_BY_BUSY_COPY, type ModuleId } from '@stockpilot/core';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

/**
 * Migration 0389: generatePackingSlips mints through ONE SECURITY DEFINER call,
 * generate_order_packing_slips, which writes the raw signature token to the
 * service-only order_request_secrets and only its sha256 to the order row.
 * The service keeps its own gates (module, orders:approve with the MFA
 * step-up, warehouse write) and its follow-ups (audit, webhook, email), never
 * writes a token itself, and words the function's refusals as it always has.
 */

vi.mock('@/lib/auth/warehouse', () => ({ assertWarehouseAccess: vi.fn() }));
vi.mock('./audit', () => ({ audit: vi.fn(async () => {}) }));
vi.mock('./integration-events', () => ({ dispatchEvent: vi.fn(async () => {}) }));
vi.mock('@/lib/email/order-requests', () => ({ sendOrderRequestEmail: vi.fn(async () => ({ ok: true })) }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => makeSupabaseStub().client }));

import { assertWarehouseAccess } from '@/lib/auth/warehouse';

import { audit } from './audit';
import { dispatchEvent } from './integration-events';
import { OrderRequestsService } from './order-requests';

const ORDER = 'ord-389';
const DIGEST = 'd'.repeat(64);

function svc(stub: ReturnType<typeof makeSupabaseStub>, overrides: Parameters<typeof makeServiceContext>[1] = {}) {
  return new (OrderRequestsService as unknown as new (ctx: unknown) => OrderRequestsService)(
    makeServiceContext(stub.client, {
      role: 'manager',
      userId: 'mgr-1',
      enabledModules: new Set<ModuleId>(['orders']),
      ...overrides,
    }),
  );
}

function stubWith(rpc: { data: unknown; error: unknown }) {
  return makeSupabaseStub({
    'order_requests.select.maybeSingle': { data: { warehouse_id: 'wh-1' }, error: null },
    'rpc:generate_order_packing_slips': rpc as never,
  });
}

beforeEach(() => vi.clearAllMocks());

describe('generatePackingSlips (0389)', () => {
  it('calls generate_order_packing_slips once, writes nothing to the order itself, then audits and announces', async () => {
    const row = { id: ORDER, status: 'packing_slip_generated', order_number: 7, signature_token: DIGEST };
    const stub = stubWith({ data: row, error: null });
    const out = await svc(stub).generatePackingSlips(ORDER);
    expect(out).toBe(row);
    expect(stub.rpcCalls).toEqual([{ name: 'generate_order_packing_slips', args: { p_id: ORDER } }]);
    // No user-client write of a token, a status or a stamp any more.
    expect(stub.chainsAll.get('order_requests.update')).toBeUndefined();
    expect(assertWarehouseAccess).toHaveBeenCalledWith('wh-1', 'write', expect.anything());
    expect(audit).toHaveBeenCalledWith(
      { event: 'order.packing_slip_generated', entityType: 'order_request', entityId: ORDER },
      expect.anything(),
    );
    expect(dispatchEvent).toHaveBeenCalledWith(expect.any(String), 'order.status_changed', {
      id: ORDER,
      orderNumber: 'SO-000007',
      status: 'packing_slip_generated',
    });
  });

  it.each([
    [
      { message: 'packing_slips_not_ready', code: 'P0001', hint: 'packing_slips_not_ready' },
      'validation_error',
      'Packing slips can only be generated after picking is complete.',
    ],
    [
      { message: 'order_already_signed', code: 'P0001', hint: 'order_already_signed' },
      'validation_error',
      'This order has already been signed and completed. Re-generating packing slips would invalidate the signed record.',
    ],
    [{ message: 'order_request_not_found', code: 'P0002' }, 'not_found', 'Order not found'],
    [{ message: 'module_disabled', code: 'P0001', hint: 'module_disabled' }, 'module_disabled', 'Module not enabled for this organization: orders'],
    [{ message: 'forbidden', code: '42501', hint: 'orders_approve' }, 'forbidden', 'Missing permission: orders:approve'],
    [{ message: 'forbidden', code: '42501', hint: 'warehouse_write' }, 'forbidden', "You do not have write access to this order's warehouse."],
    [{ message: 'unauthenticated', code: '42501' }, 'unauthenticated', 'Sign in again to generate packing slips.'],
    [{ message: 'canceling statement due to lock timeout', code: '55P03' }, 'conflict', NEEDED_BY_BUSY_COPY],
  ])('maps %o to %s', async (error, code, message) => {
    const stub = stubWith({ data: null, error });
    await expect(svc(stub).generatePackingSlips(ORDER)).rejects.toMatchObject({ code, message });
    expect(audit).not.toHaveBeenCalled();
    expect(dispatchEvent).not.toHaveBeenCalled();
  });

  it('an unknown failure is an internal error whose public message names nothing', async () => {
    const stub = stubWith({ data: null, error: { message: 'relation secret', code: 'XX000' } });
    const err = await svc(stub).generatePackingSlips(ORDER).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'internal_error' });
    expect((err as Error).message).not.toMatch(/relation secret/);
  });

  it('keeps its own gates first: a staff member without orders:approve never reaches the database', async () => {
    const stub = stubWith({ data: null, error: null });
    await expect(svc(stub, { role: 'staff' }).generatePackingSlips(ORDER)).rejects.toMatchObject({ code: 'forbidden' });
    expect(stub.rpcCalls).toEqual([]);
  });

  it('keeps the MFA step-up: an approver at AAL1 under a policy never reaches the database', async () => {
    const stub = stubWith({ data: null, error: null });
    await expect(
      svc(stub, { mfaRequired: true, mfaSatisfied: false }).generatePackingSlips(ORDER),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(stub.rpcCalls).toEqual([]);
  });
});
