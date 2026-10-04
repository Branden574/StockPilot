import { describe, expect, it } from 'vitest';

import {
  ORDER_REPLAY_COPY,
  prepareDeliveryRequest,
  type OrderCreateRequestInput,
  type OrderSummary,
  type StorefrontItem,
} from '@stockpilot/core';

import type { PlacedContext } from './session';
import {
  orderStatusLabel,
  placedOnStorefrontFocus,
  successEmailInput,
  successOrderHref,
  successReference,
  successSentences,
} from './success';

const WH = '33333333-3333-4333-8333-333333333333';
const ITEM = '44444444-4444-4444-8444-444444444444';
const SITE = '66666666-6666-4666-8666-666666666666';
const ORDER = '77777777-7777-4777-8777-777777777777';

const ORDER_SUMMARY: OrderSummary = {
  id: ORDER,
  orderNumber: 123,
  orderLabel: 'SO-000123',
  status: 'pending_approval',
  warehouseId: WH,
  fulfillmentType: 'pickup',
  deliveryCharterId: null,
  neededBy: '2026-10-05T17:00:00.000Z',
  lineCount: 1,
  unitCount: 12,
  createdAt: '2026-10-04T12:00:00.000Z',
  requestedFor: { self: true },
};

const BODY: OrderCreateRequestInput = {
  idempotencyKey: '55555555-5555-4555-8555-555555555555',
  placerUserId: '22222222-2222-4222-8222-222222222222',
  warehouseId: WH,
  fulfillmentType: 'pickup',
  deliveryCharterId: null,
  onBehalfOf: null,
  notes: 'Room 12',
  neededByLocal: '2026-10-05T10:00',
  lines: [{ itemId: ITEM, quantity: 12 }],
};

const placed = (patch: Partial<PlacedContext> = {}): PlacedContext => ({
  order: ORDER_SUMMARY,
  replay: false,
  viaWithdraw: false,
  body: BODY,
  shown: false,
  ...patch,
});

const ITEMS = new Map<string, StorefrontItem>([
  [
    ITEM,
    {
      id: ITEM,
      sku: 'PL-1',
      name: 'Planner',
      quantityOnHand: 20,
      reservedQuantity: 0,
      categoryId: null,
      categoryName: null,
      charterId: null,
      charterName: null,
      charterCode: null,
      rackLabel: null,
      reorderPoint: 0,
    },
  ],
]);
const ROUTING = { to: 'intake@example.org', cc: 'copy@example.org', toName: null, ccName: null };

describe('what the success screen says', () => {
  it('the reference line, the status in core’s words, and who hears about it', () => {
    expect(successReference(placed(), 'DC4')).toBe('SO-000123 · DC4 · 12 units');
    // A warehouse no longer listed (or the turned-off path): its empty name
    // is left out, never "SO-000123 ·  · 12 units" (desk check F6.4).
    expect(successReference(placed(), '')).toBe('SO-000123 · 12 units');
    expect(orderStatusLabel('pending_approval')).toBe('Pending');
    expect(orderStatusLabel('staged_for_delivery')).toBe('Ready');
    expect(orderStatusLabel('mystery_state')).toBe('mystery state');
    expect(successSentences(placed())).toEqual(["Sent for approval. You'll be notified in the app when it's approved."]);
  });

  it('on behalf: the emails go to the person it is for', () => {
    const p = placed({ order: { ...ORDER_SUMMARY, requestedFor: { self: false, name: 'Maria Lopez', email: 'maria@x.org' } } });
    expect(successSentences(p)).toEqual(['Sent for approval. Emails about it go to Maria Lopez at maria@x.org.']);
  });

  it('a replay says it was already placed; "Don’t send it" finding it placed says so', () => {
    expect(successSentences(placed({ replay: true }))[0]).toBe(ORDER_REPLAY_COPY);
    expect(successSentences(placed({ replay: true, viaWithdraw: true }))[0]).toBe('It had already been placed: SO-000123.');
  });

  it('Review and approve for an approver opens the order at its actions; View order otherwise', () => {
    expect(successOrderHref(ORDER, true)).toBe(`/order/${ORDER}?focus=approve`);
    expect(successOrderHref(ORDER, false)).toBe(`/order/${ORDER}`);
  });
});

describe('the pickup or delivery request email (offered to every placer when routing resolves)', () => {
  const base = {
    recipients: ROUTING,
    warehouseName: 'DC4',
    sites: [{ id: SITE, name: 'North', code: 'N', address: { line1: '1 Main' } }],
    viewer: { name: 'Pat Placer', email: 'pat@x.org' },
    orgTimezone: 'America/Los_Angeles',
    itemMap: ITEMS,
  };

  it('a pickup: the real method, the stored needed-by INSTANT, no destination, the viewer as requester', () => {
    const input = successEmailInput({ ...base, placed: placed() })!;
    expect(input.fulfillmentType).toBe('pickup');
    expect(input.destination).toBeNull();
    expect(input.neededByLocal).toBe('2026-10-05T17:00:00.000Z');
    expect(input.requestedFor).toBe('Pat Placer');
    expect(input.requesterEmail).toBe('pat@x.org');
    expect(input.lines).toEqual([{ itemId: ITEM, quantity: 12 }]);
    const prepared = prepareDeliveryRequest(input);
    expect(prepared.draft.to).toBe('intake@example.org');
    expect(prepared.draft.cc).toBe('copy@example.org');
    expect(prepared.draft.subject).toMatch(/^Pickup Request/);
    expect(prepared.draft.body).toMatch(/SO-000123/);
    expect(prepared.draft.body).toMatch(/Planner/);
  });

  it('a delivery for someone else: the site placed for, and the person it is for', () => {
    const order = { ...ORDER_SUMMARY, fulfillmentType: 'delivery' as const, deliveryCharterId: SITE, requestedFor: { self: false as const, name: 'Maria', email: 'maria@x.org' } };
    const input = successEmailInput({
      ...base,
      placed: placed({ order, body: { ...BODY, fulfillmentType: 'delivery', deliveryCharterId: SITE, onBehalfOf: { name: 'Maria', email: 'maria@x.org' } } }),
    })!;
    expect(input.destination).toMatchObject({ id: SITE, name: 'North' });
    expect(input.requestedFor).toBe('Maria');
    expect(input.requesterEmail).toBe('maria@x.org');
  });

  it('no routing, routing core refuses, or a body this build cannot read: no email', () => {
    expect(successEmailInput({ ...base, placed: placed(), recipients: null })).toBeNull();
    expect(successEmailInput({ ...base, placed: placed(), recipients: { ...ROUTING, to: 'not an address' } })).toBeNull();
    expect(successEmailInput({ ...base, placed: placed({ body: null }) })).toBeNull();
  });
});

describe('a placed order on a storefront that comes into focus (desk check F10)', () => {
  it('one not shown yet (a status read or Don’t send it found it placed) opens the success screen', () => {
    expect(placedOnStorefrontFocus(placed())).toBe('show');
  });
  it('one already shown is done with: cleared, never shown again (the person left by View order and on)', () => {
    expect(placedOnStorefrontFocus(placed({ shown: true }))).toBe('finish');
  });
  it('none: nothing', () => {
    expect(placedOnStorefrontFocus(null)).toBeNull();
  });
});
