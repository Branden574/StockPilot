/**
 * HOLDING AVAILABLE STOCK FOR AN ORDER (F2-2, migration 0378).
 *
 * A hold (stock_reservations) is a commitment, not stock: it moves nothing, it
 * only stops the same units being promised to another order or the
 * storefront. Holds were minted at approval (approve_order_request,
 * approve_partial) and at resume only, so a line ADDED to an approved order,
 * or RAISED on one, was never held (L4L SO-60 and SO-77, Demo Co SO-4).
 * `hold_order_stock` tops an order's holds up to what its lines still owe, as
 * far as free stock allows, and never refuses for want of stock.
 *
 * What lives here, shared by the web server and the phone:
 *   - the answer's shape and its parser (`parseHoldOrderStockResult`);
 *   - the automatic top-up rule (`shouldTopUpHolds`, decision D15);
 *   - the outcome a line edit reports (`HoldOutcome`), never swallowed;
 *   - every sentence the hold shows, identical on web and phone.
 *
 * Honest words (owner rules): the recorded quantity is "on record", never the
 * accounting jargon; no percentages; nothing is "guaranteed". A hold is
 * "held", never "reserved for sure".
 */

import { READINESS_HOLD_STATUSES, type OrderReadinessAssessment } from './readiness';

// ── The answer ──────────────────────────────────────────────────────────────

/**
 * hold_order_stock's answer: what this call held, and what it could not.
 *
 * Quantities only for items the caller can read (caller_can_read_item, the
 * rule F2-1's readiness keeps). An approver scoped to one charter of the
 * warehouse can hold an order that carries another charter's item: that item
 * is held all the same (as approve would hold it), but an added or a short
 * amount there is its free stock, so it is only counted.
 */
export interface HoldOrderStockResult {
  /** Holds this call inserted, one per readable item, item ids ascending. */
  held: Array<{ itemId: string; added: number }>;
  /** What each readable item still needs after this call (no free stock), ascending. */
  stillShort: Array<{ itemId: string; quantity: number }>;
  /** Items the caller cannot read that this call held stock for. */
  hiddenHeldItems: number;
  /** Items the caller cannot read that are still short after this call. */
  hiddenShortItems: number;
}

export class HoldResultShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HoldResultShapeError';
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function positiveNumber(v: unknown, where: string): number {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) {
    throw new HoldResultShapeError(`${where} is not a positive number`);
  }
  return n;
}

function itemCount(v: unknown, where: string): number {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) {
    throw new HoldResultShapeError(`${where} is not a count`);
  }
  return n;
}

function itemIdOf(v: unknown, where: string): string {
  if (typeof v !== 'string' || v.trim() === '') {
    throw new HoldResultShapeError(`${where} has no item id`);
  }
  return v;
}

/**
 * Reads hold_order_stock's answer. Throws HoldResultShapeError on a wrong
 * shape (never guesses a number, and a missing count of hidden items is never
 * taken as none); tolerates keys it does not know, so a later additive change
 * never breaks an older phone.
 */
export function parseHoldOrderStockResult(raw: unknown): HoldOrderStockResult {
  if (!isRecord(raw)) throw new HoldResultShapeError('the answer is not an object');
  const { held, stillShort, hiddenHeldItems, hiddenShortItems } = raw;
  if (!Array.isArray(held)) throw new HoldResultShapeError('held is not a list');
  if (!Array.isArray(stillShort)) throw new HoldResultShapeError('stillShort is not a list');
  return {
    held: held.map((h, i) => {
      if (!isRecord(h)) throw new HoldResultShapeError(`held[${i}] is not an object`);
      return { itemId: itemIdOf(h.itemId, `held[${i}]`), added: positiveNumber(h.added, `held[${i}].added`) };
    }),
    stillShort: stillShort.map((s, i) => {
      if (!isRecord(s)) throw new HoldResultShapeError(`stillShort[${i}] is not an object`);
      return {
        itemId: itemIdOf(s.itemId, `stillShort[${i}]`),
        quantity: positiveNumber(s.quantity, `stillShort[${i}].quantity`),
      };
    }),
    hiddenHeldItems: itemCount(hiddenHeldItems, 'hiddenHeldItems'),
    hiddenShortItems: itemCount(hiddenShortItems, 'hiddenShortItems'),
  };
}

/** Units this call held, over every item. */
export function holdAddedUnits(result: HoldOrderStockResult): number {
  return result.held.reduce((s, h) => s + h.added, 0);
}

/** Units still short after this call, over every item. */
export function holdStillShortUnits(result: HoldOrderStockResult): number {
  return result.stillShort.reduce((s, h) => s + h.quantity, 0);
}

/** Whether this call held anything, an item the caller cannot read included
 *  (the order changed: audit it, tell other screens). */
export function holdAddedAny(result: HoldOrderStockResult): boolean {
  return result.held.length > 0 || result.hiddenHeldItems > 0;
}

/** Whether anything is left short after this call, an item the caller cannot
 *  read included (the screens say it as a warning). */
export function holdLeftShort(result: HoldOrderStockResult): boolean {
  return holdStillShortUnits(result) > 0 || result.hiddenShortItems > 0;
}

// ── When to hold ────────────────────────────────────────────────────────────

/** Statuses at which hold_order_stock answers (approve minted the holds,
 *  complete_picking releases them). The same list readiness annotates. */
export function isHoldStatus(status: string | null | undefined): boolean {
  return (READINESS_HOLD_STATUSES as readonly string[]).includes(status ?? '');
}

/**
 * The automatic top-up rule (F2 decision D15). After a line is added to an
 * order, or raised on one, its new units are held when, and only when:
 *   - the order is at a hold status (approved, pick slip generated, picking);
 *     before approval the approval holds everything, and once picking is
 *     complete the holds are gone;
 *   - the person who made the change may approve orders. A requester who may
 *     not must never create a commitment: their line stays "Not held" until
 *     an approver holds it ("Hold available stock").
 * Lowering a line never tops up (the line edit releases what is no longer
 * owed).
 */
export function shouldTopUpHolds(input: {
  status: string | null | undefined;
  canApproveOrders: boolean;
}): boolean {
  return input.canApproveOrders && isHoldStatus(input.status);
}

/**
 * Whether an order offers "Hold available stock" (F2-2), web and phone alike:
 * to someone who may approve orders, at a hold status, when readiness was
 * read and some line says "Not held" or "Held 20 of 40". A failed or capped
 * read offers nothing (no line is known to be unheld; Check again reads it
 * again), and neither does an order whose every line is held.
 */
export function shouldOfferHoldStock(input: {
  assessment: OrderReadinessAssessment | null;
  canApproveOrders: boolean;
}): boolean {
  const a = input.assessment;
  if (!input.canApproveOrders || !a || a.phase !== 'to_pick' || !isHoldStatus(a.order.status)) return false;
  // A capped read carries no lines, so it offers nothing.
  return a.lines.some((l) => l.hold?.state === 'not_held' || l.hold?.state === 'partly_held');
}

// ── What a line edit reports ────────────────────────────────────────────────

/** Why a hold did not happen, as both platforms word it. */
export type HoldFailureReason =
  /** The caller may not hold (orders:approve, or write access to the order's
   *  warehouse, or a step-up the session has not done). */
  | 'forbidden'
  /** The order is not (or no longer) at a hold status. */
  | 'not_applicable'
  /** The order or one of its items was locked by someone else for 5 s. */
  | 'busy'
  | 'not_found'
  | 'module_disabled'
  /** Anything else: the hold could not be made. */
  | 'failed';

/**
 * The hold outcome a line edit returns next to its own result: the units held
 * and still short, or why nothing was held. `null` beside it means no hold was
 * attempted (not a hold status, or the editor may not approve orders). A
 * failure never undoes the line edit, and it is always said, never swallowed.
 */
export type HoldOutcome =
  | ({ ok: true } & HoldOrderStockResult)
  | { ok: false; reason: HoldFailureReason; message: string };

// ── Words ───────────────────────────────────────────────────────────────────

/** The button (approvers, hold statuses, any line not held or partly held). */
export const HOLD_AVAILABLE_STOCK_LABEL = 'Hold available stock';

/** The refusals hold_order_stock can give, in the words both platforms use. */
export const HOLD_NOT_APPROVER_COPY = 'Holding stock for an order needs permission to approve orders.';
export const HOLD_NO_WAREHOUSE_ACCESS_COPY =
  "Holding stock for this order needs write access to its warehouse.";
export const HOLD_NOT_APPLICABLE_COPY =
  'Stock is held only while an order is approved or being picked. Approving holds a pending order; resuming holds a backordered one.';
export const HOLD_BUSY_COPY =
  'Someone else is changing this order or its items right now. Try again in a moment.';
export const HOLD_ORDER_NOT_FOUND_COPY = 'Order not found.';
export const HOLD_MODULE_OFF_COPY = 'Orders are turned off for this organization.';
export const HOLD_FAILED_COPY = "Stock couldn't be held just now. Try again.";

function fq(n: number): string {
  const v = Number.isFinite(n) ? n : 0;
  return v.toLocaleString('en-US', { maximumFractionDigits: 4 });
}

function units(n: number): string {
  return `${fq(n)} ${Math.abs(n - 1) < 0.00005 ? 'unit' : 'units'}`;
}

function isAre(n: number): string {
  return Math.abs(n - 1) < 0.00005 ? 'is' : 'are';
}

/** "1 item that isn't visible to you" / "2 items that aren't visible to you". */
function hiddenItems(n: number): string {
  return n === 1 ? "1 item that isn't visible to you" : `${fq(n)} items that aren't visible to you`;
}

/**
 * The sentences for items the caller cannot read: counted, never numbered.
 * `alsoHeld`: a sentence before this one already said units were held.
 */
function hiddenSentences(
  result: HoldOrderStockResult,
  alsoHeld: boolean,
  shortSentence: (n: number) => string,
): string[] {
  const parts: string[] = [];
  if (result.hiddenHeldItems > 0) {
    parts.push(`Stock was ${alsoHeld ? 'also ' : ''}held for ${hiddenItems(result.hiddenHeldItems)}.`);
  }
  if (result.hiddenShortItems > 0) parts.push(shortSentence(result.hiddenShortItems));
  return parts;
}

/**
 * What "Hold available stock" says when it answers: what it held and what is
 * still short (there was no free stock for it). Items the call skips (deleted,
 * or now in another warehouse) are not claimed either way: readiness names
 * them on their lines. Items the caller cannot read are counted, never given
 * numbers.
 */
export function describeHoldResult(result: HoldOrderStockResult): string {
  const added = holdAddedUnits(result);
  const short = holdStillShortUnits(result);
  const parts: string[] = [];
  if (added > 0) parts.push(`Held ${fq(added)} more ${Math.abs(added - 1) < 0.00005 ? 'unit' : 'units'} for this order.`);
  if (short > 0) {
    parts.push(`${units(short)} ${isAre(short)} still short: there is no free stock to hold for ${Math.abs(short - 1) < 0.00005 ? 'it' : 'them'}.`);
  }
  parts.push(...hiddenSentences(result, added > 0, (n) => `${hiddenItems(n)} ${isAre(n)} still short.`));
  if (parts.length === 0) return 'Nothing more to hold for this order.';
  return parts.join(' ');
}

/**
 * The sentence after a line is added or raised, or null when there is nothing
 * to say (no hold was attempted, or it held nothing and nothing is short).
 * A failure always says so, and points to the button (never a silent
 * swallow, pattern #28).
 */
export function describeHoldTopUp(outcome: HoldOutcome | null, change: 'added' | 'raised'): string | null {
  if (!outcome) return null;
  if (!outcome.ok) {
    return change === 'added'
      ? `Added. Stock was not held for it; use ${HOLD_AVAILABLE_STOCK_LABEL}.`
      : `Changed. Stock was not held for the extra units; use ${HOLD_AVAILABLE_STOCK_LABEL}.`;
  }
  const added = holdAddedUnits(outcome);
  const short = holdStillShortUnits(outcome);
  const parts: string[] = [];
  if (added > 0) parts.push(`Held ${units(added)} for this order.`);
  if (short > 0) {
    parts.push(`${units(short)} could not be held: there is no free stock for ${Math.abs(short - 1) < 0.00005 ? 'it' : 'them'}.`);
  }
  parts.push(...hiddenSentences(outcome, added > 0, (n) => `${hiddenItems(n)} could not be fully held.`));
  return parts.length > 0 ? parts.join(' ') : null;
}
