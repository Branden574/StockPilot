import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as Linking from 'expo-linking';

import {
  DELIVERY_REQUEST_EMAIL,
  DELIVERY_REQUEST_RECIPIENTS,
  DRAFT_URL_LIMIT,
  ORDER_STATUS_KEYS,
  condensedNoticeText,
  deliveryRecipientsForRouting,
  deliveryRequestRecipients,
  type DeliveryRequestRecipients,
  type OrderStatusKey,
  type OrgEmailRoutingReadState,
} from '@stockpilot/core';

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
  deliveryComposeTransport,
  deliveryRoutingFromOrgRow,
  deliverySuccessMessageFor,
  isMissingEmailRoutingColumn,
  needsDeliveryRequestData,
  openDeliveryRequestDraft,
  parseCharterAddress,
  prepareOrderDeliveryRequest,
  recipientsHelperText,
  shouldShowBlockedNotice,
  shouldShowCondensedNotice,
  shouldWarnDuplicateDrafts,
  type DeliveryOpenResult,
  type DeliveryRequestOrderData,
} from './delivery-request-actions';
import { nativeOutlookAvailable, shouldConfirmBeforeOpening } from './outlook-transport';

// Same mock, same reasoning, as maintenance-email-actions.test.ts: expo-linking
// is a real installed dependency (~7.1.7); vi.mock is hoisted above the imports
// regardless of textual position, and is written here to keep import/first
// lint-clean.
vi.mock('expo-linking', () => ({
  openURL: vi.fn(async () => undefined),
  canOpenURL: vi.fn(async () => true),
}));

beforeEach(() => vi.clearAllMocks());

// The COMPILED pair (L4L's mailboxes) — what the pre-migration 'fallback'
// state resolves to, and therefore what the transport/CC-gate blocks below
// compose with: those tests pin CC mechanics, not tenancy, so they use the
// value whose addresses the assertions already name.
const RECIPIENTS = DELIVERY_REQUEST_RECIPIENTS;

// A CONFIGURED, non-L4L pair (per-org email routing, migration 0337) built
// through the only constructor there is — used by the routing tests to prove
// the org's stored value actually reaches the composed URL, and that nothing
// silently substitutes the compiled constants for it.
const CONFIGURED = deliveryRequestRecipients({
  to: 'warehouse-intake@acme-tenant.invalid',
  cc: 'ops-copy@acme-tenant.invalid',
  toName: 'Acme Warehouse',
  ccName: 'Acme Ops',
});
const CONFIGURED_DTO = {
  to: 'warehouse-intake@acme-tenant.invalid',
  cc: 'ops-copy@acme-tenant.invalid',
  toName: 'Acme Warehouse',
  ccName: 'Acme Ops',
};
const ROUTED_VALID: OrgEmailRoutingReadState = { state: 'valid', recipients: CONFIGURED_DTO };

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
    const prepared = prepareOrderDeliveryRequest(order(), RECIPIENTS);
    expect(prepared.draft.condensed).toBe(false);
    expect(prepared.linkFits).toBe(true);
    expect(ccOf(prepared.outlookMobileUrl)).toBe(prepared.draft.cc);
    expect(ccOf(prepared.outlookMobileUrl)).toBe(DELIVERY_REQUEST_EMAIL.cc);
    expect(toOf(prepared.outlookMobileUrl)).toBe(DELIVERY_REQUEST_EMAIL.to);
  });

  it('CONDENSED body: the ladder shortens the item rows, and the cc is NOT one of the things dropped', () => {
    const prepared = prepareOrderDeliveryRequest(bigOrder(), RECIPIENTS);
    // FIXTURE CHECK, not a ladder check. These two lines prove `bigOrder()` is
    // genuinely big enough to reach a condensed rung, so the cc assertions
    // below are reading a SHORTENED body rather than silently re-testing the
    // full one that the previous test already covers.
    //
    // They are not what would catch the ladder being deleted — an earlier
    // version of this comment claimed that and it is false. With no ladder this
    // order composes one oversized draft, and `linkFits` below goes false; that
    // assertion is what fails first. What the ladder is really pinned by is the
    // 'the ladder is fitted against the url this phone will open' block.
    expect(prepared.draft.condensed).toBe(true);
    expect(prepared.draft.listedLineCount).toBeLessThan(prepared.draft.lineCount);
    expect(prepared.linkFits).toBe(true);
    expect(ccOf(prepared.outlookMobileUrl)).toBe(prepared.draft.cc);
    expect(ccOf(prepared.outlookMobileUrl)).toBe(DELIVERY_REQUEST_EMAIL.cc);
    expect(toOf(prepared.outlookMobileUrl)).toBe(DELIVERY_REQUEST_EMAIL.to);
  });

  it('OVERSIZED: even the draft that is too long to open still carries to and cc', () => {
    const prepared = prepareOrderDeliveryRequest(oversizedOrder(), RECIPIENTS);
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
      const url = prepareOrderDeliveryRequest(o, RECIPIENTS).outlookMobileUrl;
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
    const prepared = prepareOrderDeliveryRequest(order(), RECIPIENTS);
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
    const prepared = prepareOrderDeliveryRequest(order(), RECIPIENTS, true);
    await expect(
      openDeliveryRequestDraft('outlook', prepared, 'ios', () => {}),
    ).resolves.toEqual({
      outcome: 'opened',
      used: 'outlook-native',
    });
    const url = vi.mocked(Linking.openURL).mock.calls[0]![0] as string;
    expect(url.startsWith('ms-outlook://compose?')).toBe(true);
    expect(url.startsWith('http')).toBe(false);
    expect(ccOf(url)).toBe('arosas@cvwest.org');
  });

  it('CONDENSED draft still opens the native link WITH the cc', async () => {
    const prepared = prepareOrderDeliveryRequest(bigOrder(), RECIPIENTS, true);
    await openDeliveryRequestDraft('outlook', prepared, 'android', () => {});
    const url = vi.mocked(Linking.openURL).mock.calls[0]![0] as string;
    expect(url.startsWith('ms-outlook://compose?')).toBe(true);
    expect(ccOf(url)).toBe('arosas@cvwest.org');
  });

  it('no native Outlook installed: falls back to the tenant-verified WEB url, cc intact', async () => {
    const prepared = prepareOrderDeliveryRequest(order(), RECIPIENTS, false);
    const res = await openDeliveryRequestDraft('outlook', prepared, 'ios', () => {});
    expect(res).toEqual({ outcome: 'opened', used: 'outlook-web' });
    const url = vi.mocked(Linking.openURL).mock.calls[0]![0] as string;
    expect(url.startsWith('https://outlook.cloud.microsoft/mail/deeplink/compose?mailtouri=')).toBe(
      true,
    );
    expect(ccOf(url)).toBe('Andrew Rosas <arosas@cvwest.org>');
  });

  it('the probe has not answered yet (null): opens the WEB url, which is what the worst-case budget measured', async () => {
    const prepared = prepareOrderDeliveryRequest(order(), RECIPIENTS, null);
    const res = await openDeliveryRequestDraft('outlook', prepared, 'android', () => {});
    expect(res).toEqual({ outcome: 'opened', used: 'outlook-web' });
    const url = vi.mocked(Linking.openURL).mock.calls[0]![0] as string;
    expect(url.startsWith('https://outlook.cloud.microsoft/')).toBe(true);
    expect(url).toBe(prepared.outlookUrl);
  });

  it('a canOpenURL rejection is read as "not installed", so the probe can never hand this feature a false true', async () => {
    // The probe now runs at the SCREEN, once, and its answer is passed in — so
    // what this feature depends on is that a throwing canOpenURL resolves to
    // `false`, never to a truthy value that would select the unmeasured native
    // budget.
    vi.mocked(Linking.canOpenURL).mockRejectedValueOnce(new Error('scheme not declared'));
    const probed = await nativeOutlookAvailable();
    expect(probed).toBe(false);
    expect(deliveryComposeTransport(probed)).toBe('outlook-web');
  });

  it('cc-untrusted platform reroutes to mailto rather than keeping the Outlook brand', async () => {
    const prepared = prepareOrderDeliveryRequest(order(), RECIPIENTS, true);
    const res = await openDeliveryRequestDraft('outlook', prepared, 'ios', () => {}, {
      ios: false,
      android: true,
    });
    expect(res).toEqual({ outcome: 'opened', used: 'default-mail' });
    const url = vi.mocked(Linking.openURL).mock.calls[0]![0] as string;
    expect(url.startsWith('mailto:dc4@learn4life.org?cc=arosas%40cvwest.org')).toBe(true);
  });

  it('exactly ONE openURL per tap — never auto-retried into a duplicate request to DC4', async () => {
    const prepared = prepareOrderDeliveryRequest(order(), RECIPIENTS, true);
    await openDeliveryRequestDraft('outlook', prepared, 'ios', () => {});
    expect(Linking.openURL).toHaveBeenCalledTimes(1);
  });

  it('an openURL rejection reports blocked and does NOT silently open something else', async () => {
    vi.mocked(Linking.openURL).mockRejectedValueOnce(new Error('no handler'));
    const prepared = prepareOrderDeliveryRequest(order(), RECIPIENTS, true);
    await expect(
      openDeliveryRequestDraft('outlook', prepared, 'ios', () => {}),
    ).resolves.toEqual({
      outcome: 'blocked',
      used: null,
    });
    expect(Linking.openURL).toHaveBeenCalledTimes(1);
  });

  it('linkFits=false opens NOTHING', async () => {
    const prepared = prepareOrderDeliveryRequest(oversizedOrder(), RECIPIENTS, true);
    await expect(
      openDeliveryRequestDraft('outlook', prepared, 'ios', () => {}),
    ).resolves.toEqual({
      outcome: 'blocked',
      used: null,
    });
    expect(Linking.openURL).not.toHaveBeenCalled();
  });

  it('onOpened fires only after a REAL open, never on a blocked one', async () => {
    const prepared = prepareOrderDeliveryRequest(order(), RECIPIENTS, true);
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
      prepareOrderDeliveryRequest(oversizedOrder(), RECIPIENTS, true),
      'ios',
      onOpened,
    );
    expect(onOpened).not.toHaveBeenCalled();
  });
});

// =========================================================================
// THE DOUBLE-TAP LATCH (shared `composeOpenInFlight` in ./outlook-transport,
// pinned per-feature here AND in maintenance-email-actions.test.ts so a
// future de-share of the opener cannot silently drop it from either — the
// screens' `disabled` props demonstrably do not close the same-frame window;
// two calls in one frame both opened before this existed, and for DC4 two
// compose screens are two real delivery requests).
// =========================================================================

describe('the double-tap latch — one unresolved open swallows every call behind it', () => {
  it('two synchronous taps: exactly ONE openURL and ONE counted draft; the second reports in_flight, never blocked', async () => {
    let release!: () => void;
    vi.mocked(Linking.openURL).mockImplementationOnce(
      () =>
        // expo-linking types a successful openURL as Promise<true>.
        new Promise<true>((resolve) => {
          release = () => resolve(true);
        }),
    );
    const onOpened = vi.fn();
    const prepared = prepareOrderDeliveryRequest(order(), RECIPIENTS, true);
    const first = openDeliveryRequestDraft('outlook', prepared, 'ios', onOpened);
    const second = openDeliveryRequestDraft('outlook', prepared, 'ios', onOpened);
    // The swallow settles immediately: no openURL, no counted draft, and the
    // DISTINCT outcome — `blocked` here would surface retry copy for a tap
    // that needs none.
    await expect(second).resolves.toEqual({ outcome: 'in_flight', used: null });
    expect(Linking.openURL).toHaveBeenCalledTimes(1);
    expect(onOpened).not.toHaveBeenCalled();
    release();
    await expect(first).resolves.toEqual({ outcome: 'opened', used: 'outlook-native' });
    // The count feed (`onOpened`) fired exactly once for the two taps.
    expect(onOpened).toHaveBeenCalledTimes(1);
  });

  it('the latch RELEASES after a resolved open — a deliberate reopen after settle opens again', async () => {
    const onOpened = vi.fn();
    const prepared = prepareOrderDeliveryRequest(order(), RECIPIENTS, true);
    await openDeliveryRequestDraft('outlook', prepared, 'ios', onOpened);
    await expect(
      openDeliveryRequestDraft('outlook', prepared, 'ios', onOpened),
    ).resolves.toEqual({ outcome: 'opened', used: 'outlook-native' });
    expect(Linking.openURL).toHaveBeenCalledTimes(2);
    expect(onOpened).toHaveBeenCalledTimes(2);
  });

  it('the latch RELEASES after a REJECTED open — a stuck latch would brick the button, which is worse than the double-open', async () => {
    let rejectOpen!: (e: Error) => void;
    vi.mocked(Linking.openURL).mockImplementationOnce(
      () =>
        new Promise<true>((_resolve, reject) => {
          rejectOpen = reject;
        }),
    );
    const prepared = prepareOrderDeliveryRequest(order(), RECIPIENTS, true);
    const first = openDeliveryRequestDraft('outlook', prepared, 'ios', () => {});
    // While the doomed open is still unresolved, a tap is swallowed...
    await expect(
      openDeliveryRequestDraft('outlook', prepared, 'ios', () => {}),
    ).resolves.toEqual({ outcome: 'in_flight', used: null });
    rejectOpen(new Error('no handler'));
    await expect(first).resolves.toEqual({ outcome: 'blocked', used: null });
    // ...and after the rejection settles, the button works again.
    await expect(
      openDeliveryRequestDraft('outlook', prepared, 'ios', () => {}),
    ).resolves.toEqual({ outcome: 'opened', used: 'outlook-native' });
    expect(Linking.openURL).toHaveBeenCalledTimes(2);
  });
});

// =========================================================================
// THE LADDER MEASURES THE TRANSPORT THAT ACTUALLY OPENS.
//
// The defect this block exists for: core fitted every item row against the
// https OWA url because that is what WEB opens, while a phone with Outlook
// installed opens `ms-outlook://compose` — roughly 25-30% shorter for the same
// body. The phone therefore dropped item rows it had room for, which is the
// exact complaint that started this feature.
//
// These are RELATIONSHIP assertions, never absolute row counts. The needed-by
// line renders wider under Hermes than under node ("Aug 18, 2026 at 9:00 AM"
// versus "Aug 18, 2026, 9:00 AM", and U+202F costs more percent-encoded), so a
// device can legitimately land one row below whatever a node-run test would
// predict. Pinning a literal count here would pin node's bytes to a device.
// =========================================================================

describe('the ladder is fitted against the url this phone will open', () => {
  /** A realistic 25-line school-supply order: long enough that the ladder runs,
   *  ordinary enough that the numbers mean something. */
  function order25(): DeliveryRequestOrderData {
    const names = [
      'Composition Notebook Wide Rule 100 Sheet',
      'Ticonderoga No 2 Pencil 12 Pack',
      'Elmers Washable School Glue 4oz',
      'Crayola Crayons 24 Count',
      'Fiskars Blunt Tip Kids Scissors',
      'Expo Low Odor Dry Erase Marker Black',
      'Post-it Notes 3x3 Yellow 12 Pad',
      'Clorox Disinfecting Wipes 75 Count',
      'Kleenex Facial Tissue 160 Count',
      'Purell Hand Sanitizer 8oz Pump',
      'Sharpie Permanent Marker Fine Black',
      'Two Pocket Folder Assorted Colors',
      'Wide Ruled Filler Paper 200 Sheet',
      'Highlighter Chisel Tip Assorted 6 Pack',
      'Index Cards 3x5 Ruled White 100',
      'Manila File Folder Letter Size 100',
      'Copy Paper 8.5x11 20lb Ream',
      'Binder Clips Medium 12 Count',
      'Stapler Full Strip Black',
      'Staples Standard 5000 Count Box',
      'Scotch Magic Tape 3/4 Inch',
      'Rubber Bands Size 33 1lb Bag',
      'Dry Erase Board Eraser Felt',
      'Whiteboard Cleaner Spray 8oz',
      'Trash Can Liner 33 Gallon 100 Count',
    ];
    return order({
      lines: names.map((name, i) => ({
        itemId: `i-${i}`,
        name,
        sku: `SP-KIT-${1000 + i}`,
        requested: (i % 9) + 2,
      })),
    });
  }

  it('THE DEFECT: a phone with Outlook installed carries MORE rows than the web budget allows', () => {
    const web = prepareOrderDeliveryRequest(order25(), RECIPIENTS, false);
    const native = prepareOrderDeliveryRequest(order25(), RECIPIENTS, true);

    // Both really are on the ladder — otherwise this passes with it deleted.
    expect(web.draft.condensed).toBe(true);
    expect(native.draft.condensed).toBe(true);
    expect(web.draft.lineCount).toBe(25);

    // The claim itself. Strictly more, not "at least as many": on this order
    // the difference is the whole point.
    expect(native.draft.listedLineCount).toBeGreaterThan(web.draft.listedLineCount);
    // And the extra rows are really in the message, not just in a counter.
    expect(native.draft.body.length).toBeGreaterThan(web.draft.body.length);
  });

  it('THE HEADROOM, numerically: the web-fitted draft leaves the native url hundreds of characters short of the limit', () => {
    // The pre-fix behaviour, quantified. This is what "measured the wrong
    // transport" cost: the url the phone opens sat far under the ceiling while
    // rows were being dropped to satisfy a url it never opens.
    const web = prepareOrderDeliveryRequest(order25(), RECIPIENTS, false);
    const wasted = DRAFT_URL_LIMIT - web.outlookMobileUrl.length;
    expect(wasted).toBeGreaterThan(300);
    // For scale: that unused headroom is worth several more item rows, and
    // fitting against the native url actually claims them.
    const native = prepareOrderDeliveryRequest(order25(), RECIPIENTS, true);
    expect(native.draft.listedLineCount - web.draft.listedLineCount).toBeGreaterThanOrEqual(4);
    // The native fit uses the headroom without exceeding it.
    expect(native.outlookMobileUrl.length).toBeLessThanOrEqual(DRAFT_URL_LIMIT);
    expect(DRAFT_URL_LIMIT - native.outlookMobileUrl.length).toBeLessThan(wasted);
  });

  it('whatever the planner opens is a url that was MEASURED — across every probe answer and platform', async () => {
    // The invariant that makes the whole change safe: fitting for the shorter
    // native budget and then opening the longer web url would truncate the body
    // silently, which is worse than dropping a row. So for every combination
    // the phone can be in, the url handed to the OS is at or under the limit.
    for (const nativeOutlook of [true, false, null] as const) {
      for (const platform of ['ios', 'android'] as const) {
        for (const o of [order(), bigOrder(), order25()]) {
          vi.mocked(Linking.openURL).mockClear();
          const prepared = prepareOrderDeliveryRequest(o, RECIPIENTS, nativeOutlook);
          expect(prepared.linkFits).toBe(true);
          await openDeliveryRequestDraft('outlook', prepared, platform, () => {});
          const url = vi.mocked(Linking.openURL).mock.calls[0]![0] as string;
          expect(url.length).toBeLessThanOrEqual(DRAFT_URL_LIMIT);
          // ...and it is the transport the ladder declared it was fitting.
          expect(url).toBe(
            prepared.transport === 'outlook-native' ? prepared.outlookMobileUrl : prepared.outlookUrl,
          );
        }
      }
    }
  });

  it('the native budget genuinely leaves the WEB url unmeasured — which is why the pairing is not optional', () => {
    // The teeth behind the invariant above. Under `outlook-native` the web url
    // is allowed to blow past the limit, so a phone that measured native and
    // then opened web would hand the OS a body that truncates in transit with
    // no signal to anyone.
    const native = prepareOrderDeliveryRequest(order25(), RECIPIENTS, true);
    expect(native.linkFits).toBe(true);
    expect(native.transport).toBe('outlook-native');
    expect(native.outlookMobileUrl.length).toBeLessThanOrEqual(DRAFT_URL_LIMIT);
    expect(native.outlookUrl.length).toBeGreaterThan(DRAFT_URL_LIMIT);
  });

  /**
   * THE PAIRING IS A SIGNATURE NOW, NOT A CONVENTION.
   *
   * The highest-value decision on `app/order/[id].tsx` used to be that ONE
   * `nativeOutlook` state value reached both `prepareOrderDeliveryRequest`
   * (which budget is measured) and `openDeliveryRequestDraft` (which url is
   * opened). Diverge them and the phone opens a url nothing measured — a silent
   * truncation, worse than the dropped rows this wave fixed. The screen is a
   * `.tsx` under `app/`, which this repo's mobile vitest cannot import, so that
   * decision was guarded by a comment and by nothing else.
   *
   * A source-text grep for "the same variable in both calls" was the obvious
   * cover and was rejected: it cannot tell a real pairing from a coincidence,
   * and this repo has been bitten by exactly that. The fix is structural
   * instead — `openDeliveryRequestDraft` takes no probe answer at all. It reads
   * `transport` off the prepared draft, so the two values it could have
   * disagreed about are one value, on one object.
   *
   * These two tests are what remains to pin: that the opener really does read
   * the draft's own stamp (runtime), and that no second argument has grown back
   * for a caller to get wrong (typecheck).
   */
  it('STRUCTURAL: the opener follows the DRAFT\'S OWN stamp, so a mismatched pair cannot be constructed', async () => {
    // Both halves of a prepared draft — the urls and the transport that
    // measured them — travel together. Hand the opener a draft whose stamp says
    // native and the native url opens; hand it one whose stamp says web and the
    // web url opens. There is no third input to reconcile.
    for (const [nativeOutlook, expectedTransport, expectedUrlKey] of [
      [true, 'outlook-native', 'outlookMobileUrl'],
      [false, 'outlook-web', 'outlookUrl'],
      [null, 'outlook-web', 'outlookUrl'],
    ] as const) {
      vi.mocked(Linking.openURL).mockClear();
      const prepared = prepareOrderDeliveryRequest(order25(), RECIPIENTS, nativeOutlook);
      expect(prepared.transport).toBe(expectedTransport);
      await openDeliveryRequestDraft('outlook', prepared, 'ios', () => {});
      expect(vi.mocked(Linking.openURL).mock.calls[0]![0]).toBe(prepared[expectedUrlKey]);
    }

    // And the stamp is what is read — not the probe, not a default. A draft
    // measured for the web budget opens the WEB url even though this device's
    // native app is available, because the web url is the one that was fitted.
    vi.mocked(Linking.openURL).mockClear();
    const webFitted = prepareOrderDeliveryRequest(order25(), RECIPIENTS, false);
    await openDeliveryRequestDraft('outlook', webFitted, 'ios', () => {});
    expect(vi.mocked(Linking.openURL).mock.calls[0]![0]).toBe(webFitted.outlookUrl);
    // Proving that mattered: the native url of a web-fitted draft is a
    // DIFFERENT, shorter string, so "either would have passed" is not true here.
    expect(webFitted.outlookMobileUrl).not.toBe(webFitted.outlookUrl);
  });

  it('TYPE-LEVEL PIN: the opener takes no probe answer, so the screen cannot pass one that disagrees', () => {
    const prepared = prepareOrderDeliveryRequest(order(), RECIPIENTS, true);
    const call = () =>
      // @ts-expect-error `nativeOutlook` is not a parameter: the transport comes
      // from `prepared`. If this argument is ever reinstated, the directive
      // becomes unused and `pnpm typecheck` fails with TS2578 — which is the
      // point, because reinstating it reintroduces the divergence.
      openDeliveryRequestDraft('outlook', prepared, 'ios', false, () => {});
    // Never invoked: the assertion is that the line above does not typecheck.
    expect(typeof call).toBe('function');
  });

  it('the mailto reroute is safe under BOTH budgets: core measures it either way', async () => {
    // planOutlookOpen sends a cc-untrusted platform to mailto. That url is not
    // the one `transport` names, so it is only safe because core measures the
    // mailto on every rung regardless of transport.
    const native = prepareOrderDeliveryRequest(order25(), RECIPIENTS, true);
    expect(native.mailtoUrl.length).toBeLessThanOrEqual(DRAFT_URL_LIMIT);
    const res = await openDeliveryRequestDraft('outlook', native, 'ios', () => {}, {
      ios: false,
      android: true,
    });
    expect(res).toEqual({ outcome: 'opened', used: 'default-mail' });
    const url = vi.mocked(Linking.openURL).mock.calls[0]![0] as string;
    expect(url.length).toBeLessThanOrEqual(DRAFT_URL_LIMIT);
    expect(ccOf(url)).toBe(DELIVERY_REQUEST_EMAIL.cc);
  });

  it('the shortened draft still discloses the shortfall honestly at BOTH budgets', () => {
    // More rows must not mean a quieter message. The disclosure names the split
    // either way, and it names the RIGHT split for the rows actually carried.
    for (const nativeOutlook of [false, true] as const) {
      const p = prepareOrderDeliveryRequest(order25(), RECIPIENTS, nativeOutlook);
      expect(p.draft.body).toContain('This message was shortened');
      expect(p.draft.body).toContain(
        `Lines 1-${p.draft.listedLineCount} of ${p.draft.lineCount} are listed above`,
      );
      expect(condensedNoticeText(p.draft)).toContain(
        `first ${p.draft.listedLineCount} of ${p.draft.lineCount}`,
      );
    }
  });

  it('deliveryComposeTransport: only a PROVED native app selects the shorter budget', () => {
    // The one predicate both the measurement and the plan read. `null` is the
    // not-yet-probed state and must fall to the worst case, not to the fast one.
    expect(deliveryComposeTransport(true)).toBe('outlook-native');
    expect(deliveryComposeTransport(false)).toBe('outlook-web');
    expect(deliveryComposeTransport(null)).toBe('outlook-web');
  });

  it('the prepared draft records which transport it was fitted for', () => {
    expect(prepareOrderDeliveryRequest(order(), RECIPIENTS, true).transport).toBe('outlook-native');
    expect(prepareOrderDeliveryRequest(order(), RECIPIENTS, false).transport).toBe('outlook-web');
    expect(prepareOrderDeliveryRequest(order(), RECIPIENTS, null).transport).toBe('outlook-web');
    // The default is the WORST case, so a caller that forgets to pass the probe
    // answer under-fills rather than truncating.
    expect(prepareOrderDeliveryRequest(order(), RECIPIENTS).transport).toBe('outlook-web');
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
    routing: ROUTED_VALID,
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

  /**
   * THE ROUTING MATRIX CELL, pinned per state — the mobile parity of web's
   * order page (`showDeliveryRequest && deliveryRequestRecipientsDto`):
   * unset and invalid HIDE, valid and (pre-migration) fallback SHOW. The
   * table is written by hand from the fallback matrix, not derived from
   * `deliveryRecipientsForRouting`, so a mutant that widens the mapping
   * (e.g. constants for 'unset') disagrees with a row here by name.
   */
  const ROUTING_MATRIX: [OrgEmailRoutingReadState, boolean][] = [
    [ROUTED_VALID, true],
    [{ state: 'fallback' }, true],
    [{ state: 'unset' }, false],
    [{ state: 'invalid', reason: 'Email recipient "cc" must be exactly one plain email address with no display name, separator or whitespace.' }, false],
  ];

  it.each(ROUTING_MATRIX)('routing %j -> shown: %s (matrix parity with the web order page)', (routing, shown) => {
    expect(canRequestDelivery({ ...base, routing })).toBe(shown);
  });

  it('an INVALID stored value fails CLOSED — hidden, never the compiled constants', () => {
    const invalid: OrgEmailRoutingReadState = {
      state: 'invalid',
      reason: 'Stored recipients failed validation.',
    };
    expect(canRequestDelivery({ ...base, routing: invalid })).toBe(false);
    // And the mapping the gate consults agrees: no recipients exist to
    // compose with, so no code path can even build a draft for this org.
    expect(deliveryRecipientsForRouting(invalid)).toBeNull();
    expect(deliveryRecipientsForRouting({ state: 'unset' })).toBeNull();
  });
});

describe('needsDeliveryRequestData (the load-time fetch gate)', () => {
  // The screen spends two extra reads — the destination charter and the org
  // timezone — only when this says so. Those two fields exist ONLY for the
  // delivery request, so the gate that fetches them and the gate that shows the
  // button have to agree, and this is the direction that matters.
  //
  // WHAT WAS WRONG HERE (measured 2026-08-13). This block pinned four things:
  // approved+delivery loads, pickup does not, the three terminal statuses do
  // not, and a null status does not. `approved` was the ONLY status pinned true,
  // so replacing the whole predicate's second line with
  // `return row.status === 'approved';` passed 58/58 of these tests and
  // 1470/1470 of the mobile suite. That mutant takes the delivery button away
  // from every order in `pending_approval`, `picking_in_progress`,
  // `staged_for_delivery`, `in_transit`, `backordered` and the rest — the button
  // simply stops appearing, on the majority of live delivery orders, and no test
  // anywhere says so. So the table below states the answer for EVERY canonical
  // status by hand.

  /**
   * THE REQUIREMENT, RESTATED BY HAND, ONE ROW PER STATUS.
   *
   * Written from the rule ("an order that is completed, denied or cancelled has
   * nothing left to deliver; every other status is still live") rather than
   * from the code — deliberately as an EXHAUSTIVE ALLOWLIST where the
   * implementation is a three-item denylist, so the two disagree loudly instead
   * of sharing a mistake. `DELIVERY_REQUEST_BLOCKED_STATUSES` is not read
   * anywhere in this table; if someone adds a fourth entry to it, these rows are
   * what refuses.
   *
   * Keyed by `OrderStatusKey`, so a status added to the canonical union without
   * a decision recorded here is a TYPE error rather than a silent default —
   * which matters because the silent default is "load", i.e. the button appears.
   */
  const EXPECTED_LOAD_BY_STATUS: Record<OrderStatusKey, boolean> = {
    pending_confirmation: true,
    pending_approval: true,
    approved: true,
    pick_slip_generated: true,
    picking_in_progress: true,
    picking_complete: true,
    packing_slip_generated: true,
    staged_for_pickup: true,
    staged_for_delivery: true,
    in_transit: true,
    backordered: true,
    completed: false,
    denied: false,
    cancelled: false,
  };

  /** The rest of the rule, also stated by hand: a delivery, with a status. */
  function expectedLoad(row: { status: string | null; fulfillmentType: string | null }): boolean {
    if (row.fulfillmentType !== 'delivery') return false;
    if (row.status === null) return false;
    // An unrecognised status is LIVE. That is the cheap direction to be wrong
    // in (two reads that go unused) and is what the implementation does; the
    // expensive direction — a fetch gate narrower than the display gate — is
    // the invariant asserted further down.
    return EXPECTED_LOAD_BY_STATUS[row.status as OrderStatusKey] ?? true;
  }

  /** And the display gate, from the web page's rule: the viewer must BE the
   *  requester, on a row this gate would load for, with the module on, in an
   *  org whose routing resolves to a routable pair. The routing half is
   *  written BY HAND from the fallback matrix ('valid' and the pre-migration
   *  'fallback' show; 'unset' and 'invalid' hide) — deliberately not derived
   *  from `deliveryRecipientsForRouting`, so the sweep can catch that
   *  mapping widening. */
  function expectedShow(gate: {
    status: string | null;
    fulfillmentType: string | null;
    requesterUserId: string | null;
    viewerUserId: string | null;
    ordersModuleEnabled: boolean;
    routing: OrgEmailRoutingReadState;
  }): boolean {
    return (
      expectedLoad(gate) &&
      gate.ordersModuleEnabled &&
      (gate.routing.state === 'valid' || gate.routing.state === 'fallback') &&
      gate.requesterUserId !== null &&
      gate.viewerUserId !== null &&
      gate.requesterUserId === gate.viewerUserId
    );
  }

  it('the hand-written table covers every canonical status, so nothing falls through it', () => {
    expect(Object.keys(EXPECTED_LOAD_BY_STATUS).sort()).toEqual([...ORDER_STATUS_KEYS].sort());
    // The three the table says no to are exactly the three the implementation
    // blocks — asserted here ONCE, as an agreement between two independently
    // written lists, rather than assumed throughout.
    expect(ORDER_STATUS_KEYS.filter((s) => !EXPECTED_LOAD_BY_STATUS[s])).toEqual([
      'completed',
      'denied',
      'cancelled',
    ]);
    expect(DELIVERY_REQUEST_BLOCKED_STATUSES).toEqual(['completed', 'denied', 'cancelled']);
    // Non-vacuous in the other direction too: most statuses must LOAD, or the
    // mutant that answers `false` everywhere would pass the table.
    expect(ORDER_STATUS_KEYS.filter((s) => EXPECTED_LOAD_BY_STATUS[s])).toHaveLength(11);
  });

  it.each(ORDER_STATUS_KEYS)('status %s: loads exactly what the table says, on a delivery order', (status) => {
    expect(needsDeliveryRequestData({ status, fulfillmentType: 'delivery' })).toBe(
      EXPECTED_LOAD_BY_STATUS[status],
    );
    // ...and never on a pickup, whatever the status.
    expect(needsDeliveryRequestData({ status, fulfillmentType: 'pickup' })).toBe(false);
  });

  it('a row with no fulfillment type or no status loads nothing', () => {
    expect(needsDeliveryRequestData({ status: 'approved', fulfillmentType: null })).toBe(false);
    expect(needsDeliveryRequestData({ status: null, fulfillmentType: 'delivery' })).toBe(false);
    expect(needsDeliveryRequestData({ status: null, fulfillmentType: null })).toBe(false);
  });

  it('an unrecognised status is treated as live — the cheap direction to be wrong in', () => {
    // A status the enum does not know about (a future one, or a hand-edited
    // row) buys two reads it may not use. The alternative would hide the button
    // from a real delivery order, which is the failure this gate exists to
    // prevent.
    expect(needsDeliveryRequestData({ status: 'some_future_status', fulfillmentType: 'delivery' })).toBe(
      true,
    );
  });

  /**
   * THE INVARIANT — and why the previous version of this test could not fail.
   *
   * It used to assert `canRequestDelivery(g) => needsDeliveryRequestData(g)`
   * over 432 combinations. `canRequestDelivery`'s FIRST LINE calls
   * `needsDeliveryRequestData`, so that implication is true by CONSTRUCTION: it
   * held for every mutant of either function, including the ones that break the
   * feature outright. A test named for a guarantee it structurally cannot give
   * is worse than no test, because it occupies the place where the real one
   * would go.
   *
   * The version below asserts both gates against the hand-written expectations
   * above — which were derived from the requirement, not from the code — and
   * then asserts the implication ON THOSE EXPECTATIONS. That last step can fail:
   * if the table ever said "show" for a row it does not say "load" for, the
   * requirement itself would be inconsistent and this says so before the code
   * gets a chance to be.
   */
  it('THE INVARIANT: over the whole input space, both gates match the hand-written expectation and show implies load', () => {
    const ROUTINGS: OrgEmailRoutingReadState[] = [
      ROUTED_VALID,
      { state: 'fallback' },
      { state: 'unset' },
      { state: 'invalid', reason: 'bad stored value' },
    ];
    let showed = 0;
    let loaded = 0;
    let checked = 0;
    for (const status of [...ORDER_STATUS_KEYS, 'some_future_status', null]) {
      for (const fulfillmentType of ['delivery', 'pickup', null]) {
        for (const requesterUserId of ['u1', null]) {
          for (const viewerUserId of ['u1', 'u2', null]) {
            for (const ordersModuleEnabled of [true, false]) {
              for (const routing of ROUTINGS) {
                const gate = {
                  status,
                  fulfillmentType,
                  requesterUserId,
                  viewerUserId,
                  ordersModuleEnabled,
                  routing,
                };
                const show = expectedShow(gate);
                const load = expectedLoad(gate);
                // Stated on the EXPECTATIONS, where it is a real claim about the
                // requirement rather than a restatement of the call graph.
                if (show) expect(load).toBe(true);

                expect({ gate, show: canRequestDelivery(gate) }).toEqual({ gate, show });
                expect({ gate, load: needsDeliveryRequestData(gate) }).toEqual({ gate, load });
                checked += 1;
                if (show) showed += 1;
                if (load) loaded += 1;
              }
            }
          }
        }
      }
    }
    // The sweep must actually reach both answers, or it proves nothing.
    expect(checked).toBe(2304);
    expect(showed).toBeGreaterThan(0);
    // And the fetch gate must be strictly WIDER than the display gate — if
    // these were equal, the "deliberately wider" design below would be fiction.
    // (The routing dimension alone guarantees it now — a row loads under all
    // four routing states but shows under only two — and the pre-routing
    // requester/viewer asymmetry still contributes as before.)
    expect(loaded).toBeGreaterThan(showed);
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
        routing: ROUTED_VALID,
      }),
    ).toBe(false);
  });
});

// =========================================================================
// The org's routing read (per-org email routing, migration 0337) — what the
// screen resolves off the organizations row, and the deploy-window decision.
// =========================================================================

describe('deliveryRoutingFromOrgRow', () => {
  it('a stored, factory-passing value resolves VALID with the exact stored strings', () => {
    const routing = deliveryRoutingFromOrgRow({
      email_routing: { delivery_request: CONFIGURED_DTO },
    });
    expect(routing).toEqual({ state: 'valid', recipients: CONFIGURED_DTO });
  });

  it('a NULL column, an absent key, and a missing row are all UNSET — the action hides', () => {
    expect(deliveryRoutingFromOrgRow({ email_routing: null })).toEqual({ state: 'unset' });
    expect(deliveryRoutingFromOrgRow({})).toEqual({ state: 'unset' });
    expect(deliveryRoutingFromOrgRow(null)).toEqual({ state: 'unset' });
    // The maintenance twin's key alone configures NOTHING for delivery.
    expect(
      deliveryRoutingFromOrgRow({ email_routing: { maintenance_request: CONFIGURED_DTO } }),
    ).toEqual({ state: 'unset' });
  });

  it('a stored value the factory refuses is INVALID with the guard reason — and maps to NO recipients', () => {
    const routing = deliveryRoutingFromOrgRow({
      email_routing: {
        delivery_request: { to: 'intake@ok.invalid', cc: 'a?cc=attacker@evil.test' },
      },
    });
    expect(routing.state).toBe('invalid');
    if (routing.state === 'invalid') {
      expect(routing.reason).toBe(
        'Email recipient "cc" must be exactly one plain email address with no display name, separator or whitespace.',
      );
    }
    // FAIL CLOSED: the mapping refuses too — never the compiled constants.
    expect(deliveryRecipientsForRouting(routing)).toBeNull();
  });

  it('MUTATION PIN: unset/invalid resolve to NULL recipients, never the compiled L4L pair', () => {
    // A mutant that maps 'unset' or 'invalid' to the compiled constants —
    // silently mailing another tenant's warehouse — fails here by name.
    for (const routing of [
      deliveryRoutingFromOrgRow(null),
      deliveryRoutingFromOrgRow({ email_routing: { delivery_request: { to: 'x', cc: 'y' } } }),
    ]) {
      expect(deliveryRecipientsForRouting(routing)).toBeNull();
    }
    // While the two states that SHOULD resolve, do — to exactly the right pair.
    expect(deliveryRecipientsForRouting({ state: 'fallback' })?.cc).toBe(
      DELIVERY_REQUEST_EMAIL.cc,
    );
    expect(deliveryRecipientsForRouting(ROUTED_VALID)?.cc).toBe(CONFIGURED_DTO.cc);
  });
});

describe('isMissingEmailRoutingColumn (the 42703 fail-open retry decision)', () => {
  it('ONLY Postgres 42703 (undefined_column) selects the fallback retry', () => {
    expect(isMissingEmailRoutingColumn({ code: '42703' })).toBe(true);
  });

  it.each([
    ['another Postgres code', { code: '42501' }],
    ['a PostgREST error with no code', { code: undefined }],
    ['a null code', { code: null }],
    ['no error at all', null],
    ['undefined', undefined],
  ])('%s is NOT the deploy window — the routing must fail closed instead', (_label, error) => {
    expect(isMissingEmailRoutingColumn(error)).toBe(false);
  });
});

describe('the CONFIGURED recipients actually reach the composed URL', () => {
  it('the native deep link carries the org\'s stored to/cc — not the compiled constants', () => {
    const prepared = prepareOrderDeliveryRequest(order(), CONFIGURED, true);
    expect(toOf(prepared.outlookMobileUrl)).toBe('warehouse-intake@acme-tenant.invalid');
    expect(ccOf(prepared.outlookMobileUrl)).toBe('ops-copy@acme-tenant.invalid');
    // The ROUTING params carry nothing of the compiled pair. (The body may
    // legitimately mention a requester's own @cvwest.org reply-to — routing
    // is what this feature moves, not the order's facts.)
    expect(toOf(prepared.outlookMobileUrl)).not.toBe(DELIVERY_REQUEST_EMAIL.to);
    expect(ccOf(prepared.outlookMobileUrl)).not.toBe(DELIVERY_REQUEST_EMAIL.cc);
  });

  it('every transport and the clipboard carry the configured pair', () => {
    const prepared = prepareOrderDeliveryRequest(order(), CONFIGURED, true);
    expect(ccOf(prepared.mailtoUrl)).toBe('ops-copy@acme-tenant.invalid');
    // The OWA url carries the configured chip name, validated by the factory.
    expect(ccOf(prepared.outlookUrl)).toBe('Acme Ops <ops-copy@acme-tenant.invalid>');
    expect(prepared.clipboardText).toContain('CC: ops-copy@acme-tenant.invalid');
    expect(prepared.clipboardText).not.toContain('arosas@cvwest.org');
  });

  it('the helper sentence under the button names the SAME configured mailboxes', () => {
    const branded = deliveryRecipientsForRouting(ROUTED_VALID)!;
    expect(recipientsHelperText(branded)).toBe(
      'Opens a draft to warehouse-intake@acme-tenant.invalid, copying ops-copy@acme-tenant.invalid.',
    );
  });
});
// =========================================================================
// The input mapping — what the phone hands the shared builder.
// =========================================================================

describe('buildDeliveryRequestInput', () => {
  it('recipients are exactly the RESOLVED, branded value passed in — never anything on the order', () => {
    // Per-org email routing: the value can only have come from the branded
    // factory (compiled fallback or the org's validated stored pair). The
    // mapping copies it verbatim and reads nothing recipient-shaped off the
    // order row.
    const input = buildDeliveryRequestInput(order(), RECIPIENTS);
    expect(input.recipients.to).toBe('dc4@learn4life.org');
    expect(input.recipients.cc).toBe('arosas@cvwest.org');
    const configured = buildDeliveryRequestInput(order(), CONFIGURED);
    expect(configured.recipients.to).toBe('warehouse-intake@acme-tenant.invalid');
    expect(configured.recipients.cc).toBe('ops-copy@acme-tenant.invalid');
  });

  it('always declares delivery, so a pickup order can never produce a destination-less delivery draft', () => {
    expect(buildDeliveryRequestInput(order(), RECIPIENTS).fulfillmentType).toBe('delivery');
  });

  it('falls back to the JOINED profile email when the denormalized column is null (internal self-submits)', () => {
    // The real defect this guards: internal orders leave requester_email NULL,
    // and the profile email was already fetched but thrown away — so most
    // internal orders would have drafted with no contact for DC4 at all.
    const input = buildDeliveryRequestInput(
      order({ requesterEmail: null, requesterProfileEmail: 'jane@cvwest.org' }), RECIPIENTS);
    expect(input.requesterEmail).toBe('jane@cvwest.org');
  });

  it('prefers the denormalized on-behalf-of email over the profile email', () => {
    const input = buildDeliveryRequestInput(
      order({ requesterEmail: 'onbehalf@site.org', requesterProfileEmail: 'staff@cvwest.org' }), RECIPIENTS);
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
      }), RECIPIENTS);
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
      }), RECIPIENTS).draft.body;
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
      }), RECIPIENTS);
    expect(input.lines).toHaveLength(1);
    expect(input.itemMap.size).toBe(1);
    expect(input.itemMap.get('i1')).toEqual({ name: 'Real', sku: 'R-1' });
  });

  it('a null sku becomes an empty string, never the text "null"', () => {
    const input = buildDeliveryRequestInput(
      order({ lines: [{ itemId: 'i1', name: 'No SKU item', sku: null, requested: 1 }] }), RECIPIENTS);
    expect(input.itemMap.get('i1')).toEqual({ name: 'No SKU item', sku: '' });
    expect(prepareOrderDeliveryRequest(order({ lines: [{ itemId: 'i1', name: 'No SKU item', sku: null, requested: 1 }] }), RECIPIENTS).draft.body).not.toContain('null');
  });

  it('passes the needed-by instant through untouched for the builder to localise', () => {
    const input = buildDeliveryRequestInput(order({ neededBy: '2026-08-20T17:00:00.000Z' }), RECIPIENTS);
    expect(input.neededByLocal).toBe('2026-08-20T17:00:00.000Z');
    // And it really is rendered in the org zone, with the zone named.
    expect(prepareOrderDeliveryRequest(order(), RECIPIENTS).draft.body).toContain('America/Los_Angeles');
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

  it('the duplicate warning is TENANT-NEUTRAL — a second draft is a second real request, to whichever warehouse is configured', () => {
    // Web's exact genericized sentence (delivery-request-action.tsx). Naming
    // one tenant's warehouse here would state a falsehood on every other
    // org's screens now that recipients are per-org data (migration 0337).
    expect(DUPLICATE_WARNING).toBe(
      'You have already opened a draft for this order. Sending more than one creates duplicate requests for the warehouse.',
    );
    expect(DUPLICATE_WARNING).not.toMatch(/DC4/);
  });

  /**
   * THE MOBILE TWIN OF THE CC-NOTICE DEFECT, pinned the same way core's
   * `deliveryRequestCcNotice` is (apps/web/src/lib/site.test.ts).
   *
   * This line is the only place on the phone where the employee is told, in
   * writing, which two mailboxes the draft goes to. It is a PURE FUNCTION of
   * the recipients since per-org routing — a fixed sentence would name the
   * old mailboxes while the mail went to the configured ones, telling the
   * employee a copy was sent somewhere it was not. The assertion catches a
   * hand-typed sentence by MUTATION OF THE INPUT, not of the sentence:
   * change the recipients and a hand-typed line fails here.
   */
  it('the recipients helper names BOTH mailboxes by interpolation, and promises nothing extra', () => {
    const text = recipientsHelperText(DELIVERY_REQUEST_EMAIL);
    // Exactly two addresses appear, and they are the two inputs — in that
    // order, so the To is not described as the copy.
    expect(text.match(/[A-Za-z0-9._+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g)).toEqual([
      DELIVERY_REQUEST_EMAIL.to,
      DELIVERY_REQUEST_EMAIL.cc,
    ]);
    // The wording itself, pinned so an unintended edit fails by name.
    expect(text).toBe(
      `Opens a draft to ${DELIVERY_REQUEST_EMAIL.to}, copying ${DELIVERY_REQUEST_EMAIL.cc}.`,
    );
    // And it really is interpolation, not a memorized sentence: different
    // recipients, different sentence.
    expect(recipientsHelperText(CONFIGURED_DTO)).toBe(
      'Opens a draft to warehouse-intake@acme-tenant.invalid, copying ops-copy@acme-tenant.invalid.',
    );
    // The CC is stated as a COPY. Never as an assignment, a ticket or a send —
    // intake-side rules may route on the cc, but nothing here can observe that.
    const copy = text.toLowerCase();
    for (const claim of ['assign', 'ticket', 'sent', 'submitted', 'will be created']) {
      expect(copy).not.toContain(claim);
    }
  });

  it('the condensed notice comes from the SHARED core builder, so both surfaces say the same thing', () => {
    const prepared = prepareOrderDeliveryRequest(bigOrder(), RECIPIENTS);
    expect(shouldShowCondensedNotice(prepared)).toBe(true);
    // Not a re-typed sentence: the exact string web renders for this draft.
    expect(condensedNoticeText(prepared.draft)).toContain(
      `lists the first ${prepared.draft.listedLineCount} of ${prepared.draft.lineCount} lines`,
    );
  });

  it('the condensed notice is NOT shown for a draft that fits whole, nor for an oversized one', () => {
    expect(shouldShowCondensedNotice(prepareOrderDeliveryRequest(order(), RECIPIENTS))).toBe(false);
    // Oversized is the blocked state and OVERSIZED_MESSAGE owns that copy —
    // showing "this will open shortened" alongside "nothing can open" would
    // promise a link that is not offered.
    expect(shouldShowCondensedNotice(prepareOrderDeliveryRequest(oversizedOrder(), RECIPIENTS))).toBe(false);
  });
});

// =========================================================================
// THE TWO NOTICE GATES THE SCREEN USED TO RESTATE INLINE.
//
// `shouldWarnDuplicateDrafts` and `shouldShowBlockedNotice` were exported from
// this module, documented as living here BECAUSE the screen cannot be tested,
// and then imported by nothing: app/order/[id].tsx wrote `deliveryDraftCount >
// 1` and `deliveryResult?.outcome === 'blocked' && deliveryPrepared.linkFits`
// in its own JSX. One behaviour, two copies, and the copy that shipped was the
// one no test in this repo can reach — recurring pattern #26, in the exact
// module whose header says decisions live here so they can be tested.
//
// The two copies AGREED, character for character, so nothing was wrong on
// screen; what was wrong was that nothing would have noticed if they stopped
// agreeing. The screen calls these now, and the tests below are what makes the
// call worth something.
// =========================================================================

describe('the on-screen notice gates', () => {
  /**
   * The dialog and the standing line are DELIBERATELY off by one, and that is
   * the whole reason this is a named function rather than a numeral in the JSX:
   * `shouldConfirmBeforeOpening` asks before the second open (count 0 is the
   * first open and never asks), while this line only appears once a second
   * draft actually EXISTS. Warning about duplicates while exactly one draft
   * exists would be false, and the dialog has already done the asking.
   *
   * Asserted as a RELATIONSHIP over the whole range rather than at one point,
   * because the failure mode is not "wrong at 1" — it is the two thresholds
   * drifting into the same value, at which point the phone both asks and
   * accuses on the very first duplicate, or does neither.
   */
  it('the duplicate warning stays exactly one open behind the confirm dialog', () => {
    // No drafts, one draft: nothing to warn about yet.
    expect(shouldWarnDuplicateDrafts(0)).toBe(false);
    expect(shouldWarnDuplicateDrafts(1)).toBe(false);
    // A second draft exists. It is now a fact, not a risk.
    expect(shouldWarnDuplicateDrafts(2)).toBe(true);

    let confirmedOnly = 0;
    for (let n = 0; n <= 10; n += 1) {
      // The warning is exactly the dialog's own predicate, one open later.
      expect(shouldWarnDuplicateDrafts(n)).toBe(shouldConfirmBeforeOpening(n - 1));
      // Never the reverse: a count that warns must also have confirmed.
      if (shouldWarnDuplicateDrafts(n)) expect(shouldConfirmBeforeOpening(n)).toBe(true);
      if (shouldConfirmBeforeOpening(n) && !shouldWarnDuplicateDrafts(n)) confirmedOnly += 1;
    }
    // Exactly ONE count sits between the two thresholds — openCount 1, the
    // window where the dialog asks and the standing line is still silent. Zero
    // would mean they had collapsed onto the same number; two would mean the
    // line lags an extra open and a real duplicate goes unstated.
    expect(confirmedOnly).toBe(1);
  });

  /**
   * The blocked notice invites a retry. That is the right advice for an open
   * the OS refused and useless advice for a draft no link can ever carry, which
   * `OVERSIZED_MESSAGE` owns — so the AND is the point of the function, not
   * decoration. Driven over the full 2x3 space rather than at the true corner.
   */
  it('the blocked notice needs BOTH a refused open and a draft a link could have carried', () => {
    const fits = prepareOrderDeliveryRequest(order(), RECIPIENTS);
    const oversized = prepareOrderDeliveryRequest(oversizedOrder(), RECIPIENTS);
    expect(fits.linkFits).toBe(true);
    expect(oversized.linkFits).toBe(false);

    const results: [string, DeliveryOpenResult | null][] = [
      ['nothing attempted yet', null],
      ['opened natively', { outcome: 'opened', used: 'outlook-native' }],
      ['opened in the default mail app', { outcome: 'opened', used: 'default-mail' }],
      ['refused by the OS', { outcome: 'blocked', used: null }],
      // A swallowed double-tap. NOT a refusal: the first tap's open is still
      // in flight and will surface its own outcome, so showing retry copy for
      // the second tap would tell the user the send failed while it is
      // actually succeeding.
      ['swallowed while an open was in flight', { outcome: 'in_flight', used: null }],
    ];

    const seen: [string, string, boolean][] = [];
    for (const [draftLabel, prepared] of [
      ['a draft that fits', fits],
      ['a draft too long for any link', oversized],
    ] as const) {
      for (const [resultLabel, result] of results) {
        seen.push([draftLabel, resultLabel, shouldShowBlockedNotice(prepared, result)]);
      }
    }

    // Hand-written, one row per combination: the expectation is stated here
    // rather than recomputed from the same expression the function uses.
    expect(seen).toEqual([
      ['a draft that fits', 'nothing attempted yet', false],
      ['a draft that fits', 'opened natively', false],
      ['a draft that fits', 'opened in the default mail app', false],
      ['a draft that fits', 'refused by the OS', true],
      ['a draft that fits', 'swallowed while an open was in flight', false],
      ['a draft too long for any link', 'nothing attempted yet', false],
      ['a draft too long for any link', 'opened natively', false],
      ['a draft too long for any link', 'opened in the default mail app', false],
      // The one row that is easy to get wrong: nothing was opened because
      // nothing was offered, and telling this employee to try again would be a
      // retry that cannot work.
      ['a draft too long for any link', 'refused by the OS', false],
      ['a draft too long for any link', 'swallowed while an open was in flight', false],
    ]);
  });

  /**
   * The two failure copies are mutually exclusive BY VALUE, not by luck of
   * layout: the oversized line renders on `!linkFits` and the blocked card on
   * this gate, so if this gate ever dropped its `linkFits` term the phone would
   * show "nothing can open this" and "try again" one under the other.
   */
  it('the blocked notice and the oversized message can never appear together', () => {
    const blocked: DeliveryOpenResult = { outcome: 'blocked', used: null };
    for (const prepared of [
      prepareOrderDeliveryRequest(order(), RECIPIENTS),
      prepareOrderDeliveryRequest(bigOrder(), RECIPIENTS),
      prepareOrderDeliveryRequest(oversizedOrder(), RECIPIENTS),
    ]) {
      const showsOversized = !prepared.linkFits;
      expect(shouldShowBlockedNotice(prepared, blocked) && showsOversized).toBe(false);
    }
  });
});

// =========================================================================
// What this module ADDS to the shared mapping — which is only the recipients.
//
// THIS BLOCK USED TO BE CALLED "parity with the web surface", and its one test
// claimed a body "byte-identical to what the shared core builder produces".
// It imported no web code. It hand-assembled a web-SHAPED input right here in
// the mobile suite, reading the fixture's already-populated fields, and then
// compared core against core in one process — so it could not observe either of
// the two mappings that had actually drifted (the org-timezone default and the
// requester-email fallback operator), and both sat in the branch passing it.
//
// The real cross-surface test is
// apps/web/src/components/orders/delivery-request-parity.test.tsx, where web's
// service, web's order page and web's button mapping can all be driven for real
// and compared against core's mapping — the one this file re-exports — from a
// single database row. Mobile's vitest cannot reach apps/web at all, so no test
// in THIS suite can honestly make that claim.
//
// What this suite can still prove, and what these tests are named for, is the
// narrower fact the phone is responsible for: that it delegates, and adds
// exactly one thing.
// =========================================================================

describe('the phone adds only its recipients to the shared mapping', () => {
  it('buildDeliveryRequestInput is core\'s mapping plus the tenant recipients — nothing else', async () => {
    const { buildDeliveryRequestInput: coreMapping, DELIVERY_REQUEST_RECIPIENTS } =
      await import('@stockpilot/core');
    const o = order();
    const recipients = DELIVERY_REQUEST_RECIPIENTS;
    // Not "produces the same VALUES" — literally the same function's output.
    // A field the phone re-derived on its own would fail here.
    expect(buildDeliveryRequestInput(o, RECIPIENTS)).toEqual(coreMapping(o, recipients));
  });

  it('holds across every row shape the fallbacks care about, so the delegation is not fixture-deep', async () => {
    const { buildDeliveryRequestInput: coreMapping, DELIVERY_REQUEST_RECIPIENTS } =
      await import('@stockpilot/core');
    const recipients = DELIVERY_REQUEST_RECIPIENTS;
    let checked = 0;
    for (const requesterEmail of [null, '', 'onbehalf@site.org']) {
      for (const orgTimezone of [null, '', 'UTC', 'America/New_York']) {
        for (const requesterName of [null, '', 'Jane Smith']) {
          const o = order({ requesterEmail, orgTimezone, requesterName });
          expect({ requesterEmail, orgTimezone, requesterName, input: buildDeliveryRequestInput(o, RECIPIENTS) })
            .toEqual({ requesterEmail, orgTimezone, requesterName, input: coreMapping(o, recipients) });
          checked += 1;
        }
      }
    }
    expect(checked).toBe(36);
  });

  /**
   * THE BRAND HOLDS ACROSS THE WORKSPACE BOUNDARY, which is where the risk
   * actually lives: a new call site would be written in an app, importing the
   * type through the `@stockpilot/core` barrel, not inside core beside the
   * private symbol. If the brand were removed, this @ts-expect-error becomes an
   * unused directive and `pnpm typecheck` fails with TS2578 — in the mobile
   * app, not only in core.
   *
   * This is DEFECT 5 stated concretely: `cc: 'ops@somewhere.test'` is routable,
   * so every runtime guard in the feature accepts it by design. Only the type
   * system can refuse a wrong-but-well-formed address, and only before it is
   * written.
   */
  it('TYPE-LEVEL PIN: a third call site cannot hand-type its own recipients', () => {
    // @ts-expect-error a raw literal is missing core's module-private brand
    const forged: DeliveryRequestRecipients = {
      to: DELIVERY_REQUEST_EMAIL.to,
      cc: 'ops@somewhere.test',
    };
    expect(forged.cc).toBe('ops@somewhere.test');
  });

  /**
   * AND IT CANNOT SPREAD ONE EITHER — the form the mistake would actually take.
   * Nobody types four fields to misroute warehouse mail; they start from the
   * value that works and change the one field they mean to change. Under the
   * `unique symbol` brand this compiled clean here, in the app, with no cast:
   * spread reproduces symbol-keyed properties. Core's brand is a private class
   * member now, which spread cannot reproduce.
   *
   * Pinned in the MOBILE suite as well as core's because this is the workspace
   * where a third call site would be written — importing the type through the
   * `@stockpilot/core` barrel, nowhere near the brand's declaration.
   */
  it('TYPE-LEVEL PIN: nor SPREAD the working value into a wrong one', () => {
    // @ts-expect-error the spread drops core's private brand: TS2741
    const forged: DeliveryRequestRecipients = {
      ...DELIVERY_REQUEST_RECIPIENTS,
      cc: 'ops@somewhere.test',
    };
    expect(forged.cc).toBe('ops@somewhere.test');
  });

  it('the mandatory CC comes from the ONE core constant and survives onto the draft', async () => {
    const { DELIVERY_REQUEST_EMAIL_NAMES } = await import('@stockpilot/core');
    const prepared = prepareOrderDeliveryRequest(order(), RECIPIENTS);
    expect(prepared.draft.to).toBe(DELIVERY_REQUEST_EMAIL.to);
    expect(prepared.draft.cc).toBe('arosas@cvwest.org');
    expect(prepared.draft.ccName).toBe(DELIVERY_REQUEST_EMAIL_NAMES.cc);
  });
});
