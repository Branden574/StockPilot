import {
  DELIVERY_REQUEST_EMAIL,
  DELIVERY_REQUEST_RECIPIENTS,
  buildDeliveryRequestInput as coreBuildDeliveryRequestInput,
  prepareDeliveryRequest,
  type DeliveryComposeTransport,
  type DeliveryRequestAddress,
  type DeliveryRequestInput,
  type DeliveryRequestOrderData,
  type DeliveryRequestRecipients,
  type PreparedDeliveryRequest,
} from '@stockpilot/core';

import {
  mailtoPlan,
  planOutlookOpen,
  runPlan,
  type OpenedTransport,
  type OutlookPlatform,
  type OutlookTransportUrls,
} from './outlook-transport';

/** Warn before a SECOND draft for the same order, never block it. Shared
 *  predicate — see `./outlook-transport`; the warning text is per-feature
 *  because what a duplicate costs differs (here: a duplicate request to DC4). */
export { shouldConfirmBeforeOpening } from './outlook-transport';

/**
 * The delivery request, on the phone.
 *
 * WHAT THIS FILE IS FOR. `apps/mobile/vitest.config.ts` is
 * `environment: 'node'` with `include: ['src/**\/*.test.ts']` — one glob,
 * rooted at src/, `.ts` only. Nothing under `app/` and nothing `.tsx` can be
 * imported by a test, so a decision written inline in `app/order/[id].tsx`
 * would be untestable, and untestable decisions have silently shipped
 * regressions in this repo three times. So every decision this feature makes —
 * which orders offer the action, what input the shared builder gets, which URL
 * is opened, and every word the employee reads — is an exported function or
 * constant HERE. The screen reads `Platform.OS`, calls these, and renders what
 * they return.
 *
 * THE MESSAGE ITSELF IS NOT DEFINED HERE. `prepareDeliveryRequest` lives in
 * `@stockpilot/core` and is the same function the web storefront and the web
 * order page call. This module maps the phone's row shape onto that builder's
 * input and picks a transport; it composes no body, no subject, no disclosure,
 * and no recipient of its own. A second body builder is exactly the drift the
 * core extraction exists to prevent (recurring pattern #26), and the failure
 * would be silent: a delivery request that reaches DC4 with a stale format —
 * or without the mandatory CC — still looks delivered to whoever sent it.
 */

// ── The gate ─────────────────────────────────────────────────────────────

/**
 * Terminal statuses: an order that is completed, denied or cancelled has
 * nothing left to deliver. Carried over from the web page's own
 * `DELIVERY_REQUEST_BLOCKED` verbatim.
 */
export const DELIVERY_REQUEST_BLOCKED_STATUSES: readonly string[] = [
  'completed',
  'denied',
  'cancelled',
];

export interface DeliveryRequestGateInput {
  status: string | null;
  fulfillmentType: string | null;
  /** `order_requests.requester_user_id`. Null on rows with no linked user. */
  requesterUserId: string | null;
  viewerUserId: string | null;
  ordersModuleEnabled: boolean;
}

/**
 * Who sees the action, and on which orders.
 *
 * DELIBERATELY IDENTICAL to the web order page's `showDeliveryRequest`
 * (`app/(dashboard)/dashboard/orders/[id]/page.tsx`): the viewer must be the
 * order's own requester, the order must be a delivery, and its status must not
 * be terminal. Plus the orders module, which mobile gates every order
 * affordance on and web gets from its route.
 *
 * The requester-only rule is worth stating because it is easy to read as an
 * oversight: a warehouse manager looking at someone else's delivery order does
 * NOT get this button, on either surface. Widening it on the phone alone would
 * mean the two surfaces disagree about who may mail DC4, which is a policy
 * change wearing a bug fix's clothes — it belongs to the owner, not to this
 * task. Flagged in the hand-off rather than decided here.
 *
 * Cosmetic only in the sense that it decides what to SHOW; unlike the order
 * mutations next to it on screen, there is no server route re-asserting
 * anything, because the action's whole effect is opening a mail draft on the
 * employee's own device.
 */
export function canRequestDelivery(gate: DeliveryRequestGateInput): boolean {
  if (!needsDeliveryRequestData(gate)) return false;
  if (!gate.ordersModuleEnabled) return false;
  // A null requester matches no viewer — never `null === null`, which would
  // hand the action to every viewer of an unowned order.
  return gate.requesterUserId !== null && gate.requesterUserId === gate.viewerUserId;
}

/**
 * Should `load()` spend the two extra reads (destination charter + org
 * timezone) that only the delivery request needs?
 *
 * ROW-DERIVED ONLY, deliberately: `load` must not re-run when auth or module
 * state settles, so this cannot look at the viewer. That makes it strictly
 * WIDER than `canRequestDelivery` — a live delivery order someone else
 * requested pays for two reads it will not use, which is the cheap direction to
 * be wrong in.
 *
 * Being wrong in the OTHER direction is the expensive one, and is why this is a
 * function here instead of a status list retyped inline in the screen (which is
 * what it was, and is recurring pattern #26): a fetch gate NARROWER than the
 * display gate shows the button on an order whose destination and timezone were
 * never loaded, and the employee mails DC4 a draft that silently omits the
 * delivery site. `canRequestDelivery` is now defined in terms of this, so the
 * two cannot drift apart by construction, and the implication is asserted over
 * the whole input space in the tests.
 */
export function needsDeliveryRequestData(
  row: Pick<DeliveryRequestGateInput, 'status' | 'fulfillmentType'>,
): boolean {
  if (row.fulfillmentType !== 'delivery') return false;
  return row.status !== null && !DELIVERY_REQUEST_BLOCKED_STATUSES.includes(row.status);
}

// ── The input mapping ────────────────────────────────────────────────────

/**
 * The row shape and the mapping BOTH live in core now (2026-08-13) — see
 * `packages/core/src/orders/delivery-request-input.ts`. Re-exported here so the
 * screen and this module's tests keep their existing imports, and so the phone
 * cannot acquire a second opinion about what a row means.
 *
 * The move was not tidying. Web's mapping and this one had drifted on two
 * fields — the org timezone default (UTC vs Pacific: two different needed-by
 * times, and two different DATES after 16:00 Pacific, for one order) and the
 * requester-email fallback operator (`??` vs `||`) — and no test in either
 * suite could see it, because neither app can import the other. With one
 * mapping there is nothing left to drift, and the web suite drives THIS code
 * against web's own resolution path in
 * `apps/web/src/components/orders/delivery-request-parity.test.tsx`.
 */
export type {
  DeliveryRequestOrderData,
  DeliveryRequestOrderLine,
} from '@stockpilot/core';

/**
 * `charters.address` is jsonb, so the value can be anything at all — null for
 * 4 of 16 prod charters, an object for the rest, and in principle a scalar or
 * an array. Mirrors the web page's identical defensive mapping: anything that
 * is not a plain object is "no address", and the builder then prints NOTHING
 * rather than an "Address:" heading with nothing under it.
 */
export function parseCharterAddress(raw: unknown): DeliveryRequestAddress | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return raw as DeliveryRequestAddress;
}

/**
 * WHERE THIS TENANT'S DELIVERY MAIL GOES. From the ONE core VALUE, never from
 * anything on the order row, a route parameter or a server payload — nothing a
 * user typed can redirect this mail or split off the mandatory CC.
 *
 * This was an object literal assembled here from the two address constants
 * until 2026-08-13. It agreed with web's literal, and both were pinned — but
 * the SHAPE invited a third literal that would have compiled clean with a wrong
 * cc. `DeliveryRequestRecipients` is branded now, so a literal no longer
 * typechecks anywhere and there is exactly one value to import. Supplying it
 * HERE rather than reading it inside the core mapping is unchanged: core stays
 * tenant-neutral, and `dc4@learn4life.org` stays a call-site fact.
 */
const MOBILE_DELIVERY_RECIPIENTS: DeliveryRequestRecipients = DELIVERY_REQUEST_RECIPIENTS;

/**
 * Map the order row onto the shared builder's input.
 *
 * THE MAPPING ITSELF IS NOT DEFINED HERE any more (2026-08-13). It is core's
 * `buildDeliveryRequestInput`, which web's parity test drives directly; this
 * adds only the recipients. Every rule the mapping applies — absent data stays
 * absent, the timezone resolves through `resolveOrgTimezone`, the requester
 * fields through `resolveRequesterIdentity`, null-item lines are dropped, and
 * `fulfillmentType` is a literal — is documented on the core function.
 */
export function buildDeliveryRequestInput(order: DeliveryRequestOrderData): DeliveryRequestInput {
  return coreBuildDeliveryRequestInput(order, MOBILE_DELIVERY_RECIPIENTS);
}

// ── Which compose url this phone will actually open ──────────────────────

/**
 * THE ONE ANSWER that decides BOTH which url the item-row ladder is measured
 * against and which url `openDeliveryRequestDraft` hands to the OS.
 *
 * THE DEFECT THIS CLOSES (2026-08-13). Core's ladder fitted every rung against
 * the https OWA url, because that is what web opens. A phone with Outlook
 * installed opens `ms-outlook://compose`, which for the same body is roughly
 * 25-30% shorter — one encoding layer onto a 20-character scheme, against a
 * double-encoded inner mailto onto a 52-character https base. Measured on a
 * realistic 25-line order, the web-fitted ladder stopped at 7 rows and left the
 * native url at 1303 of 1800 characters: 497 characters of headroom, about
 * eight item rows, thrown away. DC4 got a delivery request naming 7 items when
 * 15 fitted. That is the same complaint that started this feature — rows
 * dropped that did not need to be — one layer down.
 *
 * THE ORDERING PROBLEM, AND HOW IT IS RESOLVED. Whether Outlook is installed is
 * a runtime question (`Linking.canOpenURL`), and the draft is prepared in a
 * render memo — before any tap, and initially before the probe has resolved.
 * Preparing against the SHORTER native budget and then opening the WEB url
 * would silently truncate the body, which is worse than dropping a row. So:
 *
 *   - `null` — not probed yet, or the probe threw — means WORST CASE. The web
 *     budget is measured AND the web url is what opens, because that is what
 *     `planOutlookOpen` does with `nativeOutlookAvailable: false`. A tap during
 *     that window is fully consistent; it just carries fewer rows.
 *   - `true` — the probe answered yes. The native budget is measured and the
 *     native url is what opens.
 *   - `false` — no native app. Web budget, web url.
 *
 * The screen probes ONCE and holds the answer in state, feeding that same value
 * to `prepareOrderDeliveryRequest` and to `openDeliveryRequestDraft`. Both read
 * it through THIS function, so measurement and plan cannot disagree: to break
 * the pairing you would have to change this one predicate, which changes both
 * sides together. That is why `openDeliveryRequestDraft` no longer re-probes —
 * a second `canOpenURL` at press time could answer differently from the one the
 * ladder was fitted against, and the disagreement would be invisible.
 */
export function deliveryComposeTransport(
  nativeOutlook: boolean | null,
): DeliveryComposeTransport {
  return nativeOutlook === true ? 'outlook-native' : 'outlook-web';
}

/**
 * The whole draft, prepared by the SHARED core builder. Pure and deterministic
 * — safe to call from a render memo, which is where it runs.
 *
 * `nativeOutlook` is the screen's probe answer; see `deliveryComposeTransport`
 * for why it defaults to `null` (worst case) rather than to `true`.
 */
export function prepareOrderDeliveryRequest(
  order: DeliveryRequestOrderData,
  nativeOutlook: boolean | null = null,
): PreparedDeliveryRequest {
  return prepareDeliveryRequest(buildDeliveryRequestInput(order), {
    transport: deliveryComposeTransport(nativeOutlook),
  });
}

// ── The transport ────────────────────────────────────────────────────────

/** Which BUTTON the employee pressed. Not the same thing as the transport
 *  that ends up carrying the draft — see `OpenedTransport`. */
export type DeliveryEmailTransport = 'outlook' | 'mailto';

/** `used` is the transport that ACTUALLY carried the draft, and is null for
 *  anything that did not open — so no caller can report a blocked attempt as
 *  a particular app having opened. */
export interface DeliveryOpenResult {
  outcome: 'opened' | 'blocked';
  used: OpenedTransport | null;
}

/**
 * Open the draft. Same planner and same one-open-per-tap rule as the
 * maintenance path — literally the same functions, from `./outlook-transport`,
 * so the CC-safety remediation lever (`NATIVE_OUTLOOK_CC_TRUSTED`) covers both
 * features at once.
 *
 * `nativeOutlook` IS THE PROBE ANSWER, PASSED IN — it is not re-probed here.
 * That is deliberate and it is the point of this change: the same value must
 * decide which url the ladder was MEASURED against and which url is OPENED, or
 * the phone can fit rows for one transport and then send another. Both sides
 * read it through `deliveryComposeTransport`. `null` (not yet probed) behaves
 * exactly as `false`: the web url, which is the one the worst-case budget
 * measured. The probe itself is `nativeOutlookAvailable` in
 * `./outlook-transport`, called once by the screen.
 *
 * Refuses everything when `!prepared.linkFits`: past roughly 2,000 characters
 * both transports truncate SILENTLY, so opening would hand DC4 a delivery
 * request cut off mid-sentence with no signal to anyone. The copy panel, which
 * always carries the complete uncondensed body, is the honest transport there.
 *
 * `onOpened` fires only after a real, successful open — never before one and
 * never instead of one — so a blocked attempt can never be recorded, counted
 * or announced as a draft.
 *
 * `ccTrusted` is injectable for tests only; production always uses the
 * shared default. Its reroute lands on `mailtoUrl`, which core measures under
 * BOTH budgets, so that branch is safe whichever transport was fitted.
 */
export async function openDeliveryRequestDraft(
  button: DeliveryEmailTransport,
  prepared: OutlookTransportUrls,
  platform: OutlookPlatform,
  nativeOutlook: boolean | null,
  onOpened: () => void,
  ccTrusted?: Record<OutlookPlatform, boolean>,
): Promise<DeliveryOpenResult> {
  if (!prepared.linkFits) return { outcome: 'blocked', used: null };
  const plan =
    button === 'outlook'
      ? planOutlookOpen(
          prepared,
          {
            // Through the SAME predicate the measurement used. Not
            // `nativeOutlook === true` written out again: a second copy of the
            // rule is a second thing to forget to change (pattern #26).
            nativeOutlookAvailable: deliveryComposeTransport(nativeOutlook) === 'outlook-native',
            platform,
          },
          ccTrusted,
        )
      : mailtoPlan(prepared);
  const outcome = await runPlan(plan);
  if (outcome === 'opened') onOpened();
  return { outcome, used: outcome === 'opened' ? plan.transport : null };
}

/**
 * Gates the "this was shortened" notice. Requires BOTH `draft.condensed` AND
 * `linkFits` — a condensed draft that STILL doesn't fit is the oversized state
 * (`OVERSIZED_MESSAGE` owns that copy and no link is offered at all), never
 * the condensed notice, which promises a usable email button.
 */
export function shouldShowCondensedNotice(prepared: PreparedDeliveryRequest): boolean {
  return prepared.draft.condensed && prepared.linkFits;
}

/**
 * Gates the PERSISTENT duplicate warning on screen, as distinct from the
 * one-shot confirm dialog.
 *
 * `shouldConfirmBeforeOpening` fires the dialog before the SECOND open
 * (openCount > 0). This line stays on screen once a second draft actually
 * exists (openCount > 1), so the two are deliberately off by one: warning about
 * duplicates while exactly one draft exists would be false, and the dialog has
 * already done the asking.
 *
 * Here rather than as a `> 1` written into the JSX, because a bare numeric
 * comparison in a `.tsx` under `app/` is unreachable by this repo's mobile
 * vitest — and an off-by-one between these two thresholds is invisible on
 * screen until someone mails DC4 twice.
 */
export function shouldWarnDuplicateDrafts(openCount: number): boolean {
  return openCount > 1;
}

/**
 * Gates the blocked-open card.
 *
 * A blocked open and an oversized draft are DIFFERENT failures with different
 * copy and different remedies — `BLOCKED_HEADLINE` invites a retry, which is
 * useless advice for a draft no link can ever carry, and `OVERSIZED_MESSAGE`
 * owns that case. Showing both at once would offer a retry that cannot work.
 */
export function shouldShowBlockedNotice(
  prepared: PreparedDeliveryRequest,
  result: DeliveryOpenResult | null,
): boolean {
  return result?.outcome === 'blocked' && prepared.linkFits;
}

// ── Copy ─────────────────────────────────────────────────────────────────
// Named exports rather than inline JSX strings, so the screen cannot invent
// its own wording and a mutation to any of these fails a test by name. The
// CONDENSED notice is deliberately absent from this list: it comes from
// core's `condensedNoticeText`, so the sentence the employee reads about how
// many lines were listed is generated by the same module that decided it.

/** Shown after a real open that was carried by Outlook (native or web). */
export const SUCCESS_MESSAGE =
  'Outlook opened with your delivery request. Review the message and press Send yourself.';

/** The same promise for the case where the device's default mail app opened
 *  instead — the mailto button, and the cc-safety reroute in `planOutlookOpen`.
 *  Naming Outlook here would be a plain untruth. */
export const MAIL_APP_SUCCESS_MESSAGE =
  'Your email app opened with your delivery request. Review the message and press Send yourself.';

/** Picks the honest confirmation for the transport that actually ran. A null
 *  transport (nothing opened) never reaches the success card; it falls back to
 *  the Outlook wording only so the type is total. */
export function deliverySuccessMessageFor(used: OpenedTransport | null): string {
  return used === 'default-mail' ? MAIL_APP_SUCCESS_MESSAGE : SUCCESS_MESSAGE;
}

/**
 * The standing honesty line, rendered before any tap — not a toast, which
 * disappears. StockPilot opens a draft; it does not send it and cannot observe
 * whether DC4's intake ever received anything, so it must never claim either.
 * Same position web's `delivery-request-notice` paragraph takes.
 */
export const HONESTY_NOTICE =
  'This opens a draft email. StockPilot does not send it. Review the message and press Send in your mail app.';

/** Web's own repeat-draft wording, kept in step: a second draft to DC4 is a
 *  second real request, and nothing here can detect that the first was sent. */
export const DUPLICATE_WARNING =
  'You have already opened a draft for this order. Sending more than one creates duplicate requests for DC4.';

/** The ONLY headline for a blocked open. Never blames link length for a
 *  genuinely refused open — that is what OVERSIZED_MESSAGE is for. */
export const BLOCKED_HEADLINE = 'The email draft could not be opened automatically.';

/** Direction-free on purpose, so a future layout reorder cannot make it wrong
 *  the way a "below" once did on the maintenance screen. */
export const BLOCKED_RETRY_MESSAGE =
  'Your order is saved — try again, or use Copy details instead.';

/** Shown when `!prepared.linkFits`: even the shortened draft exceeds the safe
 *  URL length, so neither email button is offered alongside this. */
export const OVERSIZED_MESSAGE =
  'This order is too long for an email link, even shortened. Use Copy details — it always includes the full message.';

/** There is no clipboard module in this binary, so the selectable box IS the
 *  copy affordance rather than a fallback for a failed programmatic copy. */
export const COPY_HELPER_TEXT = 'Press and hold inside the box to select and copy.';

/** Helper line under the action, naming both recipients. Accuracy, not
 *  optimism: the CC is stated as a copy, never as an assignment or a ticket. */
export const RECIPIENTS_HELPER_TEXT = `Opens a draft to ${DELIVERY_REQUEST_EMAIL.to}, copying ${DELIVERY_REQUEST_EMAIL.cc}.`;
