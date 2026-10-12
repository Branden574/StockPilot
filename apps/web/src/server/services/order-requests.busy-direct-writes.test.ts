import { describe, expect, it, vi } from 'vitest';

import type { ModuleId } from '@stockpilot/core';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

import { OrderRequestsService } from './order-requests';

vi.mock('@/lib/auth/warehouse', () => ({ assertWarehouseAccess: vi.fn() }));
vi.mock('./audit', () => ({ audit: vi.fn(async () => {}) }));
vi.mock('./integration-events', () => ({ dispatchEvent: vi.fn(async () => {}) }));
vi.mock('@/lib/email/order-requests', () => ({ sendOrderRequestEmail: vi.fn(async () => {}) }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => adminHandle.client }));
const adminHandle: { client: unknown } = { client: null };

/**
 * Returns RX-3 fix round 1 (desk check F2). The order actions that write with
 * ONE statement and nothing written before it in the same call (stage, deny,
 * internal notes, a line's quantity, removing a line) answered a lock wait,
 * a timeout or a deadlock as a general internal error, while What's New says
 * every order action now answers Busy. Try again. Each of these rolled back
 * whole, so the same request is safe to send again: busy is true for them.
 * (Add items is different: its earlier top-ups are committed, see
 * order-requests.add-lines.test.ts.)
 */
function svc(stub: ReturnType<typeof makeSupabaseStub>) {
  adminHandle.client = stub.client;
  return new (OrderRequestsService as unknown as new (ctx: unknown) => OrderRequestsService)(
    makeServiceContext(stub.client, {
      role: 'manager',
      userId: 'mgr-1',
      enabledModules: new Set<ModuleId>(['orders']),
    }),
  );
}

const BUSY = [
  ['55P03', 'canceling statement due to lock timeout'],
  ['57014', 'canceling statement due to statement timeout'],
  ['40P01', 'deadlock detected'],
] as const;

const BUSY_REFUSAL = {
  code: 'conflict',
  message: 'Busy. Try again.',
  details: { reason: 'busy', retryable: true },
};

const OPEN_HEADER = {
  id: 'order-1',
  status: 'approved',
  warehouse_id: 'wh-1',
  requester_user_id: 'requester-1',
  pick_slip_generated_at: null,
  order_number: 12,
};

const CLEAN_LINE = {
  id: 'line-1',
  item_id: 'item-1',
  quantity_requested: 10,
  quantity_fulfilled: 0,
  quantity_picked: null,
  returned_quantity: 0,
};

describe('single-statement order writes answer a lock wait, timeout or deadlock as busy', () => {
  it.each(BUSY)('deny (%s)', async (code, message) => {
    const stub = makeSupabaseStub({
      'order_requests.select.maybeSingle': { data: { warehouse_id: 'wh-1' }, error: null },
      'order_requests.update.maybeSingle': { data: null, error: { code, message } },
    });
    await expect(svc(stub).deny('order-1', 'No budget')).rejects.toMatchObject(BUSY_REFUSAL);
  });

  it.each(BUSY)('internal notes (%s)', async (code, message) => {
    const stub = makeSupabaseStub({
      'order_requests.select.maybeSingle': { data: { warehouse_id: 'wh-1' }, error: null },
      'order_requests.update.maybeSingle': { data: null, error: { code, message } },
    });
    await expect(svc(stub).setInternalNotes('order-1', 'Gate code 4411')).rejects.toMatchObject(BUSY_REFUSAL);
  });

  it.each(BUSY)('stage (%s)', async (code, message) => {
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
      'order_requests.update.maybeSingle': { data: null, error: { code, message } },
    });
    await expect(svc(stub).stageOrder('order-1', 'staged_for_delivery')).rejects.toMatchObject(BUSY_REFUSAL);
  });

  it.each(BUSY)("a line's quantity (%s)", async (code, message) => {
    const stub = makeSupabaseStub({
      'order_requests.select': { data: OPEN_HEADER, error: null },
      'order_request_lines.select.maybeSingle': { data: CLEAN_LINE, error: null },
      'order_request_lines.update': { data: null, error: { code, message } },
    });
    await expect(svc(stub).updateLineQuantity('order-1', 'line-1', 4)).rejects.toMatchObject(BUSY_REFUSAL);
  });

  it.each(BUSY)('removing a line (%s)', async (code, message) => {
    const stub = makeSupabaseStub({
      'order_requests.select': { data: OPEN_HEADER, error: null },
      'order_request_lines.select.maybeSingle': { data: CLEAN_LINE, error: null },
      'order_request_lines.select': {
        data: [
          { id: 'line-1', item_id: 'item-1', quantity_requested: 10, quantity_fulfilled: 0 },
          { id: 'line-2', item_id: 'item-2', quantity_requested: 5, quantity_fulfilled: 0 },
        ],
        error: null,
      },
      'order_request_lines.delete': { data: null, error: { code, message } },
    });
    await expect(svc(stub).removeLine('order-1', 'line-1')).rejects.toMatchObject(BUSY_REFUSAL);
  });

  it('any other failure on these writes stays internal_error', async () => {
    const stub = makeSupabaseStub({
      'order_requests.select.maybeSingle': { data: { warehouse_id: 'wh-1' }, error: null },
      'order_requests.update.maybeSingle': { data: null, error: { code: 'XX000', message: 'relation secret' } },
    });
    await expect(svc(stub).deny('order-1', 'No budget')).rejects.toMatchObject({ code: 'internal_error' });
    await expect(svc(stub).setInternalNotes('order-1', null)).rejects.toMatchObject({ code: 'internal_error' });
  });
});
