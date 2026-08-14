import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as Linking from 'expo-linking';

import { DELIVERY_REQUEST_EMAIL, condensedNoticeText } from '@stockpilot/core';

import {
  BLOCKED_HEADLINE,
  BLOCKED_RETRY_MESSAGE,
  COPY_HELPER_TEXT,
  DELIVERY_REQUEST_BLOCKED_STATUSES,
  DUPLICATE_WARNING,
  HONESTY_NOTICE,
  MAIL_APP_SUCCESS_MESSAGE,
  OVERSIZED_MESSAGE,
  SUCCESS_MESSAGE,
  buildDeliveryRequestInput,
  canRequestDelivery,
  deliverySuccessMessageFor,
  needsDeliveryRequestData,
  openDeliveryRequestDraft,
  parseCharterAddress,
  prepareOrderDeliveryRequest,
  shouldShowCondensedNotice,
  type DeliveryRequestOrderData,
} from './delivery-request-actions';

// Same mock, same reasoning, as maintenance-email-actions.test.ts: expo-linking
// is a real installed dependency (~7.1.7); vi.mock is hoisted above the imports
// regardless of textual position, and is written here to keep import/first
// lint-clean.
vi.mock('expo-linking', () => ({
  openURL: vi.fn(async () => undefined),
  canOpenURL: vi.fn(async () => true),
}));

beforeEach(() => vi.clearAllMocks());

// ── Fixtures ─────────────────────────────────────────────────────────────
// Shaped exactly like what app/order/[id].tsx holds after load(): nullable
// columns straight off `order_requests`, the joined profile email kept
// separate from the denormalized one, and lines carrying a nullable itemId.

const SITE = {
  id: 'ch-1',
  name: 'CVW Clovis',
  code: 'CVW-CLO',
  address: {
    line1: '1234 Herndon Ave',
    city: 'Clovis',
    region: 'CA',
    postalCode: '93611',
    country: 'USA',
  },
};

function order(over: Partial<DeliveryRequestOrderData> = {}): DeliveryRequestOrderData {
  return {
    id: '9f8e7d6c-5b4a-4321-9876-543210fedcba',
    orderNumber: 80,
    warehouseName: 'Fresno DC4',
    requesterName: 'Jane Smith',
    requesterLabel: 'Jane Smith',
    requesterEmail: 'jane@cvwest.org',
    requesterProfileEmail: null,
    neededBy: '2026-08-20T17:00:00.000Z',
    notes: 'Please deliver to the back gate; the front is under construction.',
    destination: SITE,
    orgTimezone: 'America/Los_Angeles',
    lines: [
      { itemId: 'i1', name: 'Blue Composition Notebook', sku: 'NB-BLUE-01', requested: 24 },
      { itemId: 'i2', name: 'No. 2 Pencils, box of 12', sku: 'PN-2-012', requested: 10 },
    ],
    ...over,
  };
}

/** An order big enough that the full body cannot fit a compose link, so
 *  `prepareDeliveryRequest` walks its ladder and returns a CONDENSED draft. */
function bigOrder(): DeliveryRequestOrderData {
  return order({
    lines: Array.from({ length: 11 }, (_, i) => ({
      itemId: `item-${i}`,
      name: `Classroom Supply Kit ${i + 1} — Grade ${i + 1} Standard Issue`,
      sku: `KIT-GRADE-${String(i + 1).padStart(3, '0')}`,
      requested: (i + 1) * 3,
    })),
  });
}

/** Pathological unbounded strings that condensing cannot shorten — the only
 *  way `linkFits` goes false (see prepareDeliveryRequest). */
function oversizedOrder(): DeliveryRequestOrderData {
  return order({ warehouseName: 'W'.repeat(2400), lines: bigOrder().lines });
}

// ── The CC decoder ───────────────────────────────────────────────────────

/** Decodes an opaque-scheme deep link (ms-outlook:, mailto:) or the https OWA
 *  `mailtouri=` wrapper down to one query parameter. */
function paramOf(url: string, key: string): string | undefined {
  const inner = url.includes('mailtouri=')
    ? decodeURIComponent(url.slice(url.indexOf('mailtouri=') + 'mailtouri='.length))
    : url;
  const q = inner.indexOf('?');
  if (q === -1) return undefined;
  for (const pair of inner.slice(q + 1).split('&')) {
    const eq = pair.indexOf('=');
    if (pair.slice(0, eq) === key) return decodeURIComponent(pair.slice(eq + 1));
  }
  return undefined;
}

const ccOf = (url: string) => paramOf(url, 'cc');
const toOf = (url: string) => paramOf(url, 'to');

// =========================================================================
// THE ACCEPTANCE GATE. The workflow depends on arosas@cvwest.org receiving a
// copy of every delivery request. "Outlook opened" is not success — a compose
// screen that opens with the CC missing is a WORSE failure than not opening
// at all, because nobody notices. Everything below asserts the cc that
// actually reaches the OS, not the one the composer intended.
// =========================================================================

describe('CC GATE: the mandatory CC survives every draft size and every transport', () => {
  it('FULL body: the native mobile URL cc equals the prepared draft cc', () => {
    const prepared = prepareOrderDeliveryRequest(order());
    expect(prepared.draft.condensed).toBe(false);
    expect(prepared.linkFits).toBe(true);
    expect(ccOf(prepared.outlookMobileUrl)).toBe(prepared.draft.cc);
    expect(ccOf(prepared.outlookMobileUrl)).toBe(DELIVERY_REQUEST_EMAIL.cc);
    expect(toOf(prepared.outlookMobileUrl)).toBe(DELIVERY_REQUEST_EMAIL.to);
  });

  it('CONDENSED body: the ladder shortens the item rows, and the cc is NOT one of the things dropped', () => {
    const prepared = prepareOrderDeliveryRequest(bigOrder());
    // Prove we are really exercising the condensed rung, not just a second
    // full draft — otherwise this test would pass with the ladder deleted.
    expect(prepared.draft.condensed).toBe(true);
    expect(prepared.draft.listedLineCount).toBeLessThan(prepared.draft.lineCount);
    expect(prepared.linkFits).toBe(true);
    expect(ccOf(prepared.outlookMobileUrl)).toBe(prepared.draft.cc);
    expect(ccOf(prepared.outlookMobileUrl)).toBe(DELIVERY_REQUEST_EMAIL.cc);
    expect(toOf(prepared.outlookMobileUrl)).toBe(DELIVERY_REQUEST_EMAIL.to);
  });

  it('OVERSIZED: even the draft that is too long to open still carries to and cc', () => {
    const prepared = prepareOrderDeliveryRequest(oversizedOrder());
    expect(prepared.linkFits).toBe(false);
    expect(ccOf(prepared.outlookMobileUrl)).toBe(DELIVERY_REQUEST_EMAIL.cc);
    expect(toOf(prepared.outlookMobileUrl)).toBe(DELIVERY_REQUEST_EMAIL.to);
  });

  it('a TRUNCATED url still retains to and cc: both precede the body in the query string', () => {
    // Both transports truncate SILENTLY past ~2,000 chars and DRAFT_URL_LIMIT
    // is only a conservative guess at where. This is the structural reason a
    // tail-truncated URL cannot lose the routing: to= and cc= are emitted
    // BEFORE subject= and body=, and the body is the only unbounded term.
    for (const o of [order(), bigOrder(), oversizedOrder()]) {
      const url = prepareOrderDeliveryRequest(o).outlookMobileUrl;
      expect(url.indexOf('to=')).toBeGreaterThan(-1);
      expect(url.indexOf('cc=')).toBeGreaterThan(url.indexOf('to='));
      expect(url.indexOf('body=')).toBeGreaterThan(url.indexOf('cc='));
      // The hard version of the same claim: chop the URL at the limit and the
      // routing is still intact.
      const chopped = url.slice(0, 1800);
      expect(ccOf(chopped)).toBe(DELIVERY_REQUEST_EMAIL.cc);
      expect(toOf(chopped)).toBe(DELIVERY_REQUEST_EMAIL.to);
    }
  });

  it('every transport the planner can choose carries the cc — native, web fallback, and mailto', () => {
    const prepared = prepareOrderDeliveryRequest(order());
    expect(ccOf(prepared.outlookMobileUrl)).toBe('arosas@cvwest.org');
    // The OWA web url carries it as the tenant-verified name-addr chip.
    expect(ccOf(prepared.outlookUrl)).toBe('Andrew Rosas <arosas@cvwest.org>');
    expect(ccOf(prepared.mailtoUrl)).toBe('arosas@cvwest.org');
    // And the clipboard escape hatch names it in plain text.
    expect(prepared.clipboardText).toContain('CC: arosas@cvwest.org');
  });
});

describe('CC GATE at the actual openURL call site (not merely in the composer)', () => {
  it('THE FIX: opens the NATIVE ms-outlook: deep link, never an https URL a browser would take', async () => {
    const prepared = prepareOrderDeliveryRequest(order());
    await expect(openDeliveryRequestDraft('outlook', prepared, 'ios', () => {})).resolves.toEqual({
      outcome: 'opened',
      used: 'outlook-native',
    });
    const url = vi.mocked(Linking.openURL).mock.calls[0]![0] as string;
    expect(url.startsWith('ms-outlook://compose?')).toBe(true);
    expect(url.startsWith('http')).toBe(false);
    expect(ccOf(url)).toBe('arosas@cvwest.org');
  });

  it('CONDENSED draft still opens the native link WITH the cc', async () => {
    const prepared = prepareOrderDeliveryRequest(bigOrder());
    await openDeliveryRequestDraft('outlook', prepared, 'android', () => {});
    const url = vi.mocked(Linking.openURL).mock.calls[0]![0] as string;
    expect(url.startsWith('ms-outlook://compose?')).toBe(true);
    expect(ccOf(url)).toBe('arosas@cvwest.org');
  });

  it('no native Outlook installed: falls back to the tenant-verified WEB url, cc intact', async () => {
    vi.mocked(Linking.canOpenURL).mockResolvedValueOnce(false);
    const prepared = prepareOrderDeliveryRequest(order());
    const res = await openDeliveryRequestDraft('outlook', prepared, 'ios', () => {});
    expect(res).toEqual({ outcome: 'opened', used: 'outlook-web' });
    const url = vi.mocked(Linking.openURL).mock.calls[0]![0] as string;
    expect(url.startsWith('https://outlook.cloud.microsoft/mail/deeplink/compose?mailtouri=')).toBe(
      true,
    );
    expect(ccOf(url)).toBe('Andrew Rosas <arosas@cvwest.org>');
  });

  it('a canOpenURL rejection is treated as "not installed", never a crash', async () => {
    vi.mocked(Linking.canOpenURL).mockRejectedValueOnce(new Error('scheme not declared'));
    const prepared = prepareOrderDeliveryRequest(order());
    await expect(openDeliveryRequestDraft('outlook', prepared, 'android', () => {})).resolves.toEqual(
      { outcome: 'opened', used: 'outlook-web' },
    );
    const url = vi.mocked(Linking.openURL).mock.calls[0]![0] as string;
    expect(url.startsWith('https://outlook.cloud.microsoft/')).toBe(true);
  });

  it('cc-untrusted platform reroutes to mailto rather than keeping the Outlook brand', async () => {
    const prepared = prepareOrderDeliveryRequest(order());
    const res = await openDeliveryRequestDraft('outlook', prepared, 'ios', () => {}, {
      ios: false,
      android: true,
    });
    expect(res).toEqual({ outcome: 'opened', used: 'default-mail' });
    const url = vi.mocked(Linking.openURL).mock.calls[0]![0] as string;
    expect(url.startsWith('mailto:dc4@learn4life.org?cc=arosas%40cvwest.org')).toBe(true);
  });

  it('exactly ONE openURL per tap — never auto-retried into a duplicate request to DC4', async () => {
    const prepared = prepareOrderDeliveryRequest(order());
    await openDeliveryRequestDraft('outlook', prepared, 'ios', () => {});
    expect(Linking.openURL).toHaveBeenCalledTimes(1);
  });

  it('an openURL rejection reports blocked and does NOT silently open something else', async () => {
    vi.mocked(Linking.openURL).mockRejectedValueOnce(new Error('no handler'));
    const prepared = prepareOrderDeliveryRequest(order());
    await expect(openDeliveryRequestDraft('outlook', prepared, 'ios', () => {})).resolves.toEqual({
      outcome: 'blocked',
      used: null,
    });
    expect(Linking.openURL).toHaveBeenCalledTimes(1);
  });

  it('linkFits=false opens NOTHING and never even probes for Outlook', async () => {
    const prepared = prepareOrderDeliveryRequest(oversizedOrder());
    await expect(openDeliveryRequestDraft('outlook', prepared, 'ios', () => {})).resolves.toEqual({
      outcome: 'blocked',
      used: null,
    });
    expect(Linking.openURL).not.toHaveBeenCalled();
    expect(Linking.canOpenURL).not.toHaveBeenCalled();
  });

  it('onOpened fires only after a REAL open, never on a blocked one', async () => {
    const prepared = prepareOrderDeliveryRequest(order());
    const onOpened = vi.fn();
    await openDeliveryRequestDraft('outlook', prepared, 'ios', onOpened);
    expect(onOpened).toHaveBeenCalledTimes(1);

    onOpened.mockClear();
    vi.mocked(Linking.openURL).mockRejectedValueOnce(new Error('no handler'));
    await openDeliveryRequestDraft('outlook', prepared, 'ios', onOpened);
    expect(onOpened).not.toHaveBeenCalled();

    onOpened.mockClear();
    await openDeliveryRequestDraft(
      'outlook',
      prepareOrderDeliveryRequest(oversizedOrder()),
      'ios',
      onOpened,
    );
    expect(onOpened).not.toHaveBeenCalled();
  });
});

// =========================================================================
// The gate — which orders offer the action, and to whom.
// =========================================================================

describe('canRequestDelivery', () => {
  const base = {
    status: 'approved',
    fulfillmentType: 'delivery',
    requesterUserId: 'u1',
    viewerUserId: 'u1',
    ordersModuleEnabled: true,
  };

  it('shows for the requester of a live delivery order', () => {
    expect(canRequestDelivery(base)).toBe(true);
  });

  it('hides from anyone who is not the requester — matching the web page exactly', () => {
    expect(canRequestDelivery({ ...base, viewerUserId: 'someone-else' })).toBe(false);
  });

  it('hides when the order has no recorded requester user (a null requester matches no viewer)', () => {
    expect(canRequestDelivery({ ...base, requesterUserId: null, viewerUserId: null })).toBe(false);
  });

  it('hides on pickup orders — there is no delivery to request', () => {
    expect(canRequestDelivery({ ...base, fulfillmentType: 'pickup' })).toBe(false);
  });

  it('hides on every terminal status', () => {
    for (const status of DELIVERY_REQUEST_BLOCKED_STATUSES) {
      expect(canRequestDelivery({ ...base, status })).toBe(false);
    }
    expect(DELIVERY_REQUEST_BLOCKED_STATUSES).toEqual(['completed', 'denied', 'cancelled']);
  });

  it('hides when the orders module is off', () => {
    expect(canRequestDelivery({ ...base, ordersModuleEnabled: false })).toBe(false);
  });
});

describe('needsDeliveryRequestData (the load-time fetch gate)', () => {
  // The screen spends two extra reads — the destination charter and the org
  // timezone — only when this says so. Those two fields exist ONLY for the
  // delivery request, so the gate that fetches them and the gate that shows the
  // button have to agree, and this is the direction that matters.
  const STATUSES = [
    'pending_approval',
    'approved',
    'backordered',
    'picking_in_progress',
    'picking_complete',
    'packing_slip_generated',
    'staged_for_delivery',
    'staged_for_pickup',
    'in_transit',
    'completed',
    'denied',
    'cancelled',
  ];

  it('THE INVARIANT: anything the button shows for, the fetch gate must also load for', () => {
    // Exhaustive over the whole gate input space. A fetch gate NARROWER than
    // the display gate is the silent failure: the button appears on an order
    // whose destination and timezone were never read, and DC4 gets a draft with
    // the delivery site missing. Nothing on screen would look wrong.
    let showed = 0;
    for (const status of [...STATUSES, null]) {
      for (const fulfillmentType of ['delivery', 'pickup', null]) {
        for (const requesterUserId of ['u1', null]) {
          for (const viewerUserId of ['u1', 'u2', null]) {
            for (const ordersModuleEnabled of [true, false]) {
              const gate = {
                status,
                fulfillmentType,
                requesterUserId,
                viewerUserId,
                ordersModuleEnabled,
              };
              if (canRequestDelivery(gate)) {
                showed += 1;
                expect(needsDeliveryRequestData(gate)).toBe(true);
              }
            }
          }
        }
      }
    }
    // The loop must actually reach the showing case, or it proves nothing.
    expect(showed).toBeGreaterThan(0);
  });

  it('is deliberately WIDER: it loads for a live delivery order the viewer did not request', () => {
    const row = { status: 'approved', fulfillmentType: 'delivery' };
    expect(needsDeliveryRequestData(row)).toBe(true);
    expect(
      canRequestDelivery({
        ...row,
        requesterUserId: 'u1',
        viewerUserId: 'someone-else',
        ordersModuleEnabled: true,
      }),
    ).toBe(false);
  });

  it('does not load on pickup orders, terminal orders, or a status-less row', () => {
    expect(needsDeliveryRequestData({ status: 'approved', fulfillmentType: 'pickup' })).toBe(false);
    for (const status of DELIVERY_REQUEST_BLOCKED_STATUSES) {
      expect(needsDeliveryRequestData({ status, fulfillmentType: 'delivery' })).toBe(false);
    }
    expect(needsDeliveryRequestData({ status: null, fulfillmentType: 'delivery' })).toBe(false);
  });
});

// =========================================================================
// The input mapping — what the phone hands the shared builder.
// =========================================================================

describe('buildDeliveryRequestInput', () => {
  it('recipients come from the ONE core constant, never from anything on the order', () => {
    const input = buildDeliveryRequestInput(order());
    expect(input.recipients.to).toBe('dc4@learn4life.org');
    expect(input.recipients.cc).toBe('arosas@cvwest.org');
  });

  it('always declares delivery, so a pickup order can never produce a destination-less delivery draft', () => {
    expect(buildDeliveryRequestInput(order()).fulfillmentType).toBe('delivery');
  });

  it('falls back to the JOINED profile email when the denormalized column is null (internal self-submits)', () => {
    // The real defect this guards: internal orders leave requester_email NULL,
    // and the profile email was already fetched but thrown away — so most
    // internal orders would have drafted with no contact for DC4 at all.
    const input = buildDeliveryRequestInput(
      order({ requesterEmail: null, requesterProfileEmail: 'jane@cvwest.org' }),
    );
    expect(input.requesterEmail).toBe('jane@cvwest.org');
  });

  it('prefers the denormalized on-behalf-of email over the profile email', () => {
    const input = buildDeliveryRequestInput(
      order({ requesterEmail: 'onbehalf@site.org', requesterProfileEmail: 'staff@cvwest.org' }),
    );
    expect(input.requesterEmail).toBe('onbehalf@site.org');
  });

  it('represents genuinely absent data as absent — never as an invented placeholder value', () => {
    const input = buildDeliveryRequestInput(
      order({
        warehouseName: null,
        requesterName: null,
        requesterLabel: null,
        requesterEmail: null,
        requesterProfileEmail: null,
        neededBy: null,
        notes: null,
        destination: null,
        orgTimezone: null,
      }),
    );
    expect(input.warehouseName).toBe('');
    expect(input.requestedFor).toBe('');
    expect(input.requesterEmail).toBeNull();
    expect(input.neededByLocal).toBe('');
    expect(input.notes).toBe('');
    expect(input.destination).toBeNull();
    // The org timezone is the ONE field with a real default rather than a
    // blank, because a time printed in no zone is worse than one printed in
    // the documented fallback.
    expect(input.orgTimezone).toBe('America/Los_Angeles');
  });

  it("the builder turns those blanks into its OWN honest admissions, not into fake data", () => {
    const body = prepareOrderDeliveryRequest(
      order({
        warehouseName: null,
        requesterName: null,
        requesterLabel: null,
        requesterEmail: null,
        requesterProfileEmail: null,
        destination: null,
      }),
    ).draft.body;
    expect(body).toContain('(warehouse not recorded)');
    expect(body).toContain('(requester not recorded)');
  });

  it('drops lines with no item id, exactly as the web page does', () => {
    const input = buildDeliveryRequestInput(
      order({
        lines: [
          { itemId: 'i1', name: 'Real', sku: 'R-1', requested: 2 },
          { itemId: null, name: 'Orphaned', sku: null, requested: 5 },
        ],
      }),
    );
    expect(input.lines).toHaveLength(1);
    expect(input.itemMap.size).toBe(1);
    expect(input.itemMap.get('i1')).toEqual({ name: 'Real', sku: 'R-1' });
  });

  it('a null sku becomes an empty string, never the text "null"', () => {
    const input = buildDeliveryRequestInput(
      order({ lines: [{ itemId: 'i1', name: 'No SKU item', sku: null, requested: 1 }] }),
    );
    expect(input.itemMap.get('i1')).toEqual({ name: 'No SKU item', sku: '' });
    expect(prepareOrderDeliveryRequest(order({ lines: [{ itemId: 'i1', name: 'No SKU item', sku: null, requested: 1 }] })).draft.body).not.toContain('null');
  });

  it('passes the needed-by instant through untouched for the builder to localise', () => {
    const input = buildDeliveryRequestInput(order({ neededBy: '2026-08-20T17:00:00.000Z' }));
    expect(input.neededByLocal).toBe('2026-08-20T17:00:00.000Z');
    // And it really is rendered in the org zone, with the zone named.
    expect(prepareOrderDeliveryRequest(order()).draft.body).toContain('America/Los_Angeles');
  });
});

describe('parseCharterAddress (charters.address is jsonb — anything can be in there)', () => {
  it('passes a plain object through', () => {
    expect(parseCharterAddress({ line1: '1 Main St', city: 'Clovis' })).toEqual({
      line1: '1 Main St',
      city: 'Clovis',
    });
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an array', [{ line1: 'x' }]],
    ['a string', '1 Main St'],
    ['a number', 42],
  ])('treats %s as no address rather than trusting it', (_label, raw) => {
    expect(parseCharterAddress(raw)).toBeNull();
  });
});

// =========================================================================
// Copy. Every user-visible string is a named export so the screen cannot
// invent its own wording, and so a mutation to any of them fails by name.
// =========================================================================

describe('copy', () => {
  it('never claims the message was sent, or that a ticket exists', () => {
    for (const s of [SUCCESS_MESSAGE, MAIL_APP_SUCCESS_MESSAGE, HONESTY_NOTICE]) {
      expect(s).not.toMatch(/\bsent\b/i);
      expect(s).not.toMatch(/\bticket\b/i);
    }
  });

  it('names Outlook only when Outlook actually opened', () => {
    expect(deliverySuccessMessageFor('outlook-native')).toBe(SUCCESS_MESSAGE);
    expect(deliverySuccessMessageFor('outlook-web')).toBe(SUCCESS_MESSAGE);
    expect(deliverySuccessMessageFor('default-mail')).toBe(MAIL_APP_SUCCESS_MESSAGE);
    expect(MAIL_APP_SUCCESS_MESSAGE).not.toMatch(/outlook/i);
  });

  it('the honesty notice tells the employee they must press Send themselves', () => {
    expect(HONESTY_NOTICE).toMatch(/press Send/i);
  });

  it('the oversized message points at the copy fallback, which always carries everything', () => {
    expect(OVERSIZED_MESSAGE).toMatch(/copy/i);
    expect(BLOCKED_HEADLINE).toBeTruthy();
    expect(BLOCKED_RETRY_MESSAGE).toMatch(/copy/i);
    expect(COPY_HELPER_TEXT).toMatch(/press and hold/i);
  });

  it('the duplicate warning names DC4, because a second draft is a second real request', () => {
    expect(DUPLICATE_WARNING).toMatch(/DC4/);
  });

  it('the condensed notice comes from the SHARED core builder, so both surfaces say the same thing', () => {
    const prepared = prepareOrderDeliveryRequest(bigOrder());
    expect(shouldShowCondensedNotice(prepared)).toBe(true);
    // Not a re-typed sentence: the exact string web renders for this draft.
    expect(condensedNoticeText(prepared.draft)).toContain(
      `lists the first ${prepared.draft.listedLineCount} of ${prepared.draft.lineCount} lines`,
    );
  });

  it('the condensed notice is NOT shown for a draft that fits whole, nor for an oversized one', () => {
    expect(shouldShowCondensedNotice(prepareOrderDeliveryRequest(order()))).toBe(false);
    // Oversized is the blocked state and OVERSIZED_MESSAGE owns that copy —
    // showing "this will open shortened" alongside "nothing can open" would
    // promise a link that is not offered.
    expect(shouldShowCondensedNotice(prepareOrderDeliveryRequest(oversizedOrder()))).toBe(false);
  });
});

// =========================================================================
// Parity with web: the phone must produce the SAME message, not a similar one.
// =========================================================================

describe('parity with the web surface', () => {
  it('the body is byte-identical to what the shared core builder produces for the same order', async () => {
    const { prepareDeliveryRequest, DELIVERY_REQUEST_EMAIL_NAMES } = await import('@stockpilot/core');
    const o = order();
    // Assembled the way web's SendDeliveryRequestButton assembles it.
    const webInput = {
      recipients: {
        to: DELIVERY_REQUEST_EMAIL.to,
        cc: DELIVERY_REQUEST_EMAIL.cc,
        toName: DELIVERY_REQUEST_EMAIL_NAMES.to,
        ccName: DELIVERY_REQUEST_EMAIL_NAMES.cc,
      },
      orderId: o.id,
      orderNumber: o.orderNumber,
      fulfillmentType: 'delivery' as const,
      warehouseName: o.warehouseName!,
      destination: o.destination,
      requestedFor: o.requesterName!,
      requesterEmail: o.requesterEmail,
      neededByLocal: o.neededBy!,
      orgTimezone: o.orgTimezone!,
      notes: o.notes!,
      lines: o.lines.map((l) => ({ itemId: l.itemId!, quantity: l.requested })),
      itemMap: new Map(o.lines.map((l) => [l.itemId!, { name: l.name, sku: l.sku ?? '' }])),
    };
    const web = prepareDeliveryRequest(webInput);
    const mobile = prepareOrderDeliveryRequest(o);
    expect(mobile.draft.body).toBe(web.draft.body);
    expect(mobile.draft.subject).toBe(web.draft.subject);
    expect(mobile.draft.to).toBe(web.draft.to);
    expect(mobile.draft.cc).toBe(web.draft.cc);
    // Same web transport too — the phone only ADDS the native one.
    expect(mobile.outlookUrl).toBe(web.outlookUrl);
  });
});
