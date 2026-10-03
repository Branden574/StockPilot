/**
 * The phone's success-screen email and the web's are the same message
 * (phone ordering PO-1, plan 3.7).
 *
 * The web success overlay (ReviewModal, success stage) hands
 * DeliveryRequestAction an input built from the cart: the setup, the lines,
 * the notes and the cart's needed-by WALL CLOCK. The phone will build its
 * input with core's deliveryRequestInputFromSubmission from the placed order
 * (the stored needed-by INSTANT) and the submission. This test renders the
 * REAL overlay, captures the input it passes, and checks it against core's
 * for the same submission: field by field (the needed-by naming the same
 * instant), and as the prepared draft, byte for byte.
 *
 * The needed-by agrees when the browser's zone is the organization's (L4L
 * today). The test runs in whatever zone the machine has, so it takes that
 * zone as the organization's and converts the wall clock in it, as the
 * server will.
 */
import { render } from '@testing-library/react';
import type * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  brandDeliveryRecipients,
  deliveryRequestInputFromSubmission,
  prepareDeliveryRequest as corePrepare,
  wallClockToInstant,
  type DeliveryRequestInput as CoreDeliveryRequestInput,
  type OrderSummary,
} from '@stockpilot/core';

import type { CartLineState, CatalogItem, StorefrontCharter } from '../v2/types';

import type { DeliveryRequestInput } from './storefront-logic';

const captured: Array<{ input: DeliveryRequestInput; recipients: unknown }> = [];

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('./storefront-cards', () => ({
  SfPhoto: () => <div data-testid="sf-photo" />,
  CharterTag: () => <div data-testid="sf-charter-tag" />,
  SfAddControl: () => <div data-testid="sf-add-control" />,
}));
// The overlay's real props reach this stand-in unchanged.
vi.mock('./delivery-request-action', () => ({
  default: (props: { input: DeliveryRequestInput; recipients: unknown }) => {
    captured.push(props);
    return null;
  },
}));

import { ReviewModal } from './storefront-overlays';

const ROUTING = {
  to: 'warehouse@example.org',
  cc: 'ops@example.org',
  toName: 'Warehouse',
  ccName: 'Operations',
};

function item(id: string, name: string, sku: string): CatalogItem {
  return {
    id,
    sku,
    name,
    warehouseId: 'a0a0a0a0-0000-4000-8000-000000000001',
    quantityOnHand: 100,
    reservedQuantity: 0,
    itemType: null,
    categoryId: null,
    categoryName: null,
    charterId: null,
    charterName: null,
    charterCode: null,
    rackLabel: '16-B',
    imageUrl: null,
    lqip: null,
    price: 12.5,
    reorderPoint: 0,
  };
}

const POLO = item('0a0a0a0a-0000-4000-8000-00000000000a', "L4L Polo (Women's)", 'APP-POLO-W');
const PLANNER = item('0b0b0b0b-0000-4000-8000-00000000000b', 'L4L Weekly Planner', 'PLN-001');
const SITE: StorefrontCharter = {
  id: 'c0c0c0c0-0000-4000-8000-000000000001',
  name: 'CVW Clovis',
  code: 'CVW-CLO',
  address: { line1: '1295 Shaw Ave', city: 'Fresno', region: 'California', postalCode: '93612' },
};
const ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

interface Submission {
  method: 'pickup' | 'delivery';
  onBehalfOf: { name: string; email: string } | null;
  neededBy: string;
  notes: string;
  lines: CartLineState[];
}

/** The overlay as orders-storefront.tsx renders it for this submission, and
 *  the order the server would answer with. */
function renderBoth(sub: Submission) {
  captured.length = 0;
  const itemMap = new Map([
    [POLO.id, POLO],
    [PLANNER.id, PLANNER],
  ]);
  const viewerLabel = 'Branden Vincent-Walker';
  const viewerEmail = 'branden@example.org';
  const destination = sub.method === 'delivery' ? SITE : null;
  const order = { id: 'b3f1c2d4-1111-4222-8333-444455556666', orderNumber: 49 };
  const unitCount = sub.lines.reduce((s, l) => s + l.quantity, 0);
  const props: React.ComponentProps<typeof ReviewModal> = {
    stage: 'success',
    lines: sub.lines,
    itemMap,
    notes: sub.notes,
    summary: {
      warehouseName: 'DC4',
      method: sub.method,
      deliverTo: sub.method === 'pickup' ? 'DC4 will-call desk' : SITE.name,
      requestedFor: sub.onBehalfOf?.name ?? viewerLabel,
      requesterEmail: sub.onBehalfOf?.email ?? viewerEmail,
      orgTimezone: ZONE,
    },
    neededBy: sub.neededBy,
    destination,
    deliveryRecipients: ROUTING,
    submitting: false,
    submitted: { id: order.id, orderNumber: order.orderNumber, unitCount },
    onClose: vi.fn(),
    onConfirm: vi.fn(),
    onViewOrder: vi.fn(),
    onDone: vi.fn(),
  };
  render(<ReviewModal {...props} />);
  expect(captured).toHaveLength(1);
  const web = captured[0]!;

  const at = sub.neededBy ? wallClockToInstant(sub.neededBy, ZONE) : null;
  const summary: OrderSummary = {
    id: order.id,
    orderNumber: order.orderNumber,
    orderLabel: 'SO-000049',
    status: 'pending_approval',
    warehouseId: POLO.warehouseId,
    fulfillmentType: sub.method,
    deliveryCharterId: destination?.id ?? null,
    neededBy: at === null ? null : new Date(at).toISOString(),
    lineCount: sub.lines.length,
    unitCount,
    createdAt: '2026-10-03T16:00:00.000Z',
    requestedFor: sub.onBehalfOf ? { self: false, ...sub.onBehalfOf } : { self: true },
  };
  const recipients = brandDeliveryRecipients(ROUTING);
  const phone = deliveryRequestInputFromSubmission(
    summary,
    {
      warehouseName: 'DC4',
      destination: SITE,
      viewerLabel,
      viewerEmail,
      orgTimezone: ZONE,
      notes: sub.notes,
      lines: sub.lines,
      itemMap: new Map([...itemMap].map(([id, it]) => [id, { name: it.name, sku: it.sku }])),
    },
    recipients,
  );
  return { web, phone, recipients };
}

function expectSameMessage(
  web: { input: DeliveryRequestInput; recipients: unknown },
  phone: CoreDeliveryRequestInput,
) {
  const recipients = brandDeliveryRecipients(web.recipients as typeof ROUTING);
  // Field by field. The overlay's itemMap holds the whole catalog row; the
  // message reads only name and sku, so those are what is compared.
  const { neededByLocal: webNeeded, itemMap: webItems, ...webRest } = web.input;
  const {
    neededByLocal: phoneNeeded,
    itemMap: phoneItems,
    recipients: phoneRecipients,
    ...phoneRest
  } = phone;
  expect(phoneRest).toEqual(webRest);
  expect(phoneRecipients).toEqual(recipients);
  for (const [id, it] of webItems)
    expect(phoneItems.get(id)).toEqual({ name: it.name, sku: it.sku });
  // The same instant: the overlay's wall clock read as the browser reads it.
  expect(phoneNeeded === '' ? '' : new Date(phoneNeeded).getTime()).toBe(
    webNeeded === '' ? '' : new Date(webNeeded).getTime(),
  );
  // And the same email, byte for byte.
  const a = corePrepare({ ...web.input, recipients });
  const b = corePrepare(phone);
  expect(b.draft.subject).toBe(a.draft.subject);
  expect(b.draft.body).toBe(a.draft.body);
  expect(b).toEqual(a);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the success email: core deliveryRequestInputFromSubmission matches the web overlay', () => {
  it('a delivery for oneself, with a needed-by and notes', () => {
    const { web, phone } = renderBoth({
      method: 'delivery',
      onBehalfOf: null,
      neededBy: '2026-10-05T10:00',
      notes: 'Please stage these by Friday.',
      lines: [
        { itemId: POLO.id, quantity: 5 },
        { itemId: PLANNER.id, quantity: 2 },
      ],
    });
    expectSameMessage(web, phone);
    expect(phone.fulfillmentType).toBe('delivery');
    expect(phone.destination).toEqual(SITE);
  });

  it('a pickup on behalf of someone, with no needed-by', () => {
    const { web, phone } = renderBoth({
      method: 'pickup',
      onBehalfOf: { name: 'Maria Lopez', email: 'maria@example.org' },
      neededBy: '',
      notes: '',
      lines: [{ itemId: POLO.id, quantity: 1 }],
    });
    expectSameMessage(web, phone);
    expect(phone.fulfillmentType).toBe('pickup');
    expect(phone.destination).toBeNull();
    expect(phone.requestedFor).toBe('Maria Lopez');
  });

  it('a late-evening needed-by keeps its day', () => {
    const { web, phone } = renderBoth({
      method: 'delivery',
      onBehalfOf: { name: 'Maria Lopez', email: 'maria@example.org' },
      neededBy: '2026-12-31T23:30',
      notes: 'Last day of the year.',
      lines: [{ itemId: PLANNER.id, quantity: 12 }],
    });
    expectSameMessage(web, phone);
  });
});
