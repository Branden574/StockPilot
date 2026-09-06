import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId } from '@stockpilot/core';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

vi.mock('@/lib/auth/warehouse', () => ({ assertWarehouseAccess: vi.fn() }));
vi.mock('./audit', () => ({ audit: vi.fn(async () => {}) }));
vi.mock('./integration-events', () => ({ dispatchEvent: vi.fn(async () => {}) }));
vi.mock('@/lib/email/order-requests', () => ({ sendOrderRequestEmail: vi.fn(async () => {}) }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => makeSupabaseStub().client }));

import { OrderRequestsService } from './order-requests';
import { audit } from './audit';
import { dispatchEvent } from './integration-events';
import { sendOrderRequestEmail } from '@/lib/email/order-requests';

function svc(stub: ReturnType<typeof makeSupabaseStub>, userId = 'mgr-1') {
  return new (OrderRequestsService as unknown as new (ctx: unknown) => OrderRequestsService)(
    makeServiceContext(stub.client, {
      role: 'manager',
      userId,
      enabledModules: new Set<ModuleId>(['orders']),
    }),
  );
}

/** Args passed to a recorded chain method, or undefined when never called. */
function argsFor(
  stub: ReturnType<typeof makeSupabaseStub>,
  key: string,
  method: string,
): unknown[][] {
  const methods = stub.chains.get(key) ?? [];
  const args = stub.chainArgs.get(key) ?? [];
  return methods.map((m, i) => (m === method ? args[i] : null)).filter(Boolean) as unknown[][];
}

beforeEach(() => vi.clearAllMocks());

/**
 * SP-069: every one of these transitions validated the current status in a
 * SEPARATE prior SELECT and then wrote unconditionally. The status trigger
 * short-circuits a same-status write (0289: `if v_old is not distinct from
 * v_new then return new`), so two overlapping requests both passed the SELECT
 * and both UPDATEs succeeded — duplicate emails, duplicate webhook deliveries
 * and a re-stamped timestamp. The write must carry the expected status itself
 * and refuse (conflict) when it matched no row, BEFORE any notify/dispatch.
 */
describe('order transitions are compare-and-set', () => {
  it('generatePickSlip pins status=approved on the UPDATE and refuses a lost race', async () => {
    const stub = makeSupabaseStub({
      'order_requests.select.maybeSingle': {
        data: { warehouse_id: 'wh-1', status: 'approved' },
        error: null,
      },
      // 0 rows: another request already moved the order on.
      'order_requests.update.maybeSingle': { data: null, error: null },
    });
    await expect(svc(stub).generatePickSlip('ord-1')).rejects.toMatchObject({ code: 'conflict' });
    expect(argsFor(stub, 'order_requests.update', 'eq')).toContainEqual(['status', 'approved']);
    expect(audit).not.toHaveBeenCalled();
  });

  it('stageOrder pins status=packing_slip_generated and refuses a lost race', async () => {
    const stub = makeSupabaseStub({
      'order_requests.select.maybeSingle': {
        data: {
          warehouse_id: 'wh-1',
          status: 'packing_slip_generated',
          fulfillment_type: 'delivery',
          picking_completed_at: null,
        },
        error: null,
      },
      'order_request_lines.select': { data: null, error: null, count: 0 },
      'order_requests.update.maybeSingle': { data: null, error: null },
    });
    await expect(svc(stub).stageOrder('ord-1', 'staged_for_delivery')).rejects.toMatchObject({
      code: 'conflict',
    });
    expect(argsFor(stub, 'order_requests.update', 'eq')).toContainEqual([
      'status',
      'packing_slip_generated',
    ]);
    expect(audit).not.toHaveBeenCalled();
    expect(dispatchEvent).not.toHaveBeenCalled();
    expect(sendOrderRequestEmail).not.toHaveBeenCalled();
  });

  it('markInTransit pins status=staged_for_delivery and refuses a lost race without re-notifying', async () => {
    const stub = makeSupabaseStub({
      'order_requests.select.maybeSingle': {
        data: {
          warehouse_id: 'wh-1',
          status: 'staged_for_delivery',
          fulfillment_type: 'delivery',
          assigned_delivery_user_id: 'mgr-1',
        },
        error: null,
      },
      'order_requests.update.maybeSingle': { data: null, error: null },
    });
    await expect(svc(stub).markInTransit('ord-1')).rejects.toMatchObject({ code: 'conflict' });
    expect(argsFor(stub, 'order_requests.update', 'eq')).toContainEqual([
      'status',
      'staged_for_delivery',
    ]);
    expect(audit).not.toHaveBeenCalled();
    expect(dispatchEvent).not.toHaveBeenCalled();
    expect(sendOrderRequestEmail).not.toHaveBeenCalled();
  });
});

/**
 * SP-082: addLines is allowed at picking_complete / packing_slip_generated and
 * inserts rows with quantity_picked NULL. stageOrder's pre-0121 "no NULL
 * picked lines" guard then refused to stage the order at all, and the only way
 * out was a manager reopen (which reverses every pick's stock draw). A line
 * added AFTER picking completed is 0-picked by construction — exactly how
 * confirm_signature/cancel-restock/reopen already treat it — so the guard must
 * only look at lines that existed when picking finished.
 */
describe('stageOrder NULL-picked guard is scoped to lines that predate the pick', () => {
  /** Models the DB: the only NULL-picked line was created AFTER picking completed,
   *  so a query scoped with `.lte('created_at', picking_completed_at)` counts 0. */
  function scopedCountStub(pickingCompletedAt: string | null) {
    const holder: { stub: ReturnType<typeof makeSupabaseStub> | null } = { stub: null };
    holder.stub = makeSupabaseStub({
      'order_requests.select.maybeSingle': {
        data: {
          warehouse_id: 'wh-1',
          status: 'packing_slip_generated',
          fulfillment_type: 'pickup',
          picking_completed_at: pickingCompletedAt,
        },
        error: null,
      },
      'order_request_lines.select': () => {
        const s = holder.stub!;
        const methods = s.chains.get('order_request_lines.select') ?? [];
        const args = s.chainArgs.get('order_request_lines.select') ?? [];
        const scoped = methods.some((m, i) => m === 'lte' && args[i]?.[0] === 'created_at');
        return { data: null, error: null, count: scoped ? 0 : 1 };
      },
      'order_requests.update.maybeSingle': {
        data: { id: 'ord-1', status: 'staged_for_pickup', order_number: 21 },
        error: null,
      },
    });
    return holder.stub;
  }

  it('stages an order whose only NULL-picked line was added after picking completed', async () => {
    const stub = scopedCountStub('2026-09-01T10:00:00.000Z');
    const row = await svc(stub).stageOrder('ord-1', 'staged_for_pickup');
    expect((row as { status: string }).status).toBe('staged_for_pickup');
    expect(argsFor(stub, 'order_request_lines.select', 'lte')).toContainEqual([
      'created_at',
      '2026-09-01T10:00:00.000Z',
    ]);
  });

  it('still refuses when a line that predates the pick was never resolved', async () => {
    const stub = makeSupabaseStub({
      'order_requests.select.maybeSingle': {
        data: {
          warehouse_id: 'wh-1',
          status: 'packing_slip_generated',
          fulfillment_type: 'pickup',
          picking_completed_at: '2026-09-01T10:00:00.000Z',
        },
        error: null,
      },
      'order_request_lines.select': { data: null, error: null, count: 1 },
    });
    await expect(svc(stub).stageOrder('ord-1', 'staged_for_pickup')).rejects.toMatchObject({
      code: 'validation_error',
    });
  });

  it('keeps the unscoped pre-0121 guard when picking_completed_at is null', async () => {
    const stub = scopedCountStub(null);
    await expect(svc(stub).stageOrder('ord-1', 'staged_for_pickup')).rejects.toMatchObject({
      code: 'validation_error',
    });
    expect(argsFor(stub, 'order_request_lines.select', 'lte')).toHaveLength(0);
  });
});
