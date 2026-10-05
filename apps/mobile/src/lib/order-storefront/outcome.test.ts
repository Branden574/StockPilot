import { describe, expect, it } from 'vitest';

import {
  ORDER_DEVICE_SAVE_FAILED_COPY,
  ORDER_WITHDRAWN_COPY,
  STOREFRONT_OFFLINE_NOT_LOADED_COPY,
  STOREFRONT_SHIP_FROM_LOCKED_COPY,
  orderRefusalCopy,
  readOrderRefusalDetails,
  type OrderSubmissionState,
} from '@stockpilot/core';

import { outcomeBesideSetup, storefrontOutcome, storefrontStateMessage } from './outcome';
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

// Simulator re-verify D10 (PO-4 review round): a Submit refused for permission
// is followed by the answer read again, refused for the same reason, and the
// turned-off/refused state then showed "Your account can't place orders. Ask
// an admin." twice, one under the other (and VoiceOver said it twice).
describe('the outcome beside the setup message says a sentence once (simulator walk D10)', () => {
  const said = "Your account can't place orders. Ask an admin.";
  const refusedSetup = { status: 'refused' as const, message: said };

  it('the same words as the setup message: shown once, as the setup message', () => {
    expect(outcomeBesideSetup({ text: said, tone: 'critical' }, refusedSetup)).toBeNull();
  });

  it('different words, a loading answer or no outcome: unchanged', () => {
    const other = { text: 'It was not sent. Your cart is unlocked.', tone: 'calm' as const };
    expect(outcomeBesideSetup(other, refusedSetup)).toBe(other);
    expect(outcomeBesideSetup({ text: said, tone: 'critical' }, { status: 'loading' })).toEqual({ text: said, tone: 'critical' });
    expect(outcomeBesideSetup(null, refusedSetup)).toBeNull();
    expect(outcomeBesideSetup(other, { status: 'off', message: 'Placing orders from the app is turned off right now. Use the web.' })).toBe(other);
  });
});

// Simulator walk D12 (M13): the storefront opened with no connection said
// "Ordering couldn't be loaded. Pull down to try again.", but offline it
// loads on its own once the connection returns (runtime's focus on the way
// back online).
describe('the turned-off, refused or failed state says why in the words for the case (simulator walk D12)', () => {
  const failed = { status: 'failed' as const, message: "Ordering couldn't be loaded. Pull down to try again." };
  it('a read that failed while offline: the offline words', () => {
    expect(storefrontStateMessage(failed, true)).toBe(STOREFRONT_OFFLINE_NOT_LOADED_COPY);
  });
  it('online, or an answer that came back (turned off, refused): its own words', () => {
    expect(storefrontStateMessage(failed, false)).toBe(failed.message);
    expect(storefrontStateMessage({ status: 'refused', message: 'R' }, true)).toBe('R');
    expect(storefrontStateMessage({ status: 'off', message: 'O' }, true)).toBe('O');
  });
});
