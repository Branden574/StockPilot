/**
 * The exchange as the workbench, the order page and the phone show it
 * (returns RX-2, plan 3.6.9, 3.9 and section 6): the outbound rail, the
 * replacement candidates in size order, and the "What happens when you
 * approve" lines. One implementation for the web and the phone; the server
 * computes every fact these read (the view's exchange status, the live
 * replacement, free stock as on hand minus every active hold).
 *
 * Never a name heuristic: sizes come from the items' own variant columns and
 * the product group (brief 3); the candidate search itself is the database's
 * (return_exchange_candidates, under the caller's item scope).
 *
 * Plain literals and pure functions only: importing this module runs nothing.
 */

import { sortBySizeOrder } from '../sports/size-order';
import type { ExchangeStatus } from './exchange-status';
import {
  approveReplacementSentence,
  availableLabel,
  pickingWaitsSentence,
  RETURNS_COPY,
  shortLabel,
  whenProcessedSentence,
  type ProcessDestination,
} from './returns-copy';

// ── The outbound rail ──────────────────────────────────────────────────────

export type RailStepId = 'requested' | 'reserved' | 'gate' | 'picking' | 'ready' | 'handed_over';
/** done, the one being waited on (current), not reached (upcoming), or where
 *  the exchange stopped (declined, cancelled). */
export type RailStepState = 'done' | 'current' | 'upcoming' | 'stopped';

export interface RailStep {
  id: RailStepId;
  label: string;
  state: RailStepState;
}

export interface ExchangeRailInput {
  exchangeStatus: ExchangeStatus;
  /** The RMA's own status (the gate step reads "Return received" once it is). */
  returnStatus: string;
  /** A manager released the live replacement before the return arrived. */
  releasedEarly: boolean;
  /** The live replacement's fulfilment (the ready step's words). */
  fulfillmentType: 'pickup' | 'delivery' | null;
}

const RAIL_ORDER: readonly RailStepId[] = ['requested', 'reserved', 'gate', 'picking', 'ready', 'handed_over'];

/**
 * Requested, Reserved or Not in stock, Waiting for return or Released early
 * (or Return received), Picking, Ready for pickup or Out for delivery, Handed
 * over (plan RX-2 web UI). Empty for a return without an exchange.
 */
export function exchangeRail(input: ExchangeRailInput): RailStep[] {
  const ex = input.exchangeStatus;
  if (ex === 'none') return [];
  const received = input.returnStatus === 'received' || input.returnStatus === 'closed';
  const labels: Record<RailStepId, string> = {
    requested: RETURNS_COPY.railRequested,
    reserved: ex === 'unavailable' ? RETURNS_COPY.railNotInStock : RETURNS_COPY.railReserved,
    gate: received
      ? RETURNS_COPY.railReturnReceived
      : input.releasedEarly
        ? RETURNS_COPY.railReleasedEarly
        : RETURNS_COPY.railWaitingForReturn,
    picking: RETURNS_COPY.railPicking,
    ready: input.fulfillmentType === 'delivery' ? RETURNS_COPY.railOutForDelivery : RETURNS_COPY.railReadyForPickup,
    handed_over: ex === 'partly_handed_over' ? RETURNS_COPY.railPartlyHandedOver : RETURNS_COPY.railHandedOver,
  };
  let current: number;
  let stopped = false;
  switch (ex) {
    case 'requested':
      current = 0;
      break;
    case 'declined':
    case 'cancelled':
    case 'replacement_cancelled':
      current = 1;
      stopped = true;
      labels.reserved = ex === 'declined' || input.returnStatus === 'denied' ? RETURNS_COPY.railDeclined : RETURNS_COPY.railCancelled;
      break;
    case 'unavailable':
      current = 1;
      break;
    case 'waiting_for_return':
      current = 2;
      break;
    case 'ready_to_pick':
    case 'in_progress':
      current = 3;
      break;
    case 'ready_for_pickup':
    case 'out_for_delivery':
      current = 4;
      if (ex === 'out_for_delivery') labels.ready = RETURNS_COPY.railOutForDelivery;
      break;
    case 'partly_handed_over':
      current = 5;
      break;
    default:
      // completed, handed_over_return_open, handed_over_return_cancelled
      current = RAIL_ORDER.length;
  }
  return RAIL_ORDER.map((id, i) => ({
    id,
    label: labels[id],
    state: i < current ? 'done' : i === current ? (stopped ? 'stopped' : 'current') : 'upcoming',
  }));
}

// ── Replacement candidates ─────────────────────────────────────────────────

export interface ExchangeCandidate {
  itemId: string;
  name: string | null;
  sku: string | null;
  variantSize: string | null;
  variantKey: string | null;
  groupId: string | null;
  /** In the returned item's product group. */
  sibling: boolean;
  /** The returned item itself (staff may swap a damaged unit for the same size). */
  isReturnedItem: boolean;
  onHand: number;
  held: number;
  /** On hand minus every active hold (the rule approve_partial uses). */
  free: number;
}

export interface ExchangeCandidatesAnswer {
  orderId: string;
  orderRequestLineId: string;
  returnedItemId: string | null;
  groupId: string | null;
  siblings: ExchangeCandidate[];
  matches: ExchangeCandidate[];
}

export interface ExchangeCandidateRow extends ExchangeCandidate {
  /** "Available: 14", or "Short: 0 available, 1 needed." when below what is asked. */
  availability: string;
  short: boolean;
}

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function candidateOf(raw: unknown): ExchangeCandidate | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const itemId = str(r.itemId);
  if (!itemId) return null;
  return {
    itemId,
    name: str(r.name),
    sku: str(r.sku),
    variantSize: str(r.variantSize),
    variantKey: str(r.variantKey),
    groupId: str(r.groupId),
    sibling: r.sibling === true,
    isReturnedItem: r.isReturnedItem === true,
    onHand: num(r.onHand),
    held: num(r.held),
    free: Math.max(0, num(r.free)),
  };
}

/** The database answer (return_exchange_candidates) parsed defensively. */
export function parseExchangeCandidates(raw: unknown): ExchangeCandidatesAnswer {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const list = (v: unknown): ExchangeCandidate[] =>
    (Array.isArray(v) ? v : []).map(candidateOf).filter((c): c is ExchangeCandidate => c !== null);
  return {
    orderId: str(r.orderId) ?? '',
    orderRequestLineId: str(r.orderRequestLineId) ?? '',
    returnedItemId: str(r.returnedItemId),
    groupId: str(r.groupId),
    siblings: list(r.siblings),
    matches: list(r.matches),
  };
}

/**
 * The picker's rows: the returned item's group siblings first, in size order
 * (the item's own variant size, never a name), then the name and SKU matches
 * in the database's name order; each with its availability for the quantity
 * asked.
 */
export function exchangeCandidateRows(
  answer: Pick<ExchangeCandidatesAnswer, 'siblings' | 'matches'>,
  needed: number,
): { siblings: ExchangeCandidateRow[]; matches: ExchangeCandidateRow[] } {
  const row = (c: ExchangeCandidate): ExchangeCandidateRow => {
    const short = c.free < needed;
    return { ...c, short, availability: short ? shortLabel(c.free, needed) : availableLabel(c.free) };
  };
  return {
    siblings: sortBySizeOrder(answer.siblings, (c) => c.variantSize).map(row),
    matches: answer.matches.map(row),
  };
}

// ── What happens when you approve ──────────────────────────────────────────

export interface ApprovalPreviewLine {
  /** "New Hire Shirt, M" (core returnLineLabel). */
  returnedLabel: string;
  destination: ProcessDestination;
}

export interface ApprovalPreviewExchange {
  /** "New Hire Shirt, M" for the returned line it belongs to. */
  returnedLabel: string;
  decision: 'approve' | 'decline' | 'add' | 'pending';
  /** "New Hire Shirt, L" for the replacement chosen. */
  replacementLabel: string | null;
  quantity: number;
  /** Free stock of the chosen item (null when unknown). */
  available: number | null;
}

/**
 * The review's "What happens when you approve" (plan section 6): nothing
 * moves now; the replacement order and its reservation (or what is short);
 * picking waits for the returned item unless it is here; and where each
 * returned line goes when processed.
 */
export function approvalPreviewLines(input: {
  lines: ApprovalPreviewLine[];
  exchanges: ApprovalPreviewExchange[];
  itemIsHere: boolean;
}): string[] {
  const out: string[] = [RETURNS_COPY.approveNothingMoves];
  const approved = input.exchanges.filter((x) => (x.decision === 'approve' || x.decision === 'add') && x.replacementLabel);
  for (const x of approved) {
    out.push(approveReplacementSentence(x.replacementLabel as string, x.quantity, x.available));
  }
  if (approved.length > 0) {
    out.push(pickingWaitsSentence(approved[0]!.returnedLabel, input.itemIsHere, approved.length > 1));
  }
  for (const l of input.lines) out.push(whenProcessedSentence(l.destination, l.returnedLabel));
  return out;
}
