import { describe, expect, it, vi } from 'vitest';

import type { ModuleId } from '@stockpilot/core';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

import { OrderRequestsService } from './order-requests';

// Warehouse access is enforced elsewhere (lib/auth/warehouse) — stub it so the
// service methods run; audit is a fire-and-forget side effect.
vi.mock('@/lib/auth/warehouse', () => ({ assertWarehouseAccess: vi.fn() }));
vi.mock('./audit', () => ({ audit: vi.fn(async () => {}) }));

// Service-layer error mapping for the picking claim/assign/release RPCs. The
// race/lock/authorization behavior itself is proven by pgTAP 0237 against real
// Postgres; here we pin that the service maps each RPC error to the right
// ServiceError code + forwards the RPC args.

function svc(stub: ReturnType<typeof makeSupabaseStub>) {
  return new (OrderRequestsService as unknown as new (ctx: unknown) => OrderRequestsService)(
    makeServiceContext(stub.client, {
      role: 'admin',
      enabledModules: new Set<ModuleId>(['orders']),
    }),
  );
}

// requireWarehouseAccess reads the order's warehouse; admin has all access.
const WH = { 'order_requests.select.maybeSingle': { data: { warehouse_id: 'wh-1' }, error: null } };

describe('OrderRequestsService — picking claim / assign / release', () => {
  it('claimPicking forwards to claim_picking and returns the order', async () => {
    const stub = makeSupabaseStub({
      ...WH,
      'rpc:claim_picking': { data: { id: 'order-1', assigned_picker_id: 'u-1' }, error: null },
    });
    const row = await svc(stub).claimPicking('order-1');
    expect((row as { assigned_picker_id: string }).assigned_picker_id).toBe('u-1');
    expect(stub.rpcCalls[0]).toEqual({ name: 'claim_picking', args: { p_order_id: 'order-1' } });
  });

  it('claimPicking maps already_claimed to a conflict (the race loser)', async () => {
    const stub = makeSupabaseStub({
      ...WH,
      'rpc:claim_picking': { data: null, error: { message: 'already_claimed' } },
    });
    const err = await svc(stub).claimPicking('order-1').catch((e: unknown) => e);
    expect((err as { code: string }).code).toBe('conflict');
  });

  it('assignPicking forwards {p_order_id, p_user_id} and maps forbidden', async () => {
    const ok = makeSupabaseStub({
      ...WH,
      'rpc:assign_picking': { data: { id: 'order-1', assigned_picker_id: 'picker-9' }, error: null },
    });
    await svc(ok).assignPicking('order-1', 'picker-9');
    expect(ok.rpcCalls[0]).toEqual({
      name: 'assign_picking',
      args: { p_order_id: 'order-1', p_user_id: 'picker-9' },
    });

    const denied = makeSupabaseStub({
      ...WH,
      'rpc:assign_picking': { data: null, error: { message: 'forbidden' } },
    });
    const err = await svc(denied).assignPicking('order-1', 'picker-9').catch((e: unknown) => e);
    expect((err as { code: string }).code).toBe('forbidden');
  });

  it('assignPicking maps invalid_picker to a validation error', async () => {
    const stub = makeSupabaseStub({
      ...WH,
      'rpc:assign_picking': { data: null, error: { message: 'invalid_picker' } },
    });
    const err = await svc(stub).assignPicking('order-1', 'nobody').catch((e: unknown) => e);
    expect((err as { code: string }).code).toBe('validation_error');
  });

  it('releasePicking forwards to release_picking and maps forbidden', async () => {
    const ok = makeSupabaseStub({
      ...WH,
      'rpc:release_picking': { data: { id: 'order-1', assigned_picker_id: null }, error: null },
    });
    await svc(ok).releasePicking('order-1');
    expect(ok.rpcCalls[0]).toEqual({ name: 'release_picking', args: { p_order_id: 'order-1' } });

    const denied = makeSupabaseStub({
      ...WH,
      'rpc:release_picking': { data: null, error: { message: 'forbidden' } },
    });
    const err = await svc(denied).releasePicking('order-1').catch((e: unknown) => e);
    expect((err as { code: string }).code).toBe('forbidden');
  });
});
