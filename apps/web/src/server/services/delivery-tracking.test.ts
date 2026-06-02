import { describe, expect, it } from 'vitest';
import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';
import { DEFAULT_MODULE_IDS, type ModuleId } from '@stockpilot/core';
import { DeliveryTrackingService } from './delivery-tracking';

const withLT = () => new Set<ModuleId>([...DEFAULT_MODULE_IDS, 'live_tracking']);

describe('DeliveryTrackingService.shareLocation gating', () => {
  it('throws module_disabled when live_tracking is off', async () => {
    const stub = makeSupabaseStub({});
    const svc = new DeliveryTrackingService(makeServiceContext(stub.client)); // no live_tracking
    await expect(
      svc.shareLocation('order-1', { lat: 1, lng: 2 }),
    ).rejects.toMatchObject({ code: 'module_disabled' });
  });

  it('forbids a non-assigned user', async () => {
    const stub = makeSupabaseStub({
      'order_requests.select': {
        data: { id: 'order-1', fulfillment_type: 'delivery', status: 'in_transit', assigned_delivery_user_id: 'someone-else' },
        error: null,
      },
    });
    const svc = new DeliveryTrackingService(
      makeServiceContext(stub.client, { enabledModules: withLT(), userId: 'driver-1' }),
    );
    await expect(svc.shareLocation('order-1', { lat: 1, lng: 2 })).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('rejects when the order is not in_transit', async () => {
    const stub = makeSupabaseStub({
      'order_requests.select': {
        data: { id: 'order-1', fulfillment_type: 'delivery', status: 'approved', assigned_delivery_user_id: 'driver-1' },
        error: null,
      },
    });
    const svc = new DeliveryTrackingService(
      makeServiceContext(stub.client, { enabledModules: withLT(), userId: 'driver-1' }),
    );
    await expect(svc.shareLocation('order-1', { lat: 1, lng: 2 })).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('upserts a location for the assigned driver of an in_transit delivery', async () => {
    const stub = makeSupabaseStub({
      'order_requests.select': {
        data: { id: 'order-1', organization_id: 'org-test', fulfillment_type: 'delivery', status: 'in_transit', assigned_delivery_user_id: 'driver-1' },
        error: null,
      },
      'delivery_locations.upsert': { data: null, error: null },
    });
    const svc = new DeliveryTrackingService(
      makeServiceContext(stub.client, { enabledModules: withLT(), userId: 'driver-1' }),
    );
    await svc.shareLocation('order-1', { lat: 36.7, lng: -119.7, heading: 90, accuracy: 5 });
    expect(stub.fromCalls).toContain('delivery_locations');
  });
});
