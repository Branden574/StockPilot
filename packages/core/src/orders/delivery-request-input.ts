/**
 * The ORDER ROW -> builder input mapping for a delivery request.
 *
 * WHY THIS IS IN CORE (moved here 2026-08-13 from
 * `apps/mobile/src/lib/delivery-request-actions.ts`).
 *
 * `buildDeliveryRequestDraft` already lived in core, so both surfaces composed
 * the same message from the same input. What nothing shared was the step
 * BEFORE that: turning an `order_requests` row into that input. Web did it
 * across its service and its button props; mobile did it in one function on the
 * phone. Two mappings, one builder — and the two mappings drifted in exactly
 * the way a shared builder cannot protect against, because by the time the
 * builder runs the damage is already in its argument:
 *
 *   - the org timezone fell back to UTC on one surface and Pacific on the
 *     other, so one order stated two different needed-by times (and, after
 *     16:00 Pacific, two different DATES) in mail to the same warehouse;
 *   - the requester email used `??` on one side and `||` on the other, so an
 *     empty-string column named a reachable contact on one surface and no
 *     contact at all on the other.
 *
 * Neither is expressible from here. Both fields resolve through ONE exported
 * function each (`resolveOrgTimezone`, `resolveRequesterIdentity`), and this
 * module is the single place a delivery-request input is assembled from a row.
 *
 * IT ALSO MAKES THE PARITY CLAIM TESTABLE, which is the other half of the
 * reason. The mobile suite cannot import `apps/web`, and the web suite cannot
 * import `apps/mobile` without dragging Expo into a jsdom runner — so the test
 * that called itself "parity with the web surface" was comparing core against
 * core inside the mobile suite and could not observe either divergence above.
 * With the mapping here, `apps/web/src/components/orders/
 * delivery-request-parity.test.tsx` drives WEB's real resolution path — its
 * service, its order page, its button mapping — and THIS mapping from one
 * database row, and compares the two inputs field by field. Mobile re-exports
 * this verbatim, so what that test drives is what the phone runs.
 *
 * Pure TS, no React, no DOM, no network. Safe under Hermes.
 */

import type { OrderLineQuantity } from './cart-totals';
import type {
  DeliveryRequestInput,
  DeliveryRequestItemRef,
  DeliveryRequestRecipients,
  DeliveryRequestSite,
} from './delivery-request';
import type { OrderSummary } from './place-order';
import { resolveRequesterIdentity } from './requester-identity';
import { resolveOrgTimezone } from '../time/org-timezone';

export interface DeliveryRequestOrderLine {
  /** `order_request_lines.item_id`. Null rows are dropped — see below. */
  itemId: string | null;
  name: string;
  sku: string | null;
  requested: number;
}

/**
 * An order as the surfaces actually hold it: the nullability the database hands
 * the columns over in, plus the two joined values (`requesterProfileEmail`, and
 * the surface's own already-resolved display label) that the fallbacks need.
 *
 * Mapping happens in one place so a missing column is a type error rather than
 * a blank line in an email nobody reads until DC4 asks what happened.
 */
export interface DeliveryRequestOrderData {
  id: string;
  orderNumber: number | null;
  warehouseName: string | null;
  /** `order_requests.requester_name` — the on-behalf-of name when present. */
  requesterName: string | null;
  /**
   * The surface's already-resolved display label, used when the denormalized
   * name is absent. Web's `requesterDisplay`, mobile's `resolveRequesterLabel`.
   *
   * Deliberately NOT the profile's full name: each surface builds this label
   * with its own last-resort wording ("(team member)", "External requester ·
   * Clovis"), and those are display decisions that belong to the surface. What
   * belongs here is the RULE for choosing between the column and the label,
   * which is the thing that drifted.
   */
  requesterLabel: string | null;
  /** `order_requests.requester_email`; NULL on internal self-submits. */
  requesterEmail: string | null;
  /** The joined `user_profiles.email`, which is what makes internal orders
   *  reachable at all. */
  requesterProfileEmail: string | null;
  /** `order_requests.needed_by` — a timestamptz ISO instant, or null. */
  neededBy: string | null;
  notes: string | null;
  destination: DeliveryRequestSite | null;
  /** RAW `organizations.timezone`, exactly as read. Never pre-defaulted by the
   *  caller: `resolveOrgTimezone` owns that answer, and a surface that
   *  substitutes its own first is how the two zones diverged. */
  orgTimezone: string | null;
  lines: DeliveryRequestOrderLine[];
}

/**
 * Map an order row onto the shared builder's input.
 *
 * ABSENT DATA IS REPRESENTED AS ABSENT. Every blank here is an empty string or
 * a null, never a stand-in that reads like real data — the builder owns the
 * honest admissions ("(warehouse not recorded)", "(requester not recorded)")
 * and states them in one voice across both surfaces. Inventing a value here
 * would launder a gap into something DC4 would act on.
 *
 * The one field with a real default is `orgTimezone`: a delivery time printed
 * in no zone at all is worse than one printed in the documented fallback. That
 * default is `resolveOrgTimezone`'s, not this function's.
 *
 * `recipients` is a PARAMETER rather than a constant read from
 * `./delivery-request-recipients`, for the same reason
 * `buildDeliveryRequestDraft` takes one: `dc4@learn4life.org` is one customer's
 * mailbox and a shared package must not hard-wire every org's warehouse mail to
 * it. The literal still has exactly one home, so the surfaces cannot drift.
 */
export function buildDeliveryRequestInput(
  order: DeliveryRequestOrderData,
  recipients: DeliveryRequestRecipients,
): DeliveryRequestInput {
  // Lines with no item id are dropped, exactly as the web page's
  // `l.item ? [...] : []` flatMap does — a line with no item cannot be named
  // in the body and would otherwise inflate the counts the disclosure quotes.
  const lines = order.lines.filter(
    (l): l is DeliveryRequestOrderLine & { itemId: string } => l.itemId !== null,
  );

  return {
    recipients,
    orderId: order.id,
    orderNumber: order.orderNumber,
    // A literal, not the row's `fulfillment_type`. Both surfaces only offer
    // this action on delivery orders, and a literal keeps a future caller from
    // quietly producing a destination-less "delivery" draft.
    fulfillmentType: 'delivery',
    warehouseName: order.warehouseName ?? '',
    destination: order.destination,
    // `||` via the shared resolver, never `??`: an empty-string
    // `requester_name` is an absent name, and letting it win discards the
    // display label the surface already resolved. `?? ''` because the builder's
    // input takes a string and turns a blank into "(requester not recorded)".
    requestedFor: resolveRequesterIdentity(order.requesterName, order.requesterLabel) ?? '',
    // THE CONTACT DC4 CAN ACTUALLY REACH. `requester_email` is NULL on
    // internal self-submitted orders — 46 of 103 prod rows — while the joined
    // `user_profiles.email` is populated. Without this fallback the common case
    // drafts with no requester email at all and the recipient cannot reply.
    requesterEmail: resolveRequesterIdentity(order.requesterEmail, order.requesterProfileEmail),
    // Passed through untouched: the builder runs it through `new Date(...)`
    // and prints it in the org zone with the zone named. An ISO instant is as
    // valid here as the storefront's datetime-local value.
    neededByLocal: order.neededBy ?? '',
    orgTimezone: resolveOrgTimezone(order.orgTimezone),
    notes: order.notes ?? '',
    lines: lines.map((l) => ({ itemId: l.itemId, quantity: l.requested })),
    // Only name and sku ever cross into the builder — `DeliveryRequestItemRef`
    // is closed at the type level so no staff-only field (cost, price) can
    // reach a message that leaves the building.
    itemMap: new Map(lines.map((l) => [l.itemId, { name: l.name, sku: l.sku ?? '' }])),
  };
}

// ── From a submission (phone ordering PO-1) ────────────────────────────────

/**
 * What the success screen knows besides the placed order: the setup the
 * person chose and the body they sent (frozen with the key). Every field is
 * what the web success overlay passes today (storefront-overlays.tsx, the
 * DeliveryRequestAction input), so the phone's draft and the web's are the
 * same message.
 */
export interface DeliveryRequestSubmissionSetup {
  /** The Ship from warehouse's display name. */
  warehouseName: string;
  /** The site chosen in the setup, as the storefront holds it. Used only when
   *  it is the site the order was placed for (see below). */
  destination: DeliveryRequestSite | null;
  /** The placer's display label and email, for an order placed for
   *  themselves (the overlay's `viewerLabel` and `viewerEmail`). */
  viewerLabel: string;
  viewerEmail: string | null;
  /** RAW `organizations.timezone`; resolved here (`resolveOrgTimezone`). */
  orgTimezone: string | null;
  /** The sent body's notes and lines. */
  notes: string | null;
  lines: readonly OrderLineQuantity[];
  /** Only `name` and `sku` reach the message (`DeliveryRequestItemRef`). */
  itemMap: ReadonlyMap<string, DeliveryRequestItemRef>;
}

/**
 * The delivery-request (or pickup-request) draft's input for an order just
 * placed, from the place answer's summary and the submission's setup.
 *
 * Two differences from `buildDeliveryRequestInput` above, both deliberate:
 *
 *   - THE REAL METHOD. That builder stamps `fulfillmentType: 'delivery'`,
 *     because both surfaces offer it only on delivery orders. The success
 *     screen offers "Email pickup request" too, so the method comes from the
 *     placed order, and a pickup draft never carries a destination.
 *   - THE STORED INSTANT. `neededByLocal` is the order's stored needed-by
 *     instant (`summary.neededBy`), not the wall clock typed into the cart.
 *     The builder reads it with `new Date(...)`; a zone-less wall clock would
 *     be read in the DEVICE's zone, so a phone set to another zone would mail
 *     a different time from the one the server stored in the organization's
 *     zone. An ISO instant reads the same everywhere.
 *
 * The destination is the setup's site only when it is the site the order was
 * placed for (`summary.deliveryCharterId`); otherwise the draft names none
 * rather than a site the order is not going to.
 *
 * For a Pacific browser and a Pacific organization (today's web) the result
 * renders byte for byte the draft the web success overlay renders; the web's
 * storefront parity test pins that against the real overlay.
 */
export function deliveryRequestInputFromSubmission(
  summary: OrderSummary,
  setup: DeliveryRequestSubmissionSetup,
  recipients: DeliveryRequestRecipients,
): DeliveryRequestInput {
  const delivery = summary.fulfillmentType === 'delivery';
  const destination =
    delivery && setup.destination !== null && setup.destination.id === summary.deliveryCharterId
      ? setup.destination
      : null;
  const requested = summary.requestedFor;
  return {
    recipients,
    orderId: summary.id,
    orderNumber: summary.orderNumber,
    fulfillmentType: summary.fulfillmentType,
    warehouseName: setup.warehouseName,
    destination,
    requestedFor: requested.self ? setup.viewerLabel : requested.name,
    requesterEmail: requested.self ? setup.viewerEmail : requested.email,
    neededByLocal: summary.neededBy ?? '',
    orgTimezone: resolveOrgTimezone(setup.orgTimezone),
    notes: setup.notes ?? '',
    lines: setup.lines,
    itemMap: setup.itemMap,
  };
}
