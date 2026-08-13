/**
 * Tests for what the CORE MOVE actually changed.
 *
 * The builder's message content is pinned exhaustively by the four web suites
 * (150 + 51 + 23 + 10), which run against the web re-export shim and passed
 * unedited through this move — plus a byte-for-byte golden diff over an
 * 11-line order, every rung of the ladder, both transports and the clipboard
 * text. Repeating that here would add tautologies, not coverage.
 *
 * What is genuinely NEW is the recipient boundary: the builder no longer reads
 * a constant, it takes `recipients` as input, and it validates them. That is
 * the seam a per-org configuration will eventually feed, and it is the seam
 * through which the mandatory CC could be lost. These tests exist for that.
 */
import { describe, expect, it } from 'vitest';

import {
  DELIVERY_REQUEST_EMAIL,
  DELIVERY_REQUEST_EMAIL_NAMES,
} from './delivery-request-recipients';
import {
  buildDeliveryRequestClipboardText,
  buildDeliveryRequestDraft,
  buildDeliveryRequestMailtoUrl,
  buildDeliveryRequestOutlookUrl,
  prepareDeliveryRequest,
  type DeliveryRequestInput,
  type DeliveryRequestRecipients,
} from './delivery-request';

const L4L: DeliveryRequestRecipients = {
  to: DELIVERY_REQUEST_EMAIL.to,
  cc: DELIVERY_REQUEST_EMAIL.cc,
  toName: DELIVERY_REQUEST_EMAIL_NAMES.to,
  ccName: DELIVERY_REQUEST_EMAIL_NAMES.cc,
};

function makeInput(overrides: Partial<DeliveryRequestInput> = {}): DeliveryRequestInput {
  return {
    recipients: L4L,
    orderId: 'b3f1c2d4-1111-2222-3333-444455556666',
    orderNumber: 49,
    fulfillmentType: 'delivery',
    warehouseName: 'DC4',
    destination: { id: 'ch-1', name: 'CVW Clovis', code: 'CVW-CLO', address: null },
    requestedFor: 'Marissa Delgado',
    requesterEmail: 'mdelgado@learn4life.org',
    neededByLocal: '2026-08-18T09:00',
    orgTimezone: 'America/Los_Angeles',
    notes: 'Please stage these by Friday.',
    lines: [{ itemId: 'i-1', quantity: 5 }],
    itemMap: new Map([['i-1', { name: 'L4L Water Bottle', sku: 'GEN-BOTL' }]]),
    ...overrides,
  };
}

describe('recipients are INPUT, not a constant the builder reaches for', () => {
  it('a second org gets ITS OWN addresses — the L4L mailbox appears nowhere', () => {
    /*
     * THE TENANCY TEST. Before the move the builder read
     * DELIVERY_REQUEST_EMAIL directly, so every org's delivery request would
     * have gone to Learn4Life's intake. A builder that still did that would
     * fail here on all four assertions, not just one.
     */
    const draft = buildDeliveryRequestDraft(
      makeInput({
        recipients: { to: 'intake@othercorp.test', cc: 'ops@othercorp.test' },
        // Neutral requester too: the L4L address must be absent because
        // nothing ROUTES there, not merely because no field mentions it. A
        // requester email is legitimate body content and would mask the point.
        requesterEmail: 'someone@othercorp.test',
      }),
    );

    expect(draft.to).toBe('intake@othercorp.test');
    expect(draft.cc).toBe('ops@othercorp.test');

    const url = buildDeliveryRequestOutlookUrl(draft);
    expect(url).toContain(encodeURIComponent(encodeURIComponent('ops@othercorp.test')));
    expect(url).not.toContain('learn4life');
    expect(url).not.toContain('cvwest');
    // The clipboard instructions are what an employee follows by hand when
    // both links fail — they must name the same two mailboxes.
    expect(buildDeliveryRequestClipboardText(draft)).toContain('TO: intake@othercorp.test');
    expect(buildDeliveryRequestClipboardText(draft)).toContain('CC: ops@othercorp.test');
  });

  it('carries the CC into every transport, not just the Outlook one', () => {
    // The CC is the acceptance gate. A transport that quietly drops it is the
    // failure this whole feature exists to prevent, so each is asserted
    // separately rather than trusting one to stand for the others.
    const draft = buildDeliveryRequestDraft(makeInput());

    expect(buildDeliveryRequestOutlookUrl(draft)).toContain(
      encodeURIComponent(encodeURIComponent(DELIVERY_REQUEST_EMAIL.cc)),
    );
    expect(buildDeliveryRequestMailtoUrl(draft)).toContain(
      `cc=${encodeURIComponent(DELIVERY_REQUEST_EMAIL.cc)}`,
    );
    expect(buildDeliveryRequestClipboardText(draft)).toContain(`CC: ${DELIVERY_REQUEST_EMAIL.cc}`);
  });

  it('puts the display-name chips on the OWA url ONLY', () => {
    // The name-addr in path position is a tenant-verified OWA parser
    // extension. mailto: and the clipboard are different, unverified parsers
    // and stay bare-address; guessing wrong there costs a silent CC drop.
    const draft = buildDeliveryRequestDraft(makeInput());

    expect(buildDeliveryRequestOutlookUrl(draft)).toContain(
      encodeURIComponent(encodeURIComponent('Fresno Warehouse DC4')),
    );
    expect(buildDeliveryRequestMailtoUrl(draft)).not.toContain('Fresno');
    expect(buildDeliveryRequestMailtoUrl(draft)).not.toContain('Andrew');
    expect(buildDeliveryRequestClipboardText(draft)).not.toContain('Fresno');
    expect(buildDeliveryRequestClipboardText(draft)).not.toContain('Andrew');
  });

  it('a draft built with no display names still routes to both addresses', () => {
    // Chips are cosmetic; routing is not. Omitting them must cost the chip and
    // nothing else.
    const draft = buildDeliveryRequestDraft(
      makeInput({ recipients: { to: DELIVERY_REQUEST_EMAIL.to, cc: DELIVERY_REQUEST_EMAIL.cc } }),
    );
    const url = buildDeliveryRequestOutlookUrl(draft);

    expect(url).not.toContain(encodeURIComponent(encodeURIComponent('Fresno Warehouse DC4')));
    expect(url).toContain(encodeURIComponent(encodeURIComponent(DELIVERY_REQUEST_EMAIL.to)));
    expect(url).toContain(encodeURIComponent(encodeURIComponent(DELIVERY_REQUEST_EMAIL.cc)));
  });
});

describe('the builder REFUSES a recipient it cannot route', () => {
  /*
   * Every value below is one that would fail SILENTLY if it were allowed
   * through: a comma or semicolon splits one recipient into two and the second
   * half — the mandatory CC — vanishes; a name-addr in the address position
   * confuses a parser into dropping the rest; an empty string composes mail to
   * nowhere. A throw at draft time is the last moment the failure is visible,
   * because nothing downstream can tell a delivered message from a misrouted
   * one.
   *
   * With today's compile-time literals none of these can occur. They are the
   * guard for the per-org configuration that `delivery-request-recipients.ts`
   * records as deferred.
   */
  const BAD = [
    ['empty', ''],
    ['whitespace only', '   '],
    ['a comma-joined second address', 'arosas@cvwest.org,evil@attacker.test'],
    ['a semicolon-joined second address', 'arosas@cvwest.org;evil@attacker.test'],
    ['a space-joined second address', 'arosas@cvwest.org evil@attacker.test'],
    ['a name-addr', 'Andrew Rosas <arosas@cvwest.org>'],
    ['no domain dot', 'arosas@localhost'],
    ['no at sign', 'arosas.cvwest.org'],
    ['two at signs', 'a@b@cvwest.org'],
    ['a newline', 'arosas@cvwest.org\nBcc: evil@attacker.test'],
  ] as const;

  for (const [label, value] of BAD) {
    it(`throws when the CC is ${label}`, () => {
      expect(() =>
        buildDeliveryRequestDraft(
          makeInput({ recipients: { to: DELIVERY_REQUEST_EMAIL.to, cc: value } }),
        ),
      ).toThrow(/recipient "cc" must be exactly one plain email address/);
    });

    it(`throws when the TO is ${label}`, () => {
      expect(() =>
        buildDeliveryRequestDraft(
          makeInput({ recipients: { to: value, cc: DELIVERY_REQUEST_EMAIL.cc } }),
        ),
      ).toThrow(/recipient "to" must be exactly one plain email address/);
    });
  }

  it('refuses through prepareDeliveryRequest too — not just the raw builder', () => {
    // prepareDeliveryRequest is what both surfaces actually call. A guard that
    // only covered the lower-level entry point would be a guard nobody passes
    // through.
    expect(() =>
      prepareDeliveryRequest(
        makeInput({
          recipients: { to: DELIVERY_REQUEST_EMAIL.to, cc: 'arosas@cvwest.org,evil@attacker.test' },
        }),
      ),
    ).toThrow(/recipient "cc" must be exactly one plain email address/);
  });

  it('accepts the real production pair', () => {
    // The negative cases above are worthless without this: a guard that
    // rejected everything would satisfy all of them.
    expect(() => buildDeliveryRequestDraft(makeInput())).not.toThrow();
    const draft = buildDeliveryRequestDraft(makeInput());
    expect(draft.to).toBe('dc4@learn4life.org');
    expect(draft.cc).toBe('arosas@cvwest.org');
  });
});
