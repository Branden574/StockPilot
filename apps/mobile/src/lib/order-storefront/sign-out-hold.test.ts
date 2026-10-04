import { describe, expect, it } from 'vitest';

import type { PendingOrderSubmission } from '@stockpilot/core';

import { accountScopedStorageKeys } from '../account-eviction';
import {
  ORDER_HOLD_PREFIX,
  holdCheckFrom,
  holdFor,
  mergeHolds,
  orderHoldKey,
  parseHolds,
  serializeHolds,
} from './sign-out-hold';

const ORG = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const WH = '33333333-3333-4333-8333-333333333333';
const ITEM = '44444444-4444-4444-8444-444444444444';
const KEY = '55555555-5555-4555-8555-555555555555';

const PENDING: PendingOrderSubmission = {
  key: KEY,
  state: 'possibly_sent',
  sends: 2,
  firstSentAt: '2026-10-04T12:00:00.000Z',
  body: {
    idempotencyKey: KEY,
    placerUserId: USER,
    warehouseId: WH,
    fulfillmentType: 'delivery',
    deliveryCharterId: '66666666-6666-4666-8666-666666666666',
    onBehalfOf: { name: 'Maria Lopez', email: 'maria@example.org' },
    notes: 'Room 12, call Sam',
    neededByLocal: '2026-10-05T10:00',
    lines: [
      { itemId: ITEM, quantity: 3 },
      { itemId: '44444444-4444-4444-8444-444444444445', quantity: 2 },
    ],
  },
};

describe('the hold marker (plan 3.6)', () => {
  it('holds ids, a time and two counts only: no name, email, note or item id', () => {
    const hold = holdFor({ orgId: ORG, warehouseId: WH, pending: PENDING });
    expect(hold).toEqual({ orgId: ORG, warehouseId: WH, key: KEY, sentAt: '2026-10-04T12:00:00.000Z', lineCount: 2, unitCount: 5 });
    const raw = serializeHolds([hold])!;
    for (const secret of ['Maria', 'maria@example.org', 'Room 12', ITEM, 'call Sam', '66666666']) {
      expect(raw).not.toContain(secret);
    }
  });

  it('lives OUTSIDE the account-scoped prefix, so a sign-out keeps it', () => {
    expect(orderHoldKey(USER)).toBe(`${ORDER_HOLD_PREFIX}${USER}`);
    expect(accountScopedStorageKeys([orderHoldKey(USER)])).toEqual([]);
  });

  it('round-trips, drops anything that is not exactly a marker, and never keeps an extra field', () => {
    const hold = holdFor({ orgId: ORG, warehouseId: WH, pending: PENDING });
    expect(parseHolds(serializeHolds([hold]))).toEqual([hold]);
    const smuggled = JSON.stringify({ v: 1, holds: [{ ...hold, notes: 'secret' }, { key: 'nope' }, 'x'] });
    expect(parseHolds(smuggled)).toEqual([hold]);
    expect(parseHolds('garbage')).toEqual([]);
    expect(parseHolds(null)).toEqual([]);
    expect(serializeHolds([])).toBeNull();
  });

  it('one marker per organization and key', () => {
    const hold = holdFor({ orgId: ORG, warehouseId: WH, pending: PENDING });
    expect(mergeHolds([hold], [hold])).toEqual([hold]);
  });
});

describe('checking a held key at the next sign-in (a read, never a send)', () => {
  const order = {
    id: 'o1',
    orderNumber: 123,
    orderLabel: 'SO-000123',
    status: 'pending_approval',
    warehouseId: WH,
    fulfillmentType: 'pickup',
    deliveryCharterId: null,
    neededBy: null,
    lineCount: 1,
    unitCount: 1,
    createdAt: 'x',
    requestedFor: { self: true },
  };

  it('placed names its order', () => {
    expect(holdCheckFrom({ ok: true, status: 200, body: { organizationId: ORG, outcome: 'placed', order } }, ORG)).toEqual({
      outcome: 'placed',
      label: 'SO-000123',
    });
  });

  it('refused or withdrawn clears it', () => {
    expect(holdCheckFrom({ ok: true, status: 200, body: { organizationId: ORG, outcome: 'withdrawn' } }, ORG)).toEqual({ outcome: 'settled' });
    expect(
      holdCheckFrom({ ok: true, status: 200, body: { organizationId: ORG, outcome: 'refused', refusal: { reason: 'permission', detail: null } } }, ORG),
    ).toEqual({ outcome: 'settled' });
  });

  it('none, no answer, a refused read, or another organization’s answer keeps it', () => {
    expect(holdCheckFrom({ ok: true, status: 200, body: { organizationId: ORG, outcome: 'none' } }, ORG)).toEqual({ outcome: 'unknown' });
    expect(holdCheckFrom({ ok: false, error: new Error('offline') }, ORG)).toEqual({ outcome: 'unknown' });
    expect(holdCheckFrom({ ok: false, error: { status: 401, code: 'unauthenticated', details: {} } }, ORG)).toEqual({ outcome: 'unknown' });
    expect(
      holdCheckFrom({ ok: true, status: 200, body: { organizationId: '99999999-9999-4999-8999-999999999999', outcome: 'placed', order } }, ORG),
    ).toEqual({ outcome: 'unknown' });
  });
});
