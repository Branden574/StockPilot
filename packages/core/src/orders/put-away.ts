/**
 * PUT AWAY FROM THE ORDER (F2-3): which of an order's items need putting away
 * before picking can take them, where that is done, and every sentence around
 * it, shared by the web order page, the web Staging page, the phone order
 * screen and the phone Staging tab.
 *
 * ═══ WHICH LINES ═══
 *
 * Picking draws racks, crates, Sites and Unplaced, never Staging (the draw
 * engine, 0373). Readiness (readiness.ts) gives every line a `putAway`
 * quantity: units the order can have that sit in this warehouse's Staging.
 * A line needs putting away whenever that quantity is above zero, WHATEVER its
 * state: the state is the worst bucket a line touches, so a line that is short
 * or waiting on a PO for the rest still has units a put-away would free (and
 * its sentence already says "4 more are in Staging and must be put away before
 * picking can take them"). The action matches the words. Handed-over lines,
 * items the reader cannot see, deleted and moved items never qualify
 * (readiness gives them no put-away units).
 *
 * ═══ WHERE ═══
 *
 * No new write path. Put-away is the existing Staging worklist (web page, and
 * the phone's Staging tab through GET /api/v1/inventory/staging), filtered to
 * the order's items. Placing uses the existing flows (PlaceFromStagingDialog on
 * the web, MoveStockModal in put-away mode on the phone), which assert
 * `stock:transfer`. The worklist also lists the items' Unplaced rows; the
 * filter's note says only Staging stops a pick.
 *
 * The links are built by hand, never with URLSearchParams: React Native's
 * polyfill throws "not implemented" from it, and this module runs on the phone.
 *
 * Honest words (owner rules): the recorded quantity is "on record", never the
 * accounting jargon; no percentages.
 */

import type { OrderReadinessAssessment, ReadinessLineAssessment } from './readiness';

/** Half a unit of the fourth decimal: quantities are numeric(14,4). */
const EPS = 0.00005;

/** The shape Postgres' uuid type accepts (any version, any case). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(v: string): boolean {
  return UUID_RE.test(v);
}

/** Items one filtered Staging list may name: the readiness line cap (an order
 *  past it is not checked, so it never offers a put-away), and what the
 *  worklist reads in two batches of 100. */
export const STAGING_FILTER_MAX_ITEMS = 200;

// ── Which lines ─────────────────────────────────────────────────────────────

/** Units of this line in this warehouse's Staging that picking cannot take
 *  until they are put away (0 when none, or when the numbers are unknown). */
export function linePutAwayUnits(line: ReadinessLineAssessment): number {
  const units = line.units?.putAway ?? 0;
  return units > EPS ? units : 0;
}

/** Whether a readiness line offers "Put away". */
export function lineNeedsPutAway(line: ReadinessLineAssessment): boolean {
  return linePutAwayUnits(line) > 0;
}

export interface PutAwayTargets {
  /** Distinct items with units to put away, in line order (duplicate-item
   *  lines name their item once). */
  itemIds: string[];
  /** The lines that offer "Put away", in line order. */
  lineIds: string[];
  /** Units to put away across those lines. */
  units: number;
}

/**
 * What the order needs put away, from a readiness assessment. Null outside the
 * to_pick phase and past the line cap (readiness is not checked there, so
 * nothing is claimed). Empty lists when nothing needs putting away.
 */
export function putAwayTargets(assessment: OrderReadinessAssessment | null | undefined): PutAwayTargets | null {
  if (!assessment || assessment.phase !== 'to_pick' || assessment.linesCapped) return null;
  const itemIds: string[] = [];
  const seen = new Set<string>();
  const lineIds: string[] = [];
  let units = 0;
  for (const line of assessment.lines) {
    const u = linePutAwayUnits(line);
    if (u <= 0) continue;
    lineIds.push(line.lineId);
    units += u;
    const key = line.itemId.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      itemIds.push(line.itemId);
    }
  }
  return { itemIds, lineIds, units: Math.round(units * 10_000) / 10_000 };
}

// ── The filter (web ?item / ?order, phone itemIds / orderId) ────────────────

/** A Staging list narrowed to some items, and the order they came from. */
export interface StagingItemFilter {
  /** Lower-case uuids, deduped, in the order given; 1 to 200 of them. */
  itemIds: string[];
  /** The order the items came from (for the chip and "Back to the order"). */
  orderId: string | null;
}

export type StagingFilterParse =
  /** No item filter: the whole worklist, as before. */
  | { state: 'none' }
  | { state: 'ok'; filter: StagingItemFilter }
  /** The link's item list is unusable: every item is shown, and the page says
   *  why (never a silently different list). */
  | { state: 'invalid'; reason: 'bad_id' | 'too_many' };

type ParamValue = string | readonly string[] | null | undefined;

function values(v: ParamValue): string[] {
  if (v === null || v === undefined) return [];
  return typeof v === 'string' ? [v] : [...v];
}

/**
 * Read a Staging filter from what a link carries: the web page's repeatable
 * `?item=` (a string or a list, as Next hands them) or the phone's comma list
 * `itemIds`, plus `?order=` / `orderId`. Every value is split on commas, so
 * both spellings read the same. Pure; validation is the uuid shape Postgres
 * takes (a wrong value would otherwise fail the whole read, 22P02).
 *
 * `order` alone is not a filter (a link must name its items): it is ignored,
 * and so is an `order` that is not a uuid (the chip then names no order).
 */
export function parseStagingItemFilter(input: { item?: ParamValue; order?: ParamValue }): StagingFilterParse {
  const raw = values(input.item).flatMap((v) => v.split(','));
  if (raw.length === 0) return { state: 'none' };
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const part of raw) {
    const id = part.trim().toLowerCase();
    if (!isUuid(id)) return { state: 'invalid', reason: 'bad_id' };
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  if (ids.length > STAGING_FILTER_MAX_ITEMS) return { state: 'invalid', reason: 'too_many' };
  const order = values(input.order)[0]?.trim().toLowerCase() ?? '';
  return { state: 'ok', filter: { itemIds: ids, orderId: isUuid(order) ? order : null } };
}

/** The web Staging page for these items: `/dashboard/inventory/staging?order=…&item=…&item=…`. */
export function stagingPutAwayHref(filter: { orderId: string | null; itemIds: readonly string[] }): string {
  const parts: string[] = [];
  if (filter.orderId) parts.push(`order=${encodeURIComponent(filter.orderId)}`);
  for (const id of filter.itemIds) parts.push(`item=${encodeURIComponent(id)}`);
  return parts.length > 0 ? `/dashboard/inventory/staging?${parts.join('&')}` : '/dashboard/inventory/staging';
}

/** The phone Staging tab's route params for these items (`itemIds` a comma
 *  list, as GET /api/v1/inventory/staging takes it). */
export function stagingPutAwayParams(filter: {
  orderId: string | null;
  itemIds: readonly string[];
}): { itemIds: string; orderId?: string } {
  const params: { itemIds: string; orderId?: string } = { itemIds: filter.itemIds.join(',') };
  if (filter.orderId) params.orderId = filter.orderId;
  return params;
}

// ── Words ───────────────────────────────────────────────────────────────────

/** A readiness line's action. */
export const PUT_AWAY_LINE_LABEL = 'Put away';

/**
 * Who may not put away: the gate is `stock:transfer`, the permission the
 * Place action asserts (web and phone). Named as the permissions matrix names
 * it ("Transfer stock", core PERMISSION_META), as every other sentence that
 * asks for it does, so an admin can find it.
 */
export const PUT_AWAY_NEEDS_TRANSFER_COPY = 'Putting stock away needs the Transfer stock permission.';

function items(n: number): string {
  return `${n} ${n === 1 ? 'item' : 'items'}`;
}

/** The strip's action: "Put away 3 items". */
export function putAwayStripLabel(itemCount: number): string {
  return `${PUT_AWAY_LINE_LABEL} ${items(itemCount)}`;
}

function fq(n: number): string {
  return (Number.isFinite(n) ? n : 0).toLocaleString('en-US', { maximumFractionDigits: 4 });
}

/** A line's action, spoken: "Put away 4 of Maus I from Staging". */
export function putAwayLineAccessibilityLabel(line: ReadinessLineAssessment): string {
  return `${PUT_AWAY_LINE_LABEL} ${fq(linePutAwayUnits(line))} of ${line.itemName ?? 'this item'} from Staging`;
}

/** What the order page offers for put-away: a link, or the permission sentence. */
export type PutAwayOffer =
  | { kind: 'none' }
  | { kind: 'link'; label: string; itemIds: string[] }
  | { kind: 'needs_permission'; message: string };

/**
 * The strip's put-away offer. `canTransfer` is the viewer's `stock:transfer`.
 * Nothing when nothing needs putting away (or readiness was not checked).
 */
export function putAwayStripOffer(targets: PutAwayTargets | null, canTransfer: boolean): PutAwayOffer {
  if (!targets || targets.itemIds.length === 0) return { kind: 'none' };
  if (!canTransfer) return { kind: 'needs_permission', message: PUT_AWAY_NEEDS_TRANSFER_COPY };
  return { kind: 'link', label: putAwayStripLabel(targets.itemIds.length), itemIds: targets.itemIds };
}

/** One line's put-away offer (the line's own item only). */
export function putAwayLineOffer(line: ReadinessLineAssessment, canTransfer: boolean): PutAwayOffer {
  if (!lineNeedsPutAway(line)) return { kind: 'none' };
  if (!canTransfer) return { kind: 'needs_permission', message: PUT_AWAY_NEEDS_TRANSFER_COPY };
  return { kind: 'link', label: PUT_AWAY_LINE_LABEL, itemIds: [line.itemId] };
}

/** The chip's two actions. */
export const STAGING_FILTER_SHOW_ALL_LABEL = 'Show all';
export const STAGING_FILTER_BACK_LABEL = 'Back to the order';

/** Under the chip: only Staging stops a pick (the list also carries the
 *  items' Unplaced rows, which picking already takes). */
export const STAGING_FILTER_UNPLACED_NOTE =
  "Only stock in Staging stops a pick. These items' Unplaced stock is listed too; picking can already take it, and you can still place it on a rack.";

/** A filtered list with nothing in it. It says what is LISTED, not what is
 *  in stock: the worklist read shows nothing when it fails, too. */
export const STAGING_FILTER_EMPTY_COPY =
  'No Staging or Unplaced stock is listed for these items.';

/** A link whose item list could not be used: every item is shown instead. */
export function stagingFilterInvalidCopy(reason: 'bad_id' | 'too_many'): string {
  return reason === 'too_many'
    ? `This link names more than ${STAGING_FILTER_MAX_ITEMS} items, so every item is shown.`
    : "This link's item list couldn't be read, so every item is shown.";
}

export interface StagingFilterChipCopy {
  /** "Showing items from SO-000123". */
  headline: string;
  showAllLabel: string;
  /** Null when the link names no order. */
  backLabel: string | null;
  note: string;
}

/**
 * The chip over a filtered Staging list, web and phone alike:
 * "Showing items from SO-000123 · Show all · Back to the order", and the note
 * that only Staging stops a pick. `orderNumber` is the formatted number
 * (formatOrderNumber), null when it could not be read; `hasOrder` whether the
 * link named an order there is to go back to (it decides "Back to the order":
 * false when none was named, or the named one is not there).
 */
export function describeStagingItemFilter(input: {
  orderNumber: string | null;
  hasOrder: boolean;
  itemCount: number;
}): StagingFilterChipCopy {
  const headline = input.orderNumber
    ? `Showing items from ${input.orderNumber}`
    : input.hasOrder
      ? 'Showing items from an order'
      : `Showing only ${items(input.itemCount)}`;
  return {
    headline,
    showAllLabel: STAGING_FILTER_SHOW_ALL_LABEL,
    backLabel: input.hasOrder ? STAGING_FILTER_BACK_LABEL : null,
    note: STAGING_FILTER_UNPLACED_NOTE,
  };
}
