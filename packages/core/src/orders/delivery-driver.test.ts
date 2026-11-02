import { describe, expect, it } from 'vitest';

import { DELETED_USER_LABEL } from '../people/deleted-user';
import {
  deletedDriverHandOverLine,
  deliveryDriverLabel,
  isDeliveryDriverDeleted,
} from './delivery-driver';

/**
 * B23: an in-transit delivery whose driver deleted their account. 0393 nulls
 * the driver (the release for open orders, the foreign key for the rest) and
 * marks nothing on order_requests, so the order's own facts say it: only a
 * delivery has a driver, nothing goes in transit without one, and
 * in_transit_at is never cleared.
 */
const WENT_OUT = '2026-10-20T15:04:05.000Z';

describe('isDeliveryDriverDeleted', () => {
  it('is true for a delivery that went in transit and names no driver', () => {
    expect(
      isDeliveryDriverDeleted({
        fulfillmentType: 'delivery',
        inTransitAt: WENT_OUT,
        assignedDeliveryUserId: null,
      }),
    ).toBe(true);
    expect(
      isDeliveryDriverDeleted({
        fulfillmentType: 'delivery',
        inTransitAt: WENT_OUT,
        assignedDeliveryUserId: undefined,
      }),
    ).toBe(true);
    expect(
      isDeliveryDriverDeleted({
        fulfillmentType: 'delivery',
        inTransitAt: WENT_OUT,
        assignedDeliveryUserId: '',
      }),
    ).toBe(true);
  });

  it('is false while the order still names its driver', () => {
    expect(
      isDeliveryDriverDeleted({
        fulfillmentType: 'delivery',
        inTransitAt: WENT_OUT,
        assignedDeliveryUserId: 'driver-1',
      }),
    ).toBe(false);
  });

  it('is false for a delivery that never went in transit (nobody was required yet)', () => {
    expect(
      isDeliveryDriverDeleted({
        fulfillmentType: 'delivery',
        inTransitAt: null,
        assignedDeliveryUserId: null,
      }),
    ).toBe(false);
    expect(
      isDeliveryDriverDeleted({
        fulfillmentType: 'delivery',
        inTransitAt: undefined,
        assignedDeliveryUserId: null,
      }),
    ).toBe(false);
    expect(
      isDeliveryDriverDeleted({
        fulfillmentType: 'delivery',
        inTransitAt: '',
        assignedDeliveryUserId: null,
      }),
    ).toBe(false);
  });

  it('is false for a pickup, which never has a driver', () => {
    expect(
      isDeliveryDriverDeleted({
        fulfillmentType: 'pickup',
        inTransitAt: WENT_OUT,
        assignedDeliveryUserId: null,
      }),
    ).toBe(false);
    expect(
      isDeliveryDriverDeleted({
        fulfillmentType: null,
        inTransitAt: WENT_OUT,
        assignedDeliveryUserId: null,
      }),
    ).toBe(false);
  });
});

describe('deliveryDriverLabel', () => {
  it('names the driver when the order still has one', () => {
    expect(
      deliveryDriverLabel({
        fulfillmentType: 'delivery',
        inTransitAt: WENT_OUT,
        assignedDeliveryUserId: 'driver-1',
        driverName: 'Test Driver',
      }),
    ).toBe('Test Driver');
  });

  it('says "Deleted user" for a driver who deleted their account', () => {
    expect(
      deliveryDriverLabel({
        fulfillmentType: 'delivery',
        inTransitAt: WENT_OUT,
        assignedDeliveryUserId: null,
        driverName: null,
      }),
    ).toBe(DELETED_USER_LABEL);
  });

  it('says nothing for a pickup, an unassigned delivery, or a driver the reader cannot see', () => {
    expect(
      deliveryDriverLabel({
        fulfillmentType: 'pickup',
        inTransitAt: null,
        assignedDeliveryUserId: null,
        driverName: null,
      }),
    ).toBeNull();
    expect(
      deliveryDriverLabel({
        fulfillmentType: 'delivery',
        inTransitAt: null,
        assignedDeliveryUserId: null,
        driverName: null,
      }),
    ).toBeNull();
    expect(
      deliveryDriverLabel({
        fulfillmentType: 'delivery',
        inTransitAt: WENT_OUT,
        assignedDeliveryUserId: 'driver-1',
        driverName: null,
      }),
    ).toBeNull();
  });

  it('trims the resolved name, and an empty one is no name', () => {
    expect(
      deliveryDriverLabel({
        fulfillmentType: 'delivery',
        inTransitAt: WENT_OUT,
        assignedDeliveryUserId: 'driver-1',
        driverName: '  Test Driver ',
      }),
    ).toBe('Test Driver');
    expect(
      deliveryDriverLabel({
        fulfillmentType: 'delivery',
        inTransitAt: null,
        assignedDeliveryUserId: 'driver-1',
        driverName: '   ',
      }),
    ).toBeNull();
  });

  it('never names a pickup driver, even if a name was resolved', () => {
    expect(
      deliveryDriverLabel({
        fulfillmentType: 'pickup',
        inTransitAt: null,
        assignedDeliveryUserId: 'driver-1',
        driverName: 'Test Driver',
      }),
    ).toBeNull();
  });
});

describe('deletedDriverHandOverLine', () => {
  it('names both hand-over buttons for a viewer who is offered the paper signature', () => {
    expect(deletedDriverHandOverLine({ offersPhysicalSignature: true })).toBe(
      'The driver of this delivery deleted their account. Record the hand-over here with Collect signature or Physical signature.',
    );
  });

  it('names only Collect signature for an approver below manager rank', () => {
    expect(deletedDriverHandOverLine({ offersPhysicalSignature: false })).toBe(
      'The driver of this delivery deleted their account. Record the hand-over here with Collect signature.',
    );
  });
});
