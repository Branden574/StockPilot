import {
  buildDeliveryRequestInput as coreBuildDeliveryRequestInput,
  deliveryRecipientsForRouting,
  parseOrgEmailRouting,
  prepareDeliveryRequest,
  type DeliveryComposeTransport,
  type DeliveryRequestAddress,
  type DeliveryRequestInput,
  type DeliveryRequestOrderData,
  type DeliveryRequestRecipients,
  type OrgEmailRoutingReadState,
  type PreparedDeliveryRequest,
} from '@stockpilot/core';

import {
  composeTransportForProbe,
  openMeasuredDraft,
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

// ── The org's routing (per-org email routing, migration 0337) ────────────

/**
 * Is this Supabase/PostgREST error the MISSING-COLUMN error (Postgres 42703,
 * undefined_column)?
 *
 * DEPLOY-ORDER SAFETY: this feature must FAIL OPEN to pre-feature behavior
 * during the code-before-migration window. An OTA'd binary selecting
 * `email_routing` against a database where migration 0337 has not landed
 * errors the WHOLE select with 42703 — and ONLY that error may be read as
 * "retry without the column and use the compiled constants" (the screen
 * retries with `'timezone'` alone and records routing as `{ state:
 * 'fallback' }`, which `deliveryRecipientsForRouting` maps to the compiled
 * L4L pair, byte-identical to what shipped before the feature). Once the
 * column exists this predicate is never true; any OTHER error means the org
 * row could not be read at all, and the routing stays 'unset' — the action
 * hides rather than composing mail against recipients nothing validated.
 * Mirrors web's `getOrgEmailRouting` (cached-org.ts) exactly.
 */
export function isMissingEmailRoutingColumn(
  error: { code?: string | null | undefined } | null | undefined,
): boolean {
  return error?.code === '42703';
}

/**
 * Resolve the DELIVERY routing off the org row the screen already reads
 * (`organizations.timezone, email_routing` — an RLS member read; the TO/CC
 * are printed in the email UI, so they are not secrets).
 *
 * The parse IS core's one parser (`parseOrgEmailRouting`), which runs the
 * stored value through the branded `deliveryRequestRecipients` factory — a
 * stored value is client-influenced data, and an org admin can write
 * anything through PostgREST, which is exactly what the factory exists for.
 * A missing row (RLS refused, transient failure) is 'unset': the action
 * hides, fail closed, never the compiled constants — those would silently
 * mail another tenant's warehouse.
 */
export function deliveryRoutingFromOrgRow(
  row: { email_routing?: unknown } | null | undefined,
): OrgEmailRoutingReadState {
  if (!row) return { state: 'unset' };
  return parseOrgEmailRouting(row.email_routing, 'delivery_request');
}

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
  /**
   * The org's resolved delivery-request routing (see
   * `deliveryRoutingFromOrgRow`). The action renders ONLY when this maps to
   * a routable pair — 'valid' (the stored, factory-validated recipients) or
   * 'fallback' (the pre-migration deploy window, compiled constants).
   * 'unset' and 'invalid' HIDE the action, exactly as the web order page
   * does (`showDeliveryRequest && deliveryRequestRecipientsDto`): an
   * unconfigured org gets no button, and an invalid stored value fails
   * CLOSED rather than silently mailing another tenant's warehouse.
   */
  routing: OrgEmailRoutingReadState;
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
  // The routing gate (per-org email routing, migration 0337): the WHOLE
  // fallback matrix is core's `deliveryRecipientsForRouting` — compiled
  // constants only for the pre-migration 'fallback' state, the stored pair
  // for 'valid', null (hidden) for 'unset'/'invalid'. Deciding through the
  // same mapping the compose path uses means the gate and the draft can
  // never disagree about whether a routable pair exists.
  if (deliveryRecipientsForRouting(gate.routing) === null) return false;
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
 * Map the order row onto the shared builder's input.
 *
 * THE MAPPING ITSELF IS NOT DEFINED HERE any more (2026-08-13). It is core's
 * `buildDeliveryRequestInput`, which web's parity test drives directly; this
 * adds only the recipients. Every rule the mapping applies — absent data stays
 * absent, the timezone resolves through `resolveOrgTimezone`, the requester
 * fields through `resolveRequesterIdentity`, null-item lines are dropped, and
 * `fulfillmentType` is a literal — is documented on the core function.
 *
 * WHERE THE RECIPIENTS COME FROM (per-org email routing, migration 0337).
 * Until 2026-08-16 this module pinned the ONE compiled core value
 * (`DELIVERY_REQUEST_RECIPIENTS` — L4L's mailboxes) here, which was the
 * multi-tenant leak: every org's phones composed mail to one tenant's live
 * intake. `recipients` is now an explicit parameter, and the only value the
 * screen can hold is one that came out of `deliveryRecipientsForRouting(
 * deliveryRoutingFromOrgRow(row))` — the org's stored pair, run through the
 * branded factory (or, ONLY in the pre-migration deploy window, the compiled
 * fallback). The brand is what keeps this honest: a raw literal, a value off
 * the order row, a route parameter or a server payload does not typecheck,
 * so nothing a user typed can redirect this mail or split off the mandatory
 * CC.
 */
export function buildDeliveryRequestInput(
  order: DeliveryRequestOrderData,
  recipients: DeliveryRequestRecipients,
): DeliveryRequestInput {
  return coreBuildDeliveryRequestInput(order, recipients);
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
 * The screen probes ONCE, holds the answer in state, and hands it to
 * `prepareOrderDeliveryRequest` — and to NOTHING ELSE. `openDeliveryRequestDraft`
 * does not take a probe answer at all: it reads `transport` off the prepared
 * draft, which is the field the ladder stamped when it measured. See that
 * function for why the pairing is a signature rather than a convention.
 */
export function deliveryComposeTransport(
  nativeOutlook: boolean | null,
): DeliveryComposeTransport {
  // The rule itself is shared with the maintenance email (2026-08-16) — see
  // `composeTransportForProbe`. This export stays because it is this
  // feature's documented name for it, and because the doc above is the
  // delivery-specific record of WHY null must mean worst case.
  return composeTransportForProbe(nativeOutlook);
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
  recipients: DeliveryRequestRecipients,
  nativeOutlook: boolean | null = null,
): PreparedDeliveryRequest {
  return prepareDeliveryRequest(buildDeliveryRequestInput(order, recipients), {
    transport: deliveryComposeTransport(nativeOutlook),
  });
}

// ── The transport ────────────────────────────────────────────────────────

/** Which BUTTON the employee pressed. Not the same thing as the transport
 *  that ends up carrying the draft — see `OpenedTransport`. */
export type DeliveryEmailTransport = 'outlook' | 'mailto';

/** `used` is the transport that ACTUALLY carried the draft, and is null for
 *  anything that did not open — so no caller can report a blocked attempt as
 *  a particular app having opened. `in_flight` is the double-tap swallow —
 *  a call that arrived while an earlier open was unresolved fired no openURL
 *  and no `onOpened` (so no counted draft, and no second request to DC4);
 *  see `composeOpenInFlight` in ./outlook-transport. */
export interface DeliveryOpenResult {
  outcome: 'opened' | 'blocked' | 'in_flight';
  used: OpenedTransport | null;
}

/**
 * A prepared draft, as the OPENER needs it: the three composed urls, whether
 * any of them may be opened, and — the point of this type — WHICH ONE THE
 * LADDER MEASURED.
 *
 * `PreparedDeliveryRequest` satisfies this structurally; the opener takes the
 * narrower shape for the same reason `planOutlookOpen` does, so it never sees
 * the body.
 */
export interface DeliveryDraftToOpen extends OutlookTransportUrls {
  /** Stamped by core's ladder when it fitted the rows. Not a second opinion —
   *  the record of the budget the body was actually measured against. */
  transport: DeliveryComposeTransport;
}

/**
 * Open the draft. Same planner and same one-open-per-tap rule as the
 * maintenance path — literally the same functions, from `./outlook-transport`,
 * so the CC-safety remediation lever (`NATIVE_OUTLOOK_CC_TRUSTED`) covers both
 * features at once.
 *
 * THERE IS NO PROBE ARGUMENT, and that is the whole design (2026-08-13, second
 * pass). The url this opens must be the url the item-row ladder was MEASURED
 * against; if the two ever diverge the phone opens a body nothing measured and
 * the mail truncates in transit, silently — worse than the dropped rows this
 * wave set out to fix. That used to be a CONVENTION: the screen held one
 * `nativeOutlook` state and was trusted to pass the same value to
 * `prepareOrderDeliveryRequest` and to this function. Two arguments in two
 * places, in a `.tsx` under `app/` that this repo's vitest cannot reach — the
 * one decision on the screen worth guarding, guarded by a comment.
 *
 * So the argument is gone. `transport` is read off the prepared draft itself,
 * where core's ladder stamped it while fitting the rows. Measurement and plan
 * are now the same object, and there is no second value to disagree with: to
 * open an unmeasured url a caller would have to prepare a whole second draft
 * and open THAT — which is still self-consistent, because its urls and its
 * `transport` came from one measurement too.
 *
 * `deliveryComposeTransport` still owns the probe-answer rule (`null` means
 * worst case); it is now called in exactly one place, `prepareOrderDeliveryRequest`.
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
  prepared: DeliveryDraftToOpen,
  platform: OutlookPlatform,
  onOpened: () => void,
  ccTrusted?: Record<OutlookPlatform, boolean>,
): Promise<DeliveryOpenResult> {
  // The stamp-following open lives in `openMeasuredDraft` since 2026-08-16,
  // when the maintenance opener adopted the identical shape — one body, two
  // feature-named entry points, so the linkFits refusal, the
  // no-probe-at-press-time rule and the onOpened-after-real-open ordering
  // cannot drift between the two features.
  return openMeasuredDraft(button, prepared, platform, onOpened, ccTrusted);
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
 *
 * CALLED BY `app/order/[id].tsx`, and it must stay that way. Until 2026-08-13
 * this was exported, documented exactly as above, and imported by nothing,
 * while the screen wrote the `> 1` inline — the duplication this comment
 * argues against, in the module that argues against it (recurring pattern
 * #26). If it ever shows up as an unused export again, the fix is to restore
 * the call, not to delete the function.
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
 *
 * CALLED BY `app/order/[id].tsx`. Same history as `shouldWarnDuplicateDrafts`
 * above: exported, unused, and restated inline in the screen until 2026-08-13.
 * The `linkFits` term is the whole content of the function — a copy of this
 * condition that loses it looks identical in review and is only visible on a
 * device, on the one order whose draft nothing can carry.
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

/** Web's own repeat-draft wording, kept in step: a second draft is a second
 *  real request, and nothing here can detect that the first was sent.
 *  "the warehouse", not a tenant's warehouse name — recipients are per-org
 *  data now (migration 0337), so naming one org's intake here would state a
 *  falsehood on every other org's screens (same genericization web made). */
export const DUPLICATE_WARNING =
  'You have already opened a draft for this order. Sending more than one creates duplicate requests for the warehouse.';

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

/**
 * Helper line under the action, naming both recipients. Accuracy, not
 * optimism: the CC is stated as a copy, never as an assignment or a ticket.
 *
 * A PURE FUNCTION of the recipients since 2026-08-16 (per-org email routing):
 * a fixed sentence naming one tenant's mailboxes would state a checkable
 * falsehood on every other org's screens. The screen calls this with the
 * SAME resolved value it composes with, so the sentence and the draft can
 * never name different mailboxes.
 */
export function recipientsHelperText(recipients: { to: string; cc: string }): string {
  return `Opens a draft to ${recipients.to}, copying ${recipients.cc}.`;
}
