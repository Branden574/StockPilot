/**
 * deliveryRequestInputFromSubmission: the success screen's pickup or delivery
 * request, built from the placed order and the submission (phone ordering
 * PO-1). The byte-for-byte check against the REAL web success overlay is in
 * apps/web/src/components/orders/storefront/delivery-request-submission.parity.test.tsx;
 * this file pins the rules.
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  deliveryRequestRecipients,
  prepareDeliveryRequest,
  type DeliveryRequestInput,
} from './delivery-request';
import {
  deliveryRequestInputFromSubmission,
  type DeliveryRequestSubmissionSetup,
} from './delivery-request-input';
import type { OrderSummary } from './place-order';
import { formatOrgDateTime, ORG_TIMEZONE_DEFAULT } from '../time/org-timezone';
import { wallClockToInstant } from '../time/zoned-wall-clock';

const RECIPIENTS = deliveryRequestRecipients({
  to: 'warehouse@example.org',
  cc: 'ops@example.org',
  toName: 'Warehouse',
  ccName: 'Operations',
});

const SITE = {
  id: 'c0c0c0c0-0000-4000-8000-000000000001',
  name: 'CVW Clovis',
  code: 'CVW-CLO',
  address: { line1: '1295 Shaw Ave', city: 'Fresno', region: 'California', postalCode: '93612' },
};

function summary(patch: Partial<OrderSummary> = {}): OrderSummary {
  return {
    id: 'b3f1c2d4-1111-4222-8333-444455556666',
    orderNumber: 49,
    orderLabel: 'SO-000049',
    status: 'pending_approval',
    warehouseId: 'a0a0a0a0-0000-4000-8000-000000000001',
    fulfillmentType: 'delivery',
    deliveryCharterId: SITE.id,
    neededBy: '2026-10-05T17:00:00.000Z',
    lineCount: 2,
    unitCount: 7,
    createdAt: '2026-10-03T16:00:00.000Z',
    requestedFor: { self: true },
    ...patch,
  };
}

function setup(
  patch: Partial<DeliveryRequestSubmissionSetup> = {},
): DeliveryRequestSubmissionSetup {
  return {
    warehouseName: 'DC4',
    destination: SITE,
    viewerLabel: 'Branden Vincent-Walker',
    viewerEmail: 'branden@example.org',
    orgTimezone: 'America/Los_Angeles',
    notes: 'Please stage these by Friday.',
    lines: [
      { itemId: 'i-1', quantity: 5 },
      { itemId: 'i-2', quantity: 2 },
    ],
    itemMap: new Map([
      ['i-1', { name: "L4L Polo (Women's)", sku: 'APP-POLO-W' }],
      ['i-2', { name: 'Planner', sku: 'PLN-001' }],
    ]),
    ...patch,
  };
}

const ORIGINAL_TZ = process.env.TZ;
afterEach(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

describe('deliveryRequestInputFromSubmission', () => {
  it('maps the placed order and the setup field by field', () => {
    const input = deliveryRequestInputFromSubmission(summary(), setup(), RECIPIENTS);
    expect(input).toEqual({
      recipients: RECIPIENTS,
      orderId: 'b3f1c2d4-1111-4222-8333-444455556666',
      orderNumber: 49,
      fulfillmentType: 'delivery',
      warehouseName: 'DC4',
      destination: SITE,
      requestedFor: 'Branden Vincent-Walker',
      requesterEmail: 'branden@example.org',
      neededByLocal: '2026-10-05T17:00:00.000Z',
      orgTimezone: 'America/Los_Angeles',
      notes: 'Please stage these by Friday.',
      lines: setup().lines,
      itemMap: expect.any(Map),
    } satisfies Record<keyof DeliveryRequestInput, unknown>);
  });

  it('an order on behalf of someone names them and their email, from the placed order', () => {
    const input = deliveryRequestInputFromSubmission(
      summary({ requestedFor: { self: false, name: 'Maria Lopez', email: 'maria@example.org' } }),
      setup(),
      RECIPIENTS,
    );
    expect(input.requestedFor).toBe('Maria Lopez');
    expect(input.requesterEmail).toBe('maria@example.org');
  });

  it('pickup: the real method, no destination, and the pickup words', () => {
    const input = deliveryRequestInputFromSubmission(
      summary({ fulfillmentType: 'pickup', deliveryCharterId: null }),
      setup(),
      RECIPIENTS,
    );
    expect(input.fulfillmentType).toBe('pickup');
    expect(input.destination).toBeNull();
    const draft = prepareDeliveryRequest(input).draft;
    expect(draft.subject.toLowerCase()).toContain('pickup');
    expect(draft.body).not.toContain('CVW Clovis');
    expect(draft.body).not.toContain('1295 Shaw Ave');
  });

  it('names no site that is not the one the order was placed for', () => {
    const other = deliveryRequestInputFromSubmission(
      summary({ deliveryCharterId: 'c0c0c0c0-0000-4000-8000-000000000002' }),
      setup(),
      RECIPIENTS,
    );
    expect(other.destination).toBeNull();
    expect(
      deliveryRequestInputFromSubmission(summary(), setup({ destination: null }), RECIPIENTS)
        .destination,
    ).toBeNull();
  });

  it("uses the stored INSTANT, so the mailed time is the organization's, whatever the device's zone", () => {
    // 10:00 in New York on 5 October 2026 is 14:00 UTC.
    const at = wallClockToInstant('2026-10-05T10:00', 'America/New_York');
    expect(at).not.toBeNull();
    const neededBy = new Date(at!).toISOString();
    const s = summary({ neededBy });
    const draftIn = (tz: string) => {
      process.env.TZ = tz;
      return prepareDeliveryRequest(
        deliveryRequestInputFromSubmission(
          s,
          setup({ orgTimezone: 'America/New_York' }),
          RECIPIENTS,
        ),
      ).draft.body;
    };
    const tokyo = draftIn('Asia/Tokyo');
    const pacific = draftIn('America/Los_Angeles');
    const utc = draftIn('UTC');
    expect(tokyo).toBe(pacific);
    expect(utc).toBe(pacific);
    expect(pacific).toContain(
      formatOrgDateTime(
        new Date(neededBy),
        { dateStyle: 'medium', timeStyle: 'short' },
        'America/New_York',
      ),
    );
    expect(pacific).toMatch(/10:00\s?AM/);
  });

  it('the wall clock it replaces would have been read in the device zone', () => {
    // What the old path did with the cart's zone-less value: a phone in Tokyo
    // and one in California mail different times for the same order.
    const wall = (tz: string) => {
      process.env.TZ = tz;
      return prepareDeliveryRequest({
        ...deliveryRequestInputFromSubmission(
          summary(),
          setup({ orgTimezone: 'America/New_York' }),
          RECIPIENTS,
        ),
        neededByLocal: '2026-10-05T10:00',
      }).draft.body;
    };
    expect(wall('Asia/Tokyo')).not.toBe(wall('America/Los_Angeles'));
  });

  it("no needed-by is an empty value, as the cart's empty field is", () => {
    expect(
      deliveryRequestInputFromSubmission(summary({ neededBy: null }), setup(), RECIPIENTS)
        .neededByLocal,
    ).toBe('');
  });

  it("the raw time zone is resolved here: absent or unknown is the default, a stored 'UTC' stays", () => {
    expect(
      deliveryRequestInputFromSubmission(summary(), setup({ orgTimezone: null }), RECIPIENTS)
        .orgTimezone,
    ).toBe(ORG_TIMEZONE_DEFAULT);
    expect(
      deliveryRequestInputFromSubmission(summary(), setup({ orgTimezone: 'Mars/Base' }), RECIPIENTS)
        .orgTimezone,
    ).toBe(ORG_TIMEZONE_DEFAULT);
    expect(
      deliveryRequestInputFromSubmission(summary(), setup({ orgTimezone: 'UTC' }), RECIPIENTS)
        .orgTimezone,
    ).toBe('UTC');
  });

  it("the same message the web overlay builds, when the browser's zone is the organization's", () => {
    // The overlay passes the cart's wall clock, which the builder reads in the
    // browser's zone. The server stores that wall clock converted in the
    // organization's zone. With the two zones equal (L4L today), both drafts
    // are the same bytes.
    const zone = 'America/Los_Angeles';
    process.env.TZ = zone;
    const wall = '2026-10-05T10:00';
    const neededBy = new Date(wallClockToInstant(wall, zone)!).toISOString();
    const s = summary({ neededBy });
    const sub = deliveryRequestInputFromSubmission(s, setup({ orgTimezone: zone }), RECIPIENTS);
    const overlay: DeliveryRequestInput = { ...sub, neededByLocal: wall };
    const a = prepareDeliveryRequest(overlay);
    const b = prepareDeliveryRequest(sub);
    expect(b.draft.subject).toBe(a.draft.subject);
    expect(b.draft.body).toBe(a.draft.body);
    expect(b.outlookUrl).toBe(a.outlookUrl);
    expect(b.mailtoUrl).toBe(a.mailtoUrl);
    expect(b).toEqual(a);
  });
});
