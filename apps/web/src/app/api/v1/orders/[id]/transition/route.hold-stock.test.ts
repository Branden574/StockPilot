import { beforeEach, describe, expect, it, vi } from 'vitest';
import { revalidateTag } from 'next/cache';
import { NextRequest } from 'next/server';

import {
  HOLD_BUSY_COPY,
  HOLD_MODULE_OFF_COPY,
  HOLD_NO_WAREHOUSE_ACCESS_COPY,
  HOLD_NOT_APPLICABLE_COPY,
  HOLD_NOT_APPROVER_COPY,
  HOLD_ORDER_NOT_FOUND_COPY,
  type ModuleId,
  type Role,
} from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { assertWarehouseAccess, ForbiddenError } from '@/lib/auth/warehouse';
import { reportError } from '@/lib/error-reporter';
import { checkRateLimit } from '@/lib/rate-limit';
import { makeServiceContext, makeSupabaseStub, type QueryResult } from '@/test/supabase-mock';

import { POST } from './route';

// The phone's "Hold available stock" (F2-2): POST .../transition
// { action: 'hold_stock' }, through the REAL OrderRequestsService, so every
// refusal hold_order_stock (0378) raises is followed from the database's words
// to the status and the sentence the phone shows.

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: vi.fn() }));
vi.mock('@/lib/auth/warehouse', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/auth/warehouse')>();
  return { ...real, assertWarehouseAccess: vi.fn(async () => {}) };
});
vi.mock('@/server/loaders/inventory-list', () => ({ revalidateInventoryList: vi.fn() }));
vi.mock('next/cache', () => ({ revalidateTag: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));
vi.mock('@/server/services/audit', () => ({ audit: vi.fn(async () => {}) }));
vi.mock('@/lib/realtime/broadcast', () => ({ broadcastOrderChanged: vi.fn(async () => {}) }));

const ORDER = '11111111-1111-1111-1111-111111111111';
const params = Promise.resolve({ id: ORDER });

function req(body: unknown) {
  return new NextRequest(`http://localhost/api/v1/orders/${ORDER}/transition`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

function asCaller(rpc: QueryResult, opts: { role?: Role; modules?: ModuleId[] } = {}) {
  const stub = makeSupabaseStub({
    'order_requests.select': { data: { warehouse_id: 'wh-1' }, error: null },
    'rpc:hold_order_stock': rpc,
  });
  vi.mocked(withApiContext).mockResolvedValueOnce(
    makeServiceContext(stub.client, {
      role: opts.role ?? 'manager',
      userId: 'u1',
      organizationId: 'o1',
      enabledModules: new Set<ModuleId>(opts.modules ?? ['orders']),
    }) as never,
  );
  return stub;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true, resetAt: 0 } as never);
  vi.mocked(assertWarehouseAccess).mockImplementation(async () => {});
});

describe('POST /api/v1/orders/[id]/transition — hold_stock', () => {
  it('answers what was held, and busts the storefront catalog', async () => {
    const hold = { held: [{ itemId: 'i1', added: 8 }], stillShort: [{ itemId: 'i2', quantity: 6 }] };
    const stub = asCaller({ data: hold, error: null });
    const res = await POST(req({ action: 'hold_stock' }), { params });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hold });
    expect(stub.rpcCalls).toEqual([{ name: 'hold_order_stock', args: { p_order_id: ORDER } }]);
    expect(revalidateTag).toHaveBeenCalledWith('orders-new-v2-catalog', 'max');
  });

  // Every raise string, from the database's words to the phone's.
  it.each([
    [{ message: 'order_request_not_found', code: 'P0002' }, 404, 'not_found', HOLD_ORDER_NOT_FOUND_COPY],
    [{ message: 'module_disabled', code: 'P0001', hint: 'module_disabled' }, 403, 'module_disabled', HOLD_MODULE_OFF_COPY],
    [{ message: 'forbidden', code: '42501', hint: 'orders_approve' }, 403, 'forbidden', HOLD_NOT_APPROVER_COPY],
    [{ message: 'forbidden', code: '42501', hint: 'warehouse_write' }, 403, 'forbidden', HOLD_NO_WAREHOUSE_ACCESS_COPY],
    [{ message: 'unauthenticated', code: '42501' }, 401, 'unauthenticated', 'Sign in again to hold stock.'],
    [{ message: 'hold_not_applicable', code: 'P0001', hint: 'hold_not_applicable', details: 'in_transit' }, 409, 'conflict', HOLD_NOT_APPLICABLE_COPY],
    [{ message: 'canceling statement due to lock timeout', code: '55P03' }, 409, 'conflict', HOLD_BUSY_COPY],
    [{ message: 'permission denied for function hold_order_stock', code: '42501' }, 500, 'internal_error', 'An internal error occurred. Please try again.'],
  ] as const)('%o -> %i %s', async (error, status, code, message) => {
    asCaller({ data: null, error: { ...error } });
    const res = await POST(req({ action: 'hold_stock' }), { params });
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error: code, message });
    expect(revalidateTag).not.toHaveBeenCalled();
  });

  it('the service gates answer before the function: staff without orders:approve 403, module off 403', async () => {
    const staff = asCaller({ data: {}, error: null }, { role: 'staff' });
    const r1 = await POST(req({ action: 'hold_stock' }), { params });
    expect(r1.status).toBe(403);
    expect(staff.rpcCalls).toEqual([]);

    const off = asCaller({ data: {}, error: null }, { modules: [] });
    const r2 = await POST(req({ action: 'hold_stock' }), { params });
    expect(r2.status).toBe(403);
    expect((await r2.json()).error).toBe('module_disabled');
    expect(off.rpcCalls).toEqual([]);
  });

  it('no write access to the warehouse: 403 with the hold sentence, never a 500', async () => {
    vi.mocked(assertWarehouseAccess).mockRejectedValueOnce(new ForbiddenError('User does not have write access to warehouse wh-1.'));
    const stub = asCaller({ data: {}, error: null });
    const res = await POST(req({ action: 'hold_stock' }), { params });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden', message: HOLD_NO_WAREHOUSE_ACCESS_COPY });
    expect(stub.rpcCalls).toEqual([]);
    expect(reportError).not.toHaveBeenCalled();
  });
});

describe('POST /api/v1/orders/[id]/transition — a warehouse refusal is 403 for every action', () => {
  it('approve by a caller without write access to the order warehouse: 403, not a reported 500', async () => {
    vi.mocked(assertWarehouseAccess).mockRejectedValueOnce(new ForbiddenError('User does not have write access to warehouse wh-1.'));
    asCaller({ data: null, error: null });
    const res = await POST(req({ action: 'approve' }), { params });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'forbidden',
      message: 'User does not have write access to warehouse wh-1.',
    });
    expect(reportError).not.toHaveBeenCalled();
  });
});
