import { describe, expect, it, vi } from 'vitest';

import type { ModuleId } from '@stockpilot/core';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

// Warehouse access is enforced elsewhere (lib/auth/warehouse) — stub it so the
// service method runs; audit is asserted directly below.
vi.mock('@/lib/auth/warehouse', () => ({ assertWarehouseAccess: vi.fn() }));
vi.mock('./audit', () => ({ audit: vi.fn(async () => {}) }));

import { OrderRequestsService } from './order-requests';
import { audit } from './audit';

// Service-layer error mapping + reason discipline for the manager
// reopen-picking override (0289 reopen_picking RPC). The RPC's own
// authorization/transition/stock-restore behavior is proven by pgTAP
// (0289_reopen_picking.test.sql); here we pin that the service (a) refuses a
// blank reason WITHOUT calling the RPC, (b) forwards the trimmed reason to
// both the RPC and the audit event, and (c) maps each RPC errcode to the
// right ServiceError code.

function svc(stub: ReturnType<typeof makeSupabaseStub>) {
  return new OrderRequestsService(
    makeServiceContext(stub.client, {
      role: 'manager',
      enabledModules: new Set<ModuleId>(['orders']),
    }),
  );
}

// requireWarehouseAccess reads the order's warehouse; manager has all access.
const WH = { 'order_requests.select.maybeSingle': { data: { warehouse_id: 'wh-1' }, error: null } };

describe('OrderRequestsService.reopenPicking', () => {
  it('requires a non-blank reason (no RPC call)', async () => {
    const stub = makeSupabaseStub({ ...WH });
    await expect(svc(stub).reopenPicking('ord-1', '   ')).rejects.toMatchObject({
      code: 'validation_error',
      details: { reason: 'reopen_reason_required' },
    });
    expect(stub.rpcCalls).toHaveLength(0);
  });

  it('calls reopen_picking with the reason and audits on success', async () => {
    const stub = makeSupabaseStub({
      ...WH,
      'rpc:reopen_picking': { data: { id: 'ord-1', status: 'picking_in_progress' }, error: null },
    });
    const row = await svc(stub).reopenPicking('ord-1', 'Miscount on line 1');
    expect(stub.rpcCalls[0]).toEqual({
      name: 'reopen_picking',
      args: { p_id: 'ord-1', p_reason: 'Miscount on line 1' },
    });
    expect((row as { status: string }).status).toBe('picking_in_progress');
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'order.picking_reopened',
        entityId: 'ord-1',
        reason: 'Miscount on line 1',
      }),
      expect.anything(),
    );
  });

  it('trims the reason before it reaches the RPC and the audit trail', async () => {
    const stub = makeSupabaseStub({
      ...WH,
      'rpc:reopen_picking': { data: { id: 'ord-1', status: 'picking_in_progress' }, error: null },
    });
    await svc(stub).reopenPicking('ord-1', '  Miscount  ');
    expect(stub.rpcCalls[0]).toEqual({
      name: 'reopen_picking',
      args: { p_id: 'ord-1', p_reason: 'Miscount' },
    });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'Miscount' }),
      expect.anything(),
    );
  });

  it('maps already_signed to a friendly conflict', async () => {
    const stub = makeSupabaseStub({
      ...WH,
      'rpc:reopen_picking': { data: null, error: { message: 'already_signed' } },
    });
    await expect(svc(stub).reopenPicking('ord-1', 'x')).rejects.toMatchObject({ code: 'conflict' });
  });

  it('maps order_request_not_found to not_found', async () => {
    const stub = makeSupabaseStub({
      ...WH,
      'rpc:reopen_picking': { data: null, error: { message: 'order_request_not_found' } },
    });
    await expect(svc(stub).reopenPicking('ord-1', 'x')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('maps forbidden to a forbidden ServiceError', async () => {
    const stub = makeSupabaseStub({
      ...WH,
      'rpc:reopen_picking': { data: null, error: { message: 'forbidden' } },
    });
    await expect(svc(stub).reopenPicking('ord-1', 'x')).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('maps invalid_status_transition to a validation error', async () => {
    const stub = makeSupabaseStub({
      ...WH,
      'rpc:reopen_picking': { data: null, error: { message: 'invalid_status_transition' } },
    });
    await expect(svc(stub).reopenPicking('ord-1', 'x')).rejects.toMatchObject({
      code: 'validation_error',
    });
  });

  it('maps a reopen_reason_required errcode surfaced by the RPC too (defense in depth)', async () => {
    const stub = makeSupabaseStub({
      ...WH,
      'rpc:reopen_picking': { data: null, error: { message: 'reopen_reason_required' } },
    });
    await expect(svc(stub).reopenPicking('ord-1', 'x')).rejects.toMatchObject({
      code: 'validation_error',
      details: { reason: 'reopen_reason_required' },
    });
  });

  it('maps unauthenticated to a 401 ServiceError', async () => {
    const stub = makeSupabaseStub({
      ...WH,
      'rpc:reopen_picking': { data: null, error: { message: 'unauthenticated' } },
    });
    await expect(svc(stub).reopenPicking('ord-1', 'x')).rejects.toMatchObject({
      code: 'unauthenticated',
    });
  });

  it('maps an unresolved destination-location failure to an internal error, not a user error', async () => {
    const stub = makeSupabaseStub({
      ...WH,
      'rpc:reopen_picking': { data: null, error: { message: 'unplaced_location_not_found' } },
    });
    await expect(svc(stub).reopenPicking('ord-1', 'x')).rejects.toMatchObject({
      code: 'internal_error',
    });
  });
});
