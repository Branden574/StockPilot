import { describe, expect, it } from 'vitest';

import {
  ORDER_DEVICE_SAVE_FAILED_COPY,
  ORDER_WITHDRAWN_COPY,
  STOREFRONT_SHIP_FROM_LOCKED_COPY,
  orderRefusalCopy,
  readOrderRefusalDetails,
  type OrderSubmissionState,
} from '@stockpilot/core';

import { storefrontOutcome } from './outcome';
import type { SubmitEngineSnapshot } from './submit';

const A = '44444444-4444-4444-8444-444444444444';
const ctx = { itemName: (id: string) => (id === A ? 'Planner' : null), warehouseName: 'DC4' };
const sub = (state: OrderSubmissionState, deviceError: string | null = null): SubmitEngineSnapshot => ({
  state,
  busy: false,
  deviceError,
  sent: false,
});

describe('the outcome sentence every storefront screen shows (desk check F3)', () => {
  it('a final refusal in core’s words, naming the cart’s items', () => {
    const details = readOrderRefusalDetails({ reason: 'item_not_orderable', items: { [A]: 'archived' } });
    const state: OrderSubmissionState = { phase: 'refused', reason: 'item_not_orderable', recorded: true, details };
    const out = storefrontOutcome({ submission: sub(state), refusal: null }, ctx);
    expect(out).toEqual({
      text: orderRefusalCopy('item_not_orderable', details, { surface: 'phone', ...ctx }),
      tone: 'critical',
    });
    expect(out?.text).toContain('Planner');
  });

  it('withdrawn: "It was not sent. Your cart is unlocked." (calm)', () => {
    expect(storefrontOutcome({ submission: sub({ phase: 'withdrawn' }), refusal: null }, ctx)).toEqual({
      text: ORDER_WITHDRAWN_COPY,
      tone: 'calm',
    });
  });

  it('a device that could not save, then a change the session refused', () => {
    expect(storefrontOutcome({ submission: sub({ phase: 'open' }, ORDER_DEVICE_SAVE_FAILED_COPY), refusal: null }, ctx)?.text).toBe(
      ORDER_DEVICE_SAVE_FAILED_COPY,
    );
    expect(storefrontOutcome({ submission: sub({ phase: 'open' }), refusal: STOREFRONT_SHIP_FROM_LOCKED_COPY }, ctx)).toEqual({
      text: STOREFRONT_SHIP_FROM_LOCKED_COPY,
      tone: 'critical',
    });
  });

  it('nothing to say: open, or placed (the success screen says it)', () => {
    expect(storefrontOutcome({ submission: sub({ phase: 'open' }), refusal: null }, ctx)).toBeNull();
    expect(
      storefrontOutcome(
        {
          submission: sub({
            phase: 'placed',
            replay: false,
            viaWithdraw: false,
            order: { id: A, orderNumber: 1, orderLabel: 'SO-000001', status: 'pending_approval', warehouseId: A, fulfillmentType: 'pickup', deliveryCharterId: null, neededBy: null, lineCount: 1, unitCount: 1, createdAt: '2026-10-04T12:00:00.000Z', requestedFor: { self: true } },
          }),
          refusal: null,
        },
        ctx,
      ),
    ).toBeNull();
  });
});
