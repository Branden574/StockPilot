/**
 * ORDER READINESS: "can this order be picked, and if not, why not?"
 *
 * ═══ WHERE THE ANSWER COMES FROM ═══
 *
 * Facts in SQL, judgement here. `public.order_readiness_facts(order)` (migration
 * 0377) returns the raw facts for ONE order as one JSON value: the lines, and
 * per item on hand, holds (this order's, other orders', rentals'), holdings by
 * kind here and elsewhere, other pending and committed demand, open and draft
 * PO remaining. This module turns those facts into line states, quantities and
 * an order roll-up, and `readiness-copy.ts` into words. The web server and the
 * phone run THE SAME functions on the same facts, so the two can never
 * disagree about an order.
 *
 * Readiness is DERIVED, never stored (no table, sync or cron). Every
 * assessment carries `observedAt`: stock can change the moment after.
 *
 * ═══ THE TWINS ═══
 *
 * The arithmetic mirrors the frozen fulfilment RPCs, and a shared fixture
 * (`readiness-parity-cases.json`) runs both sides: this module in vitest, the
 * real RPCs in pgTAP (supabase/tests/0377_order_readiness_facts.test.sql).
 *
 *   approve_order_request / approve_partial (0365):
 *       per item, requested vs max(0, on_hand - ALL active holds).
 *   resume_fulfillment (0348):
 *       per line, min(owed, max(0, on_hand - ALL active holds)).
 *   complete_picking (0365), one click (every quantity_picked null):
 *       per line, min(owed, max(0, on_hand - holds of OTHER orders and
 *       rentals)); otherwise min(picked, owed). Then a placed draw
 *       (ledger.apply_level_delta_for, 0373): racks, crates, Sites and
 *       Unplaced in ANY warehouse, never Staging, else
 *       insufficient_placed_stock and the whole completion rolls back.
 *
 * ═══ HONEST WORDS ═══
 *
 * "Ready" only when every line is ready and every fact was readable. An item
 * the caller cannot read, stock the locations do not account for, stock only
 * in another warehouse, more than 200 lines, or a failed read is "Can't
 * confirm", never ready and never zero. A PO date is "expected".
 */

import type { OrderStatus } from '../order-state-machine';
import { resolveOrgTimezone } from '../time/org-timezone';

import { lineOwedUnits, lineUnpickedUnits, PICKING_SETTLED_STATUSES } from './pick-shortfall';

// ── Constants ───────────────────────────────────────────────────────────────

/** The facts shape this module reads. Later changes are additive only; a
 *  different `v` is a breaking change and is refused by the parser. */
export const ORDER_READINESS_FACTS_VERSION = 1;

/** order_readiness_facts' line cap: past it, `linesCapped` and no lines. */
export const READINESS_LINE_CAP = 200;

/** PO rows listed per item (the rest is disclosed as `truncated`). */
export const READINESS_INBOUND_ROW_CAP = 10;

export type OrderReadinessPhase = 'to_pick' | 'picked' | 'closed';

/** Statuses at which stock decides what happens next. */
export const READINESS_TO_PICK_STATUSES: readonly OrderStatus[] = [
  'pending_approval',
  'approved',
  'pick_slip_generated',
  'picking_in_progress',
  'backordered',
];

/** Statuses at which the order's holds are meaningful (approve minted them,
 *  complete_picking releases them). */
export const READINESS_HOLD_STATUSES: readonly OrderStatus[] = [
  'approved',
  'pick_slip_generated',
  'picking_in_progress',
];

/** Statuses at which complete_picking may run. */
const COMPLETE_PICKING_STATUSES: readonly string[] = ['pick_slip_generated', 'picking_in_progress'];

/**
 * The phase of an order, the twin of order_readiness_facts' CASE:
 *   to_pick: stock is read (READINESS_TO_PICK_STATUSES);
 *   picked:  picking is settled (PICKING_SETTLED_STATUSES), lines only;
 *   closed:  everything else, including an unknown or legacy status.
 */
export function orderReadinessPhase(status: string | null | undefined): OrderReadinessPhase {
  if ((READINESS_TO_PICK_STATUSES as readonly string[]).includes(status ?? '')) return 'to_pick';
  if ((PICKING_SETTLED_STATUSES as readonly string[]).includes(status ?? '')) return 'picked';
  return 'closed';
}

// ── Facts (the SQL answer) ──────────────────────────────────────────────────

export interface ReadinessOrderFacts {
  id: string;
  orderNumber: number | null;
  status: string;
  warehouseId: string | null;
  neededBy: string | null;
  fulfillmentType: string | null;
  /** organizations.timezone (additive: an older database does not send it,
   *  and the parser reads that as null): the zone the needed-by's calendar
   *  day is read in (core's documented default when absent). */
  timeZone?: string | null;
}

export interface ReadinessLineFacts {
  lineId: string;
  itemId: string;
  requested: number;
  fulfilled: number;
  picked: number | null;
  createdAt: string;
}

export interface ReadinessInboundRow {
  poId: string;
  poNumber: string;
  status: string;
  expectedAt: string | null;
  remaining: number;
}

export interface ReadinessDraftRow {
  poId: string;
  poNumber: string;
  remaining: number;
}

interface ReadinessPoTotals {
  /** Units on POs the caller cannot open (a quantity only). */
  hiddenRemaining: number;
  /** More visible POs than the row cap exist. */
  truncated: boolean;
  /** Units on the visible POs past the row cap. */
  truncatedRemaining: number;
}

export interface ReadinessInboundFacts extends ReadinessPoTotals {
  rows: ReadinessInboundRow[];
}

export interface ReadinessDraftFacts extends ReadinessPoTotals {
  rows: ReadinessDraftRow[];
}

export interface ReadinessHiddenItemFacts {
  itemId: string;
  visible: false;
}

export interface ReadinessVisibleItemFacts {
  itemId: string;
  visible: true;
  name: string;
  sku: string | null;
  supplierId: string | null;
  itemWarehouseId: string | null;
  deleted: boolean;
  archived: boolean;
  isBundle: boolean;
  onHand: number;
  heldOwn: number;
  heldOtherOrders: number;
  heldRentals: number;
  here: { rack: number; site: number; unplaced: number; staging: number };
  elsewhere: { pickable: number; staging: number };
  stagingSources: Array<{ locationId: string; quantity: number }>;
  stagingHiddenQty: number;
  /** Null: the caller is not an approver (never "none"). */
  pendingOthers: { orders: number; units: number } | null;
  committedOtherShortfall: number;
  /** Null: the purchase_orders module is off. */
  inbound: ReadinessInboundFacts | null;
  drafts: ReadinessDraftFacts | null;
}

export type ReadinessItemFacts = ReadinessHiddenItemFacts | ReadinessVisibleItemFacts;

export interface OrderReadinessFacts {
  v: 1;
  observedAt: string;
  phase: OrderReadinessPhase;
  linesCapped: boolean;
  order: ReadinessOrderFacts;
  lines: ReadinessLineFacts[];
  items: ReadinessItemFacts[];
}

// ── Parser ──────────────────────────────────────────────────────────────────

/** The facts did not have the expected shape. Callers show "Couldn't check
 *  readiness", never an empty or green answer. */
export class ReadinessFactsShapeError extends Error {
  constructor(
    public readonly path: string,
    detail: string,
  ) {
    super(`order readiness facts: ${path} ${detail}`);
    this.name = 'ReadinessFactsShapeError';
  }
}

type Rec = Record<string, unknown>;

function isRec(v: unknown): v is Rec {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function rec(v: unknown, path: string): Rec {
  if (!isRec(v)) throw new ReadinessFactsShapeError(path, 'is not an object');
  return v;
}

function arr(v: unknown, path: string): unknown[] {
  if (!Array.isArray(v)) throw new ReadinessFactsShapeError(path, 'is not an array');
  return v;
}

function str(v: unknown, path: string): string {
  if (typeof v !== 'string' || v.length === 0) {
    throw new ReadinessFactsShapeError(path, 'is not a non-empty string');
  }
  return v;
}

function strOrNull(v: unknown, path: string): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') throw new ReadinessFactsShapeError(path, 'is not a string or null');
  return v;
}

function bool(v: unknown, path: string): boolean {
  if (typeof v !== 'boolean') throw new ReadinessFactsShapeError(path, 'is not a boolean');
  return v;
}

/** A finite, non-negative quantity. A negative or non-finite number is a
 *  wrong shape: every quantity the SQL returns is floored or summed from
 *  non-negative columns. */
function qty(v: unknown, path: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
    throw new ReadinessFactsShapeError(path, 'is not a finite, non-negative number');
  }
  return v;
}

function qtyOrNull(v: unknown, path: string): number | null {
  if (v === null || v === undefined) return null;
  return qty(v, path);
}

function date(v: unknown, path: string): string {
  const s = str(v, path);
  if (Number.isNaN(new Date(s).getTime())) throw new ReadinessFactsShapeError(path, 'is not a date');
  return s;
}

function dateOrNull(v: unknown, path: string): string | null {
  if (v === null || v === undefined) return null;
  return date(v, path);
}

function parsePoTotals(o: Rec, path: string): ReadinessPoTotals {
  return {
    hiddenRemaining: qty(o.hiddenRemaining, `${path}.hiddenRemaining`),
    // Additive keys an older database may not send: absent means none.
    truncated: o.truncated === undefined ? false : bool(o.truncated, `${path}.truncated`),
    truncatedRemaining:
      o.truncatedRemaining === undefined ? 0 : qty(o.truncatedRemaining, `${path}.truncatedRemaining`),
  };
}

function parseInbound(v: unknown, path: string): ReadinessInboundFacts | null {
  if (v === null) return null;
  const o = rec(v, path);
  return {
    rows: arr(o.rows, `${path}.rows`).map((r, i) => {
      const p = `${path}.rows[${i}]`;
      const row = rec(r, p);
      return {
        poId: str(row.poId, `${p}.poId`),
        poNumber: str(row.poNumber, `${p}.poNumber`),
        status: str(row.status, `${p}.status`),
        expectedAt: dateOrNull(row.expectedAt, `${p}.expectedAt`),
        remaining: qty(row.remaining, `${p}.remaining`),
      };
    }),
    ...parsePoTotals(o, path),
  };
}

function parseDrafts(v: unknown, path: string): ReadinessDraftFacts | null {
  if (v === null) return null;
  const o = rec(v, path);
  return {
    rows: arr(o.rows, `${path}.rows`).map((r, i) => {
      const p = `${path}.rows[${i}]`;
      const row = rec(r, p);
      return {
        poId: str(row.poId, `${p}.poId`),
        poNumber: str(row.poNumber, `${p}.poNumber`),
        remaining: qty(row.remaining, `${p}.remaining`),
      };
    }),
    ...parsePoTotals(o, path),
  };
}

function parseItem(v: unknown, path: string): ReadinessItemFacts {
  const o = rec(v, path);
  const itemId = str(o.itemId, `${path}.itemId`);
  const visible = bool(o.visible, `${path}.visible`);
  if (!visible) return { itemId, visible: false };
  const here = rec(o.here, `${path}.here`);
  const elsewhere = rec(o.elsewhere, `${path}.elsewhere`);
  const pending =
    o.pendingOthers === null || o.pendingOthers === undefined
      ? null
      : rec(o.pendingOthers, `${path}.pendingOthers`);
  if (!('inbound' in o)) throw new ReadinessFactsShapeError(`${path}.inbound`, 'is missing');
  if (!('drafts' in o)) throw new ReadinessFactsShapeError(`${path}.drafts`, 'is missing');
  return {
    itemId,
    visible: true,
    name: str(o.name, `${path}.name`),
    sku: strOrNull(o.sku, `${path}.sku`),
    supplierId: strOrNull(o.supplierId, `${path}.supplierId`),
    itemWarehouseId: strOrNull(o.itemWarehouseId, `${path}.itemWarehouseId`),
    deleted: bool(o.deleted, `${path}.deleted`),
    archived: bool(o.archived, `${path}.archived`),
    isBundle: bool(o.isBundle, `${path}.isBundle`),
    onHand: qty(o.onHand, `${path}.onHand`),
    heldOwn: qty(o.heldOwn, `${path}.heldOwn`),
    heldOtherOrders: qty(o.heldOtherOrders, `${path}.heldOtherOrders`),
    heldRentals: qty(o.heldRentals, `${path}.heldRentals`),
    here: {
      rack: qty(here.rack, `${path}.here.rack`),
      site: qty(here.site, `${path}.here.site`),
      unplaced: qty(here.unplaced, `${path}.here.unplaced`),
      staging: qty(here.staging, `${path}.here.staging`),
    },
    elsewhere: {
      pickable: qty(elsewhere.pickable, `${path}.elsewhere.pickable`),
      staging: qty(elsewhere.staging, `${path}.elsewhere.staging`),
    },
    stagingSources: arr(o.stagingSources, `${path}.stagingSources`).map((s, i) => {
      const p = `${path}.stagingSources[${i}]`;
      const src = rec(s, p);
      return {
        locationId: str(src.locationId, `${p}.locationId`),
        quantity: qty(src.quantity, `${p}.quantity`),
      };
    }),
    stagingHiddenQty: qty(o.stagingHiddenQty, `${path}.stagingHiddenQty`),
    pendingOthers: pending
      ? {
          orders: qty(pending.orders, `${path}.pendingOthers.orders`),
          units: qty(pending.units, `${path}.pendingOthers.units`),
        }
      : null,
    committedOtherShortfall: qty(o.committedOtherShortfall, `${path}.committedOtherShortfall`),
    inbound: parseInbound(o.inbound, `${path}.inbound`),
    drafts: parseDrafts(o.drafts, `${path}.drafts`),
  };
}

/**
 * Parse order_readiness_facts' answer. THROWS `ReadinessFactsShapeError` on a
 * wrong shape (a missing or mistyped field, another version, a phase that
 * disagrees with the order's status, a to_pick line whose item has no facts),
 * so a caller can only ever show real facts or "Couldn't check readiness".
 * Unknown keys are ignored: the database may be one release ahead of the
 * phone (additive changes only).
 */
export function parseOrderReadinessFacts(raw: unknown): OrderReadinessFacts {
  const o = rec(raw, 'facts');
  if (o.v !== ORDER_READINESS_FACTS_VERSION) {
    throw new ReadinessFactsShapeError('facts.v', `is not ${ORDER_READINESS_FACTS_VERSION}`);
  }
  const order = rec(o.order, 'facts.order');
  const orderNumber = order.orderNumber;
  if (orderNumber !== null && orderNumber !== undefined) {
    if (typeof orderNumber !== 'number' || !Number.isFinite(orderNumber)) {
      throw new ReadinessFactsShapeError('facts.order.orderNumber', 'is not a number or null');
    }
  }
  const parsedOrder: ReadinessOrderFacts = {
    id: str(order.id, 'facts.order.id'),
    orderNumber: typeof orderNumber === 'number' ? orderNumber : null,
    status: str(order.status, 'facts.order.status'),
    warehouseId: strOrNull(order.warehouseId, 'facts.order.warehouseId'),
    neededBy: dateOrNull(order.neededBy, 'facts.order.neededBy'),
    fulfillmentType: strOrNull(order.fulfillmentType, 'facts.order.fulfillmentType'),
    // Additive: an older database does not send it (absent means unknown).
    timeZone: strOrNull(order.timeZone, 'facts.order.timeZone'),
  };
  const phase = o.phase;
  if (phase !== 'to_pick' && phase !== 'picked' && phase !== 'closed') {
    throw new ReadinessFactsShapeError('facts.phase', 'is not a readiness phase');
  }
  // The SQL CASE and orderReadinessPhase are twins. If they ever disagree
  // (a status added on one side only), refuse rather than judge an order by
  // the wrong rules.
  if (phase !== orderReadinessPhase(parsedOrder.status)) {
    throw new ReadinessFactsShapeError('facts.phase', `disagrees with status ${parsedOrder.status}`);
  }
  const linesCapped = bool(o.linesCapped, 'facts.linesCapped');
  const lines: ReadinessLineFacts[] = arr(o.lines, 'facts.lines').map((l, i) => {
    const p = `facts.lines[${i}]`;
    const line = rec(l, p);
    return {
      lineId: str(line.lineId, `${p}.lineId`),
      itemId: str(line.itemId, `${p}.itemId`),
      requested: qty(line.requested, `${p}.requested`),
      fulfilled: qty(line.fulfilled, `${p}.fulfilled`),
      picked: qtyOrNull(line.picked, `${p}.picked`),
      createdAt: date(line.createdAt, `${p}.createdAt`),
    };
  });
  const items = arr(o.items, 'facts.items').map((it, i) => parseItem(it, `facts.items[${i}]`));
  if (phase === 'to_pick' && !linesCapped) {
    const known = new Set(items.map((it) => it.itemId));
    const missing = lines.find((l) => !known.has(l.itemId));
    if (missing) {
      throw new ReadinessFactsShapeError('facts.items', `has no entry for item ${missing.itemId}`);
    }
  }
  return {
    v: 1,
    observedAt: date(o.observedAt, 'facts.observedAt'),
    phase,
    linesCapped,
    order: parsedOrder,
    lines,
    items,
  };
}

// ── Assessment types ────────────────────────────────────────────────────────

export type ReadinessLineState =
  | 'ready'
  | 'needs_put_away'
  | 'awaiting_po'
  | 'short'
  | 'unknown'
  /** The line owes nothing: all of it was handed over (a backordered order's
   *  finished lines). Nothing to pick, so never "Ready to pick", and not
   *  counted among the lines that are or are not ready. */
  | 'handed_over';

/** Why a line is in its state. */
export type ReadinessReason =
  /** needs_put_away: units are in this warehouse's Staging. */
  | 'in_staging'
  /** awaiting_po: units are on an open PO. */
  | 'on_order'
  /** short: not enough stock, and not enough on order. */
  | 'insufficient'
  /** short: the item was deleted. */
  | 'item_deleted'
  /** short: the item now belongs to another warehouse (approve refuses it). */
  | 'item_moved'
  /** unknown: the caller cannot read the item. */
  | 'not_visible'
  /** unknown: on record does not equal what the locations hold. */
  | 'records_disagree'
  /** unknown: the stock that covers it is in another warehouse. */
  | 'held_elsewhere'
  /** unknown: the order has more than 200 lines. */
  | 'lines_capped';

/** Extra facts about a line, shown in its sentence or its "Why". */
export type ReadinessNote =
  /** ready units come from Unplaced or a Site (no rack recorded). */
  | 'no_rack_recorded'
  /** some awaited units come from a PO with no expected date (or one not
   *  listed, or one the caller cannot open). */
  | 'no_expected_date'
  /** the line's expected date is after the order's needed-by. */
  | 'expected_after_needed_by'
  /** some awaited units are on a PO the caller cannot open. */
  | 'on_hidden_po'
  /** a draft PO carries the item (not ordered, never counted as supply). */
  | 'on_draft_po'
  /** other orders waiting for approval also ask for the item (approvers). */
  | 'pending_others'
  /** the item is a kit (its stock is the kit's own, never drafted). */
  | 'kit_stock'
  /** the line owes nothing (all of it was handed over): state handed_over. */
  | 'nothing_owed';

export interface ReadinessLineUnits {
  /** On the shelf here for this line (net of other orders' holds). */
  ready: number;
  /** Of `ready`, units that come from Unplaced or a Site. */
  noRack: number;
  /** In this warehouse's Staging: put away before picking can take them. */
  putAway: number;
  /** On record, but no location here accounts for them. */
  gap: number;
  /** Short now, covered by an open PO. */
  awaiting: number;
  /** Short, and not on order. */
  short: number;
}

/** Where a line's awaited units come from, earliest expected date first. */
export interface ReadinessPoShare {
  kind: 'po' | 'unlisted' | 'hidden';
  /** kind 'po' only. */
  poId: string | null;
  poNumber: string | null;
  expectedAt: string | null;
  /** The PO's remaining units for this item (kind 'po'). */
  poRemaining: number | null;
  /** Units of this line it covers. */
  units: number;
}

export type ReadinessHold =
  | { state: 'held'; held: number; of: number }
  | { state: 'partly_held'; held: number; of: number }
  | { state: 'not_held'; held: 0; of: number };

export interface ReadinessLineAssessment {
  lineId: string;
  itemId: string;
  /** 1-based position in (createdAt, lineId) order. */
  position: number;
  requested: number;
  fulfilled: number;
  picked: number | null;
  /** lineOwedUnits. */
  owed: number;
  state: ReadinessLineState;
  reasons: ReadinessReason[];
  notes: ReadinessNote[];
  /** Null when the numbers are unknown (the item is not visible). */
  units: ReadinessLineUnits | null;
  /** The latest expected date among the awaited units, when every awaited
   *  unit has one; null otherwise. */
  expectedAt: string | null;
  poShares: ReadinessPoShare[];
  /** Hold statuses only, for visible items with something owed. */
  hold: ReadinessHold | null;
  /** Display facts (null for a hidden item). */
  itemName: string | null;
  itemSku: string | null;
}

/** Per-item numbers, computed once and shared by the line allocation, the
 *  stock gates, the completion projection and the "Why". */
export interface ReadinessItemQuantities {
  /** D: owed over the item's lines. */
  demand: number;
  /** Requested over the item's lines (approve's own sum). */
  requested: number;
  /** Other orders' and rentals' holds (complete_picking's term). */
  reservedOthers: number;
  /** A = max(0, onHand - reservedOthers): this order's own hold is supply. */
  available: number;
  /** max(0, onHand - every active hold): approve, approve_partial and
   *  resume_fulfillment's availability. */
  approveAvailable: number;
  /** P: here.rack + here.site + here.unplaced (what a pick draws here). */
  pickable: number;
  /** S: here.staging. */
  staging: number;
  /** Every holding, here and elsewhere. */
  locationsTotal: number;
  recordsDisagree: boolean;
  covered: number;
  ready: number;
  noRack: number;
  putAway: number;
  gap: number;
  awaiting: number;
  short: number;
  /** Units on open POs (listed, unlisted and hidden). */
  inboundRemaining: number;
  /** Units on draft POs. */
  draftRemaining: number;
  /** What F2-5 may draft for this order (0 when blocked, a kit, hidden, or
   *  the purchase_orders module is off). */
  draftable: number;
}

export interface ReadinessItemAssessment {
  itemId: string;
  visible: boolean;
  /** Null for a hidden item. */
  facts: ReadinessVisibleItemFacts | null;
  blocked: 'item_deleted' | 'item_moved' | null;
  /** Null for a hidden item. */
  quantities: ReadinessItemQuantities | null;
}

export type NeededBySignal = 'past_due' | 'at_risk';

export interface ReadinessRollup {
  lineCount: number;
  /** Lines that still owe something (lineCount less the handed-over ones):
   *  what "N of M lines ready to pick" counts. */
  owedLineCount: number;
  counts: Record<ReadinessLineState, number>;
  /** GREEN: every owed line ready (at least one), every fact readable, not
   *  capped. */
  ready: boolean;
  capped: boolean;
  neededBy: string | null;
  neededBySignal: NeededBySignal | null;
}

export type PickedLineState = 'picked_complete' | 'short_picked';

export interface PickedLineAssessment {
  lineId: string;
  itemId: string;
  position: number;
  requested: number;
  fulfilled: number;
  picked: number | null;
  state: PickedLineState;
  /** lineUnpickedUnits (0 when picked_complete). */
  unpicked: number;
}

export interface PickedRollup {
  lineCount: number;
  counts: Record<PickedLineState, number>;
  capped: boolean;
  neededBy: string | null;
  neededBySignal: NeededBySignal | null;
}

export type OrderReadinessAssessment =
  | {
      phase: 'to_pick';
      observedAt: string;
      order: ReadinessOrderFacts;
      linesCapped: boolean;
      /** The order is at a hold status, so each line carries `hold`. */
      holdAnnotated: boolean;
      lines: ReadinessLineAssessment[];
      items: ReadinessItemAssessment[];
      rollup: ReadinessRollup;
    }
  | {
      phase: 'picked';
      observedAt: string;
      order: ReadinessOrderFacts;
      linesCapped: boolean;
      lines: PickedLineAssessment[];
      rollup: PickedRollup;
    }
  | {
      phase: 'closed';
      observedAt: string;
      order: ReadinessOrderFacts;
    };

/** What a screen holds: an assessment, or a read that failed. */
export type OrderReadinessResult =
  | { state: 'ok'; assessment: OrderReadinessAssessment }
  | { state: 'failed'; message: string };

// ── State metadata ──────────────────────────────────────────────────────────

export type ReadinessTone = 'success' | 'warning' | 'info' | 'danger' | 'neutral';

/**
 * Label, tone, icon and precedence per line state (higher precedence is
 * worse: the worst state a line touches wins). `icon` is a generic key each
 * platform maps to its own icon set; a state is never shown by colour alone.
 */
export const READINESS_STATES: Readonly<
  Record<ReadinessLineState, { label: string; tone: ReadinessTone; icon: string; precedence: number }>
> = {
  handed_over: { label: 'Handed over', tone: 'neutral', icon: 'handed', precedence: -1 },
  ready: { label: 'Ready to pick', tone: 'success', icon: 'check', precedence: 0 },
  needs_put_away: { label: 'Needs put-away', tone: 'warning', icon: 'package', precedence: 1 },
  awaiting_po: { label: 'Waiting on a PO', tone: 'info', icon: 'clock', precedence: 2 },
  unknown: { label: "Can't confirm", tone: 'neutral', icon: 'help', precedence: 3 },
  short: { label: 'Short', tone: 'danger', icon: 'alert', precedence: 4 },
};

/** The picked phase's two line states. */
export const PICKED_LINE_STATES: Readonly<
  Record<PickedLineState, { label: string; tone: ReadinessTone; icon: string }>
> = {
  picked_complete: { label: 'Picked', tone: 'success', icon: 'check' },
  short_picked: { label: 'Not fully picked', tone: 'danger', icon: 'alert' },
};

// ── Arithmetic helpers ──────────────────────────────────────────────────────

/** Quantities are numeric(14,4) in the database: keep derived numbers on the
 *  same grid so 0.1 + 0.2 never reads as 0.30000000000000004. */
function q4(x: number): number {
  return Math.round(x * 10_000) / 10_000;
}

function sum(xs: readonly number[]): number {
  return q4(xs.reduce((s, x) => s + x, 0));
}

function min(a: number, b: number): number {
  return q4(Math.min(a, b));
}

function pos(x: number): number {
  return q4(Math.max(0, x));
}

/** Half a unit of the fourth decimal: numeric(14,4) values that differ by
 *  less are equal. */
const EPS = 0.00005;

function timeOf(s: string | null): number | null {
  if (!s) return null;
  const t = new Date(s).getTime();
  return Number.isNaN(t) ? null : t;
}

function lineOrder(a: ReadinessLineFacts, b: ReadinessLineFacts): number {
  const ta = timeOf(a.createdAt) ?? 0;
  const tb = timeOf(b.createdAt) ?? 0;
  if (ta !== tb) return ta - tb;
  return a.lineId < b.lineId ? -1 : a.lineId > b.lineId ? 1 : 0;
}

function inboundOrder(a: ReadinessInboundRow, b: ReadinessInboundRow): number {
  const ta = timeOf(a.expectedAt);
  const tb = timeOf(b.expectedAt);
  if (ta !== tb) {
    if (ta === null) return 1;
    if (tb === null) return -1;
    return ta - tb;
  }
  if (a.poNumber !== b.poNumber) return a.poNumber < b.poNumber ? -1 : 1;
  return a.poId < b.poId ? -1 : a.poId > b.poId ? 1 : 0;
}

/** A PO's expected date is a CALENDAR DATE: the PO form and the import
 *  screens save an <input type="date"> day as midnight UTC of that day (the
 *  PO PDF reads it back in UTC for the same reason, lib/pdf/po.tsx). Its day
 *  is the UTC one, "YYYY-MM-DD". */
function poDayKey(iso: string | null): string | null {
  const t = timeOf(iso);
  return t === null ? null : new Date(t).toISOString().slice(0, 10);
}

/** An instant's calendar day in a zone, "YYYY-MM-DD" (null if the runtime
 *  cannot say). */
function zonedDayKey(iso: string | null, tz: string): string | null {
  const t = timeOf(iso);
  if (t === null) return null;
  try {
    const s = new Date(t).toLocaleDateString('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const m = /(\d{2})\D(\d{2})\D(\d{4})/.exec(s);
    return m ? `${m[3]}-${m[1]}-${m[2]}` : null;
  } catch {
    return null;
  }
}

function toTime(now: Date | string | number): number {
  const t = now instanceof Date ? now.getTime() : new Date(now).getTime();
  return Number.isNaN(t) ? Date.now() : t;
}

// ── Per-item quantities ─────────────────────────────────────────────────────

function itemQuantities(
  f: ReadinessVisibleItemFacts,
  lines: readonly ReadinessLineFacts[],
  blocked: ReadinessItemAssessment['blocked'],
): ReadinessItemQuantities {
  const demand = sum(
    lines.map((l) => lineOwedUnits({ quantityRequested: l.requested, quantityFulfilled: l.fulfilled })),
  );
  const requested = sum(lines.map((l) => l.requested));
  const reservedOthers = q4(f.heldOtherOrders + f.heldRentals);
  const available = pos(f.onHand - reservedOthers);
  const approveAvailable = pos(f.onHand - f.heldOwn - f.heldOtherOrders - f.heldRentals);
  const pickable = q4(f.here.rack + f.here.site + f.here.unplaced);
  const staging = f.here.staging;
  const locationsTotal = q4(pickable + staging + f.elsewhere.pickable + f.elsewhere.staging);
  const recordsDisagree = Math.abs(f.onHand - locationsTotal) > EPS;

  const inboundRemaining = f.inbound
    ? q4(sum(f.inbound.rows.map((r) => r.remaining)) + f.inbound.truncatedRemaining + f.inbound.hiddenRemaining)
    : 0;
  const draftRemaining = f.drafts
    ? q4(sum(f.drafts.rows.map((r) => r.remaining)) + f.drafts.truncatedRemaining + f.drafts.hiddenRemaining)
    : 0;
  const C = f.committedOtherShortfall;

  if (blocked) {
    // Deleted or moved: nothing here can serve it (approve refuses a moved
    // item; a deleted one should be removed). All of it is short.
    return {
      demand,
      requested,
      reservedOthers,
      available,
      approveAvailable,
      pickable,
      staging,
      locationsTotal,
      recordsDisagree,
      covered: 0,
      ready: 0,
      noRack: 0,
      putAway: 0,
      gap: 0,
      awaiting: 0,
      short: demand,
      inboundRemaining,
      draftRemaining,
      draftable: 0,
    };
  }

  const covered = min(demand, available);
  // Other orders' holds are charged to shelf stock first: conservative, so
  // "ready" always means a pick succeeds (pgTAP 0377 C8 pins the direction).
  const ready = min(covered, pos(pickable - reservedOthers));
  // Racks first, then Unplaced and Sites (no rack recorded).
  const rackReady = min(ready, pos(f.here.rack - reservedOthers));
  const noRack = q4(ready - rackReady);
  const putAway = min(q4(covered - ready), staging);
  const gap = q4(covered - ready - putAway);
  const short0 = q4(demand - covered);
  const awaiting = f.inbound ? min(short0, pos(inboundRemaining - C)) : 0;
  const short = q4(short0 - awaiting);
  const draftable =
    f.isBundle || !f.inbound ? 0 : pos(short0 - pos(inboundRemaining + draftRemaining - C));
  return {
    demand,
    requested,
    reservedOthers,
    available,
    approveAvailable,
    pickable,
    staging,
    locationsTotal,
    recordsDisagree,
    covered,
    ready,
    noRack,
    putAway,
    gap,
    awaiting,
    short,
    inboundRemaining,
    draftRemaining,
    draftable,
  };
}

/** A queue of units a line takes from in order. */
class Buckets<T> {
  private readonly items: Array<{ tag: T; left: number }>;
  constructor(items: Array<{ tag: T; qty: number }>) {
    this.items = items.filter((i) => i.qty > EPS).map((i) => ({ tag: i.tag, left: i.qty }));
  }
  take(qty: number): Array<{ tag: T; qty: number }> {
    const out: Array<{ tag: T; qty: number }> = [];
    let need = qty;
    for (const b of this.items) {
      if (need <= EPS) break;
      if (b.left <= EPS) continue;
      const t = min(b.left, need);
      b.left = q4(b.left - t);
      need = q4(need - t);
      out.push({ tag: b.tag, qty: t });
    }
    return out;
  }
  skip(qty: number): void {
    this.take(qty);
  }
}

type SupplyTag =
  | { kind: 'po'; row: ReadinessInboundRow }
  | { kind: 'unlisted' }
  | { kind: 'hidden' };

// ── The assessment ──────────────────────────────────────────────────────────

export interface AssessOptions {
  /** "Now", for the needed-by signal. */
  now: Date | string | number;
}

const EMPTY_COUNTS: Record<ReadinessLineState, number> = {
  ready: 0,
  needs_put_away: 0,
  awaiting_po: 0,
  short: 0,
  unknown: 0,
  handed_over: 0,
};

function worstOf(states: readonly ReadinessLineState[]): ReadinessLineState {
  let w: ReadinessLineState = 'ready';
  for (const s of states) {
    if (READINESS_STATES[s].precedence > READINESS_STATES[w].precedence) w = s;
  }
  return w;
}

function neededBySignalFor(
  neededBy: string | null,
  nowMs: number,
  atRisk: boolean,
): NeededBySignal | null {
  const t = timeOf(neededBy);
  if (t === null) return null;
  if (t < nowMs) return 'past_due';
  return atRisk ? 'at_risk' : null;
}

/**
 * Judge an order from its facts. Pure: the same facts and `now` give the same
 * answer on the web server and the phone.
 */
export function assessOrderReadiness(
  facts: OrderReadinessFacts,
  opts: AssessOptions,
): OrderReadinessAssessment {
  const nowMs = toTime(opts.now);
  const lines = [...facts.lines].sort(lineOrder);
  const position = new Map(lines.map((l, i) => [l.lineId, i + 1]));

  if (facts.phase === 'closed') {
    return { phase: 'closed', observedAt: facts.observedAt, order: facts.order };
  }

  if (facts.phase === 'picked') {
    const picked: PickedLineAssessment[] = facts.linesCapped
      ? []
      : lines.map((l) => {
          const shortfall = {
            quantityRequested: l.requested,
            quantityFulfilled: l.fulfilled,
            quantityPicked: l.picked,
          };
          const unpicked = q4(lineUnpickedUnits(shortfall));
          return {
            lineId: l.lineId,
            itemId: l.itemId,
            position: position.get(l.lineId) ?? 0,
            requested: l.requested,
            fulfilled: l.fulfilled,
            picked: l.picked,
            state: unpicked > EPS ? 'short_picked' : 'picked_complete',
            unpicked: unpicked > EPS ? unpicked : 0,
          };
        });
    const counts = { picked_complete: 0, short_picked: 0 };
    for (const l of picked) counts[l.state] += 1;
    return {
      phase: 'picked',
      observedAt: facts.observedAt,
      order: facts.order,
      linesCapped: facts.linesCapped,
      lines: picked,
      rollup: {
        lineCount: picked.length,
        counts,
        capped: facts.linesCapped,
        neededBy: facts.order.neededBy,
        neededBySignal: neededBySignalFor(
          facts.order.neededBy,
          nowMs,
          facts.linesCapped || counts.short_picked > 0,
        ),
      },
    };
  }

  // ── to_pick ──
  const holdAnnotated = (READINESS_HOLD_STATUSES as readonly string[]).includes(facts.order.status);
  if (facts.linesCapped) {
    return {
      phase: 'to_pick',
      observedAt: facts.observedAt,
      order: facts.order,
      linesCapped: true,
      holdAnnotated,
      lines: [],
      items: [],
      rollup: {
        lineCount: 0,
        owedLineCount: 0,
        counts: { ...EMPTY_COUNTS },
        ready: false,
        capped: true,
        neededBy: facts.order.neededBy,
        neededBySignal: neededBySignalFor(facts.order.neededBy, nowMs, true),
      },
    };
  }

  const factsById = new Map(facts.items.map((it) => [it.itemId, it]));
  const linesByItem = new Map<string, ReadinessLineFacts[]>();
  for (const l of lines) {
    const list = linesByItem.get(l.itemId) ?? [];
    list.push(l);
    linesByItem.set(l.itemId, list);
  }
  const neededByMs = timeOf(facts.order.neededBy);
  // The needed-by's calendar day in the org's zone, for the PO dates (which
  // are calendar days): a PO expected on the needed-by day is not after it.
  const neededByDay = zonedDayKey(facts.order.neededBy, resolveOrgTimezone(facts.order.timeZone));

  const items: ReadinessItemAssessment[] = [];
  const assessed = new Map<string, ReadinessLineAssessment>();

  for (const [itemId, itemLines] of linesByItem) {
    const f = factsById.get(itemId);
    if (!f || !f.visible) {
      // The caller cannot read this item: its stock cannot be checked.
      items.push({ itemId, visible: false, facts: null, blocked: null, quantities: null });
      for (const l of itemLines) {
        const owed = lineOwedUnits({ quantityRequested: l.requested, quantityFulfilled: l.fulfilled });
        // What a line owes is on the line itself: a handed-over line is
        // handed over whether or not its item can be read.
        const handedOver = owed <= EPS;
        assessed.set(l.lineId, {
          lineId: l.lineId,
          itemId,
          position: position.get(l.lineId) ?? 0,
          requested: l.requested,
          fulfilled: l.fulfilled,
          picked: l.picked,
          owed: q4(owed),
          state: handedOver ? 'handed_over' : 'unknown',
          reasons: handedOver ? [] : ['not_visible'],
          notes: handedOver ? ['nothing_owed'] : [],
          units: null,
          expectedAt: null,
          poShares: [],
          hold: null,
          itemName: null,
          itemSku: null,
        });
      }
      continue;
    }

    const blocked: ReadinessItemAssessment['blocked'] = f.deleted
      ? 'item_deleted'
      : f.itemWarehouseId !== facts.order.warehouseId
        ? 'item_moved'
        : null;
    const qn = itemQuantities(f, itemLines, blocked);
    items.push({ itemId, visible: true, facts: f, blocked, quantities: qn });

    // Buckets, consumed by the item's lines in (createdAt, lineId) order: a
    // unit is never counted twice (duplicate-item lines share them).
    const shelf = new Buckets<'rack' | 'norack'>([
      { tag: 'rack', qty: q4(qn.ready - qn.noRack) },
      { tag: 'norack', qty: qn.noRack },
    ]);
    let putAwayLeft = qn.putAway;
    let gapLeft = qn.gap;
    let awaitingLeft = qn.awaiting;

    // Awaited units come from the inbound POs after the other committed
    // orders' shortfall takes the earliest ones (no invented priority).
    const supply = new Buckets<SupplyTag>(
      f.inbound
        ? [
            ...[...f.inbound.rows].sort(inboundOrder).map((row) => ({
              tag: { kind: 'po', row } as SupplyTag,
              qty: row.remaining,
            })),
            { tag: { kind: 'unlisted' } as SupplyTag, qty: f.inbound.truncatedRemaining },
            { tag: { kind: 'hidden' } as SupplyTag, qty: f.inbound.hiddenRemaining },
          ]
        : [],
    );
    supply.skip(f.committedOtherShortfall);

    let heldLeft = f.heldOwn;
    const draftUnits = qn.draftRemaining;

    for (const l of itemLines) {
      const owed = q4(lineOwedUnits({ quantityRequested: l.requested, quantityFulfilled: l.fulfilled }));
      let need = owed;
      const units: ReadinessLineUnits = { ready: 0, noRack: 0, putAway: 0, gap: 0, awaiting: 0, short: 0 };

      if (blocked) {
        units.short = need;
        need = 0;
      } else {
        for (const part of shelf.take(need)) {
          units.ready = q4(units.ready + part.qty);
          if (part.tag === 'norack') units.noRack = q4(units.noRack + part.qty);
          need = q4(need - part.qty);
        }
        const pa = min(need, putAwayLeft);
        units.putAway = pa;
        putAwayLeft = q4(putAwayLeft - pa);
        need = q4(need - pa);
        const gp = min(need, gapLeft);
        units.gap = gp;
        gapLeft = q4(gapLeft - gp);
        need = q4(need - gp);
        const aw = min(need, awaitingLeft);
        units.awaiting = aw;
        awaitingLeft = q4(awaitingLeft - aw);
        need = q4(need - aw);
        units.short = need;
      }

      // Where the awaited units come from.
      const poShares: ReadinessPoShare[] = [];
      if (units.awaiting > EPS) {
        for (const part of supply.take(units.awaiting)) {
          const tag = part.tag;
          poShares.push(
            tag.kind === 'po'
              ? {
                  kind: 'po',
                  poId: tag.row.poId,
                  poNumber: tag.row.poNumber,
                  expectedAt: tag.row.expectedAt,
                  poRemaining: tag.row.remaining,
                  units: part.qty,
                }
              : { kind: tag.kind, poId: null, poNumber: null, expectedAt: null, poRemaining: null, units: part.qty },
          );
        }
      }

      // State: the worst bucket the line touches.
      const touched: ReadinessLineState[] = [];
      const reasons: ReadinessReason[] = [];
      if (units.short > EPS) {
        touched.push('short');
        reasons.push(blocked ?? 'insufficient');
      }
      if (qn.recordsDisagree && !blocked && owed > EPS) {
        touched.push('unknown');
        reasons.push('records_disagree');
      } else if (units.gap > EPS) {
        touched.push('unknown');
        reasons.push('held_elsewhere');
      }
      if (units.awaiting > EPS) {
        touched.push('awaiting_po');
        reasons.push('on_order');
      }
      if (units.putAway > EPS) {
        touched.push('needs_put_away');
        reasons.push('in_staging');
      }
      // A line that owes nothing touches no bucket: it is handed over, never
      // "Ready to pick".
      const state: ReadinessLineState = owed <= EPS ? 'handed_over' : worstOf(touched);

      const notes: ReadinessNote[] = [];
      if (owed <= EPS) notes.push('nothing_owed');
      if (units.noRack > EPS) notes.push('no_rack_recorded');
      let expectedAt: string | null = null;
      if (poShares.length > 0) {
        const known = poShares.map((s) => timeOf(s.expectedAt));
        const allDated = known.every((t) => t !== null);
        const latestKnown = known.reduce<number | null>(
          (m, t) => (t === null ? m : m === null ? t : Math.max(m, t)),
          null,
        );
        if (allDated && latestKnown !== null) {
          expectedAt =
            poShares.find((s) => timeOf(s.expectedAt) === latestKnown)?.expectedAt ?? null;
        } else {
          notes.push('no_expected_date');
        }
        if (poShares.some((s) => s.kind === 'hidden')) notes.push('on_hidden_po');
        // By calendar day: the PO's (UTC) day after the needed-by's day in
        // the org's zone. Comparing the instants would read a PO due the day
        // after an evening needed-by as on time (midnight UTC is the
        // afternoon before, west of UTC). If the runtime cannot name a day,
        // the instants are compared (the old, looser rule).
        const latestDay = poDayKey(latestKnown === null ? null : new Date(latestKnown).toISOString());
        const after =
          latestDay !== null && neededByDay !== null
            ? latestDay > neededByDay
            : neededByMs !== null && latestKnown !== null && latestKnown > neededByMs;
        if (after) notes.push('expected_after_needed_by');
      }
      if (units.short > EPS && draftUnits > EPS) notes.push('on_draft_po');
      if (units.short > EPS && (f.pendingOthers?.orders ?? 0) > 0) notes.push('pending_others');
      if (f.isBundle) notes.push('kit_stock');

      let hold: ReadinessHold | null = null;
      if (holdAnnotated && owed > EPS) {
        const held = min(owed, heldLeft);
        heldLeft = q4(heldLeft - held);
        hold =
          held >= owed - EPS
            ? { state: 'held', held, of: owed }
            : held > EPS
              ? { state: 'partly_held', held, of: owed }
              : { state: 'not_held', held: 0, of: owed };
      }

      assessed.set(l.lineId, {
        lineId: l.lineId,
        itemId,
        position: position.get(l.lineId) ?? 0,
        requested: l.requested,
        fulfilled: l.fulfilled,
        picked: l.picked,
        owed,
        state,
        reasons,
        notes,
        units,
        expectedAt,
        poShares,
        hold,
        itemName: f.name,
        itemSku: f.sku,
      });
    }
  }

  const outLines = lines
    .map((l) => assessed.get(l.lineId))
    .filter((l): l is ReadinessLineAssessment => l !== undefined);
  const counts = { ...EMPTY_COUNTS };
  for (const l of outLines) counts[l.state] += 1;
  // Handed-over lines have nothing to pick: green is over the lines still
  // owed, and needs at least one.
  const owedLineCount = outLines.length - counts.handed_over;
  const green = owedLineCount > 0 && counts.ready === owedLineCount;
  const atRisk =
    counts.short > 0 ||
    counts.unknown > 0 ||
    outLines.some(
      (l) =>
        l.state === 'awaiting_po' &&
        (l.notes.includes('no_expected_date') || l.notes.includes('expected_after_needed_by')),
    );

  return {
    phase: 'to_pick',
    observedAt: facts.observedAt,
    order: facts.order,
    linesCapped: false,
    holdAnnotated,
    lines: outLines,
    items,
    rollup: {
      lineCount: outLines.length,
      owedLineCount,
      counts,
      ready: green,
      capped: false,
      neededBy: facts.order.neededBy,
      neededBySignal: neededBySignalFor(facts.order.neededBy, nowMs, atRisk),
    },
  };
}

// ── Stock flags (the Approve partial / Resume gates) ────────────────────────

/**
 * What the order screen's stock-dependent actions need, fed by readiness.
 * `ok` numbers are the frozen RPCs' own: approve and approve_partial compare
 * each item's REQUESTED total against max(0, on hand - every active hold);
 * resume_fulfillment its OWED total against the same.
 */
export type OrderStockCheck =
  /** Not a stock-dependent status. */
  | { state: 'not_needed' }
  | {
      state: 'ok';
      /** pending_approval: a strict Approve would be refused. */
      isShortStock: boolean;
      /** backordered: Resume would hold something. */
      hasFulfillableStock: boolean;
      /** An item now belongs to another warehouse: approve_partial and
       *  resume_fulfillment refuse the order (item_warehouse_mismatch). */
      itemMoved?: boolean;
      /** pending_approval: lines whose item a strict Approve refuses. */
      shortLineCount?: number;
    }
  /**
   * `read`: the read failed (retrying can help).
   * `hidden_items`: an item on the order is not readable to this viewer.
   * `lines_capped`: more than 200 lines; readiness is not checked.
   */
  | { state: 'failed'; reason: 'read' | 'hidden_items' | 'lines_capped'; message: string };

/**
 * The stock flags from a readiness result. A failed read, a hidden item or a
 * capped order is `failed`, never flags with zeros in them.
 */
export function readinessStockFlags(result: OrderReadinessResult): OrderStockCheck {
  if (result.state === 'failed') return { state: 'failed', reason: 'read', message: result.message };
  const a = result.assessment;
  const status = a.order.status;
  if (status !== 'pending_approval' && status !== 'backordered') return { state: 'not_needed' };
  if (a.phase !== 'to_pick') return { state: 'not_needed' };
  if (a.linesCapped) {
    return {
      state: 'failed',
      reason: 'lines_capped',
      message: `This order has more than ${READINESS_LINE_CAP} lines.`,
    };
  }
  if (a.lines.length === 0) return { state: 'not_needed' };
  const hidden = a.items.filter((it) => !it.visible);
  if (hidden.length > 0) {
    return {
      state: 'failed',
      reason: 'hidden_items',
      message: `${hidden.length} item${hidden.length === 1 ? '' : 's'} on this order did not load.`,
    };
  }
  let isShortStock = false;
  let hasFulfillableStock = false;
  let itemMoved = false;
  const shortItems = new Set<string>();
  for (const it of a.items) {
    const qn = it.quantities;
    if (!qn || !it.facts) continue;
    if (it.facts.itemWarehouseId !== a.order.warehouseId) itemMoved = true;
    if (status === 'pending_approval' && qn.requested > qn.approveAvailable + EPS) {
      isShortStock = true;
      shortItems.add(it.itemId);
    }
    if (status === 'backordered' && qn.demand > EPS && qn.approveAvailable > EPS) {
      hasFulfillableStock = true;
    }
  }
  return {
    state: 'ok',
    isShortStock,
    hasFulfillableStock,
    itemMoved,
    shortLineCount: a.lines.filter((l) => shortItems.has(l.itemId)).length,
  };
}

// ── Reconcile (the facts must describe the order on screen) ─────────────────

/** A screen read the order (its header and lines) and its facts a moment
 *  apart, and the order moved in between. */
export const READINESS_ORDER_CHANGED_COPY = 'The order changed while it was being checked. Check again.';

/** uuids compare case-insensitively (the database answers in lower case). */
function sameId(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * The web page and the phone read the order (header and lines) and its facts
 * a moment apart. If the order moved in between (another status, a line added
 * or removed), the facts describe a different order than the screen shows:
 * the answer is `failed` ("The order changed while it was being checked."),
 * never a mix of the two. A capped or closed answer carries no lines, so only
 * its status is compared. Pure; the same on both platforms.
 */
export function reconcileReadiness(
  result: OrderReadinessResult,
  shown: { status: string; lineIds: readonly (string | null | undefined)[] },
): OrderReadinessResult {
  if (result.state === 'failed') return result;
  const a = result.assessment;
  const changed: OrderReadinessResult = { state: 'failed', message: READINESS_ORDER_CHANGED_COPY };
  if (a.order.status !== shown.status) return changed;
  if (a.phase === 'closed' || a.linesCapped) return result;
  const theirs = new Set(a.lines.map((l) => l.lineId.toLowerCase()));
  const ours = new Set(
    shown.lineIds.filter((x): x is string => typeof x === 'string').map((x) => x.toLowerCase()),
  );
  const same = theirs.size === ours.size && [...ours].every((id) => theirs.has(id));
  return same ? result : changed;
}

/** Whether an answer is about this order (uuids, any case). */
export function readinessAnswersOrder(facts: OrderReadinessFacts, orderId: string): boolean {
  return sameId(facts.order.id, orderId);
}

// ── Completion projection (the complete_picking twin) ───────────────────────

export interface CompletionProjectionLine {
  lineId: string;
  itemId: string;
  position: number;
  itemName: string | null;
  owed: number;
  /** What complete_picking would set quantity_picked to; null when it cannot
   *  be known (a one-click pick of an item the caller cannot read). */
  batch: number | null;
}

export interface CompletionProjection {
  /** The order is at a status complete_picking accepts. */
  applicable: boolean;
  /** Every quantity_picked is null: the one-click path. */
  oneClick: boolean;
  lines: CompletionProjectionLine[];
  /** Lines whose batch is below what they owe (they will be owed at
   *  hand-over). */
  shortLines: CompletionProjectionLine[];
  /** The draw would fail (P0001) and roll the whole completion back. */
  willFail: boolean;
  failingItems: Array<{
    itemId: string;
    itemName: string;
    reason: 'insufficient_placed_stock' | 'insufficient_stock';
    /** Of the units the draw cannot find, those in Staging (here or in
     *  another warehouse): put them away first. */
    needPutAway: number;
    /** The rest: on record, but in no location at all (on record and the
     *  locations disagree; a count settles it). The draw engine raises the
     *  same insufficient_placed_stock for these, with nothing in Staging. */
    unaccounted: number;
  }>;
  /** Items whose numbers are unknown (not readable, or the order is capped):
   *  the projection cannot promise anything about them. */
  unknownItemIds: string[];
  capped: boolean;
}

/**
 * What complete_picking would do now. One-click: each line takes
 * min(owed, available), where available is on hand net of other orders' and
 * rentals' holds, consumed in line order (the RPC re-reads per line, and there
 * are no duplicate-item lines in production: the parity fixture excludes them
 * from the exact claim). Otherwise min(picked, owed). The draw fails when an
 * item's batch exceeds its pickable holdings in ANY warehouse (Staging never
 * counts), or its on hand.
 */
export function projectCompletePicking(
  assessment: OrderReadinessAssessment,
): CompletionProjection | null {
  if (assessment.phase !== 'to_pick') return null;
  const applicable = COMPLETE_PICKING_STATUSES.includes(assessment.order.status);
  if (assessment.linesCapped) {
    return {
      applicable,
      oneClick: false,
      lines: [],
      shortLines: [],
      willFail: false,
      failingItems: [],
      unknownItemIds: [],
      capped: true,
    };
  }
  const oneClick = assessment.lines.every((l) => l.picked === null);
  const byItem = new Map(assessment.items.map((it) => [it.itemId, it]));
  const availableLeft = new Map<string, number>();
  const batchByItem = new Map<string, number>();
  const unknown = new Set<string>();
  const out: CompletionProjectionLine[] = [];

  for (const l of assessment.lines) {
    const it = byItem.get(l.itemId);
    const qn = it?.quantities ?? null;
    let batch: number | null;
    if (oneClick) {
      if (!qn) {
        batch = null;
        unknown.add(l.itemId);
      } else {
        const left = availableLeft.get(l.itemId) ?? qn.available;
        batch = min(l.owed, left);
        availableLeft.set(l.itemId, q4(left - batch));
      }
    } else {
      batch = min(l.picked ?? 0, l.owed);
      if (!qn) unknown.add(l.itemId);
    }
    if (batch !== null) batchByItem.set(l.itemId, q4((batchByItem.get(l.itemId) ?? 0) + batch));
    out.push({
      lineId: l.lineId,
      itemId: l.itemId,
      position: l.position,
      itemName: l.itemName,
      owed: l.owed,
      batch,
    });
  }

  const failingItems: CompletionProjection['failingItems'] = [];
  for (const [itemId, total] of batchByItem) {
    const it = byItem.get(itemId);
    if (!it?.facts || !it.quantities) continue;
    const drawable = q4(it.quantities.pickable + it.facts.elsewhere.pickable);
    if (total > it.facts.onHand + EPS) {
      failingItems.push({
        itemId,
        itemName: it.facts.name,
        reason: 'insufficient_stock',
        needPutAway: 0,
        unaccounted: 0,
      });
    } else if (total > drawable + EPS) {
      // What the draw cannot find: Staging first (putting it away helps),
      // then what no location holds at all (never "in Staging").
      const missing = q4(total - drawable);
      const needPutAway = min(missing, q4(it.facts.here.staging + it.facts.elsewhere.staging));
      failingItems.push({
        itemId,
        itemName: it.facts.name,
        reason: 'insufficient_placed_stock',
        needPutAway,
        unaccounted: q4(missing - needPutAway),
      });
    }
  }

  return {
    applicable,
    oneClick,
    lines: out,
    shortLines: out.filter((l) => l.batch !== null && l.batch < l.owed - EPS),
    willFail: failingItems.length > 0,
    failingItems,
    unknownItemIds: [...unknown],
    capped: false,
  };
}

// ── Audience ────────────────────────────────────────────────────────────────

export type ReadinessAudience = 'full' | 'requester' | 'none';

/**
 * Who sees what (section 3.4 of the F2 plan): the full panel for anyone who
 * approves orders, picks (items:update) or buys (purchase_orders:manage); one
 * sentence for the requester; nothing, and no read at all, for everyone else.
 * The facts function answers any member who can read the order; the per-field
 * gates (items, other pending demand, PO references) are in SQL.
 */
export function readinessAudience(input: {
  canApproveOrders: boolean;
  canUpdateItems: boolean;
  canManagePurchaseOrders: boolean;
  isOwnRequest: boolean;
}): ReadinessAudience {
  if (input.canApproveOrders || input.canUpdateItems || input.canManagePurchaseOrders) return 'full';
  if (input.isOwnRequest) return 'requester';
  return 'none';
}
