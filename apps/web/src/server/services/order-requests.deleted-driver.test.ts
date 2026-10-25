import { describe, expect, it, vi } from 'vitest';

/**
 * B23: an in-transit delivery whose driver deleted their account. 0393 clears
 * the driver (assigned_delivery_user_id) and marks nothing on the order, so
 * the list reads when the order went out (in_transit_at) and core's
 * deliveryDriverLabel says "Deleted user" from the two together. Before this
 * fix the list never read in_transit_at, so such an order showed a blank
 * Driver ("—"), as if nobody had ever been put on it.
 */

vi.mock('@/lib/auth/warehouse', () => ({ assertWarehouseAccess: vi.fn() }));
vi.mock('./audit', () => ({ audit: vi.fn(async () => {}) }));
const adminHandle = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => adminHandle.client }));

import { DELETED_USER_LABEL, deliveryDriverLabel, type ModuleId } from '@stockpilot/core';

import {
  callArgs,
  makeServiceContext,
  makeSupabaseStub,
  type MockCall,
} from '@/test/supabase-mock';

import { OrderRequestsService } from './order-requests';

function svc(stub: ReturnType<typeof makeSupabaseStub>) {
  adminHandle.client = stub.client;
  return new (OrderRequestsService as unknown as new (ctx: unknown) => OrderRequestsService)(
    makeServiceContext(stub.client, {
      role: 'admin',
      userId: 'approver-1',
      enabledModules: new Set<ModuleId>(['orders']),
    }),
  );
}

const WENT_OUT = '2026-10-20T15:04:05.000Z';

function order(over: Record<string, unknown>) {
  return {
    id: 'o-1',
    order_number: 7,
    status: 'in_transit',
    warehouse_id: 'wh-1',
    fulfillment_type: 'delivery',
    assigned_picker_id: null,
    assigned_delivery_user_id: null,
    in_transit_at: null,
    lines: [],
    ...over,
  };
}

describe('OrderRequestsService.list: the driver of an in-transit delivery', () => {
  it('reads in_transit_at with the order', async () => {
    let read: MockCall | null = null;
    const stub = makeSupabaseStub({
      'order_requests.select': (call) => {
        read = call;
        return { data: [], error: null };
      },
    });
    await svc(stub).list();
    expect(read).not.toBeNull();
    expect(String(callArgs(read!, 'select')?.[0] ?? '')).toMatch(/\bin_transit_at\b/);
  });

  it('carries when the order went out, so a driver who deleted their account reads "Deleted user"', async () => {
    const stub = makeSupabaseStub({
      'order_requests.select': {
        data: [order({ id: 'gone', in_transit_at: WENT_OUT, assigned_delivery_user_id: null })],
        error: null,
      },
    });
    const [row] = await svc(stub).list();
    expect(row?.inTransitAt).toBe(WENT_OUT);
    expect(row?.assignedDeliveryUserId).toBeNull();
    expect(
      deliveryDriverLabel({
        fulfillmentType: row!.fulfillmentType,
        inTransitAt: row!.inTransitAt,
        assignedDeliveryUserId: row!.assignedDeliveryUserId,
        driverName: row!.assignedDeliveryUserName,
      }),
    ).toBe(DELETED_USER_LABEL);
  });

  it('keeps a named driver, and an unassigned delivery that never went out stays unassigned', async () => {
    const stub = makeSupabaseStub({
      'order_requests.select': {
        data: [
          order({ id: 'named', in_transit_at: WENT_OUT, assigned_delivery_user_id: 'driver-1' }),
          order({ id: 'staged', status: 'staged_for_delivery' }),
        ],
        error: null,
      },
      'user_profiles.select': {
        data: [{ id: 'driver-1', full_name: 'Test Driver', email: 'driver@example.com' }],
        error: null,
      },
    });
    const rows = await svc(stub).list();
    const labels = rows.map((r) =>
      deliveryDriverLabel({
        fulfillmentType: r.fulfillmentType,
        inTransitAt: r.inTransitAt,
        assignedDeliveryUserId: r.assignedDeliveryUserId,
        driverName: r.assignedDeliveryUserName,
      }),
    );
    expect(labels).toEqual(['Test Driver', null]);
    expect(rows[1]?.inTransitAt).toBeNull();
  });
});
