/**
 * PUT AWAY FROM THE ORDER, ON THE PHONE (F2-3). What the order screen offers
 * for stock in Staging that picking cannot take, and where it goes.
 *
 * Picking draws racks, crates, Sites and Unplaced, never Staging (0373). A
 * readiness line with units in this warehouse's Staging offers "Put away"
 * (core putAwayLineOffer); the readiness card offers "Put away 3 items"
 * (core putAwayStripOffer over putAwayTargets). Both open the Staging tab
 * filtered to those items (core stagingPutAwayParams), where Place is the
 * existing put-away sheet (MoveStockModal in put-away mode, book crates
 * included). No new write path: Place is POST /api/v1/items/[id]/transfer,
 * which asserts stock:transfer.
 *
 * THE GATE is `stock:transfer` (the permission Place asserts) AND
 * `items:read` (GET /api/v1/inventory/staging answers 403 without it), read
 * the way the server reads them (core `can` over the effective set: overrides
 * apply, no manager shortcut, exactly the web order page's `can(ctx, ...)`).
 * Without them the card says core's sentence once, naming what is missing
 * ("Putting stock away needs the Transfer stock permission.") and the lines
 * offer nothing, as the web page does: never a button that ends in a refusal.
 *
 * Who sees it: the full readiness panel only (approvers, pickers, buyers); the
 * requester's one sentence carries no actions.
 *
 * Every word is core's (put-away.ts), so the phone and the web order page say
 * the same thing. Pure: no React Native import, no API client.
 */

import {
  can,
  putAwayLineOffer,
  putAwayStripOffer,
  putAwayTargets,
  stagingPutAwayParams,
  type OrderReadinessResult,
  type Permission,
  type PutAwayAccess,
  type PutAwayOffer,
  type Role,
} from '@stockpilot/core';

/**
 * What this viewer may do about putting stock away: the effective
 * `stock:transfer` and `items:read` (the static role default while the set
 * loads). No role, or one this build does not know: neither.
 */
export function putAwayAccessFor(
  role: Role | string | null | undefined,
  permissions: ReadonlySet<Permission> | undefined,
): PutAwayAccess {
  const has = (p: Permission): boolean => {
    if (typeof role !== 'string' || role === '') return false;
    try {
      return can({ role: role as Role, permissions }, p);
    } catch {
      return false;
    }
  };
  return { canTransfer: has('stock:transfer'), canReadItems: has('items:read') };
}

const NONE: PutAwayOffer = { kind: 'none' };

export interface OrderPutAwayView {
  /** The readiness card's offer ("Put away 3 items", the sentence, or none). */
  strip: PutAwayOffer;
  /** Each line's "Put away" link, by line id. Only links: a viewer who may
   *  not put away reads core's sentence once, on the card, as on the web
   *  page (its line cells show no link and no sentence). */
  lines: ReadonlyMap<string, Extract<PutAwayOffer, { kind: 'link' }>>;
}

const EMPTY_VIEW: OrderPutAwayView = { strip: NONE, lines: new Map() };

/**
 * What the order screen offers for putting away, from the readiness it shows.
 * Nothing unless the full panel is shown and readiness was read (a failed or
 * capped check, or a phase past picking, claims nothing).
 */
export function orderPutAwayView(input: {
  readiness: OrderReadinessResult | null;
  fullPanel: boolean;
  access: PutAwayAccess;
}): OrderPutAwayView {
  if (!input.fullPanel || !input.readiness || input.readiness.state !== 'ok') return EMPTY_VIEW;
  const assessment = input.readiness.assessment;
  if (assessment.phase !== 'to_pick') return EMPTY_VIEW;
  const targets = putAwayTargets(assessment);
  if (!targets) return EMPTY_VIEW;
  const lines = new Map<string, Extract<PutAwayOffer, { kind: 'link' }>>();
  for (const line of assessment.lines) {
    const offer = putAwayLineOffer(line, input.access);
    if (offer.kind === 'link') lines.set(line.lineId, offer);
  }
  return { strip: putAwayStripOffer(targets, input.access), lines };
}

/**
 * Where "Put away" goes: the Staging tab, filtered to these items, naming the
 * order (the chip's "Showing items from SO-000123" and "Back to the order").
 * The params are core's (a comma list, as GET /api/v1/inventory/staging takes
 * it), built by hand: React Native has no working URLSearchParams.
 */
export function stagingPutAwayRoute(
  orderId: string,
  itemIds: readonly string[],
): { pathname: '/staging'; params: { itemIds: string; orderId?: string } } {
  return { pathname: '/staging', params: stagingPutAwayParams({ orderId, itemIds }) };
}
