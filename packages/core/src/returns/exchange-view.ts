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
import { EXCHANGE_STATUS_STAFF_LABELS, replacementPartlySent, type ExchangeStatus } from './exchange-status';
import {
  approveReplacementSentence,
  availableLabel,
  deliverToSiteLabel,
  itemQuantityLabel,
  originalExchangeLine,
  pickingWaitsSentence,
  qtyHandedOverLabel,
  qtyRequestedLabel,
  RETURNS_COPY,
  shortLabel,
  whenProcessedSentence,
  type ProcessDestination,
} from './returns-copy';

// ── The REPLACEMENT card's status ──────────────────────────────────────────

/** An exchange line's status (return_exchange_lines.status). */
export type ExchangeLineStatus = 'requested' | 'approved' | 'declined' | 'cancelled';

/**
 * The words the REPLACEMENT card shows for its exchange line: the pill on the
 * web and on the phone, and the end of the phone card's VoiceOver label (the
 * card is one accessible element there, so the pill alone is never read;
 * RX-2 simulator finding SIM-1). One rule for all three.
 */
export function exchangeLineStatusLabel(status: ExchangeLineStatus): string {
  if (status === 'requested') return RETURNS_COPY.replacementRequested;
  if (status === 'approved') return RETURNS_COPY.replacementApproved;
  if (status === 'declined') return RETURNS_COPY.replacementDeclined;
  return RETURNS_COPY.replacementCancelled;
}

/**
 * The replacement shown on the RMA, as far as the REPLACEMENT card reads it:
 * the workbench's own replacement block (the live replacement, else the
 * newest cancelled one), on the web and in the phone's API answer alike.
 */
export interface ReplacementCardReplacement {
  /** Not cancelled or denied. */
  live: boolean;
  /** Its order status. */
  status: string;
  /** Its order lines: the item, how many were asked and how many were handed over. */
  lines: ReadonlyArray<{ itemId: string; requested: number; fulfilled: number }>;
}

/** All of the line's replacement handed over, part of it, or the order closed with none of it sent. */
export type ReplacementLineHandOver = 'all' | 'part' | 'none_sent';

const n0 = (v: unknown): number => {
  const x = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(x) ? x : 0;
};

/**
 * What became of an APPROVED exchange line's replacement (returns RX-3 PR
 * stage, polish (a), from the RX-2 Demo Co walk). return_exchange_lines.status
 * stays 'approved' after the hand-over (0396 has no later line status), so the
 * outcome is read from the live replacement order's line for the approved
 * item: quantity_fulfilled is what was handed over. Two exchange lines asking
 * for the same item share one order line (the replacement merges them), so
 * the reading is per item.
 *
 * Null (show the stored status) for a line that is not approved, without an
 * approved item, without a live replacement, or whose replacement is still
 * to be handed over.
 */
export function replacementLineHandOver(
  line: { status: ExchangeLineStatus; approvedItemId: string | null },
  replacement: ReplacementCardReplacement | null | undefined,
): ReplacementLineHandOver | null {
  if (line.status !== 'approved' || !line.approvedItemId || !replacement || !replacement.live) return null;
  const rows = replacement.lines.filter((l) => l.itemId === line.approvedItemId);
  if (rows.length === 0) return null;
  const requested = rows.reduce((t, l) => t + n0(l.requested), 0);
  const fulfilled = rows.reduce((t, l) => t + n0(l.fulfilled), 0);
  if (requested > 0 && fulfilled >= requested) return 'all';
  if (fulfilled > 0) return 'part';
  // Closed (completed) with nothing of this item handed over: the rest of a
  // part-sent replacement closed by a cancel or as delivered-partial.
  if (replacement.status === 'completed') return 'none_sent';
  return null;
}

/**
 * The REPLACEMENT card's pill, web and phone: the outcome once the
 * replacement was handed over (Handed over, Partly handed over, Not sent),
 * else the stored status (Requested, Approved, Declined, Cancelled).
 */
export function replacementCardStatusLabel(
  line: { status: ExchangeLineStatus; approvedItemId: string | null },
  replacement: ReplacementCardReplacement | null | undefined,
): string {
  switch (replacementLineHandOver(line, replacement)) {
    case 'all':
      return RETURNS_COPY.replacementHandedOver;
    case 'part':
      return RETURNS_COPY.replacementPartlyHandedOver;
    case 'none_sent':
      return RETURNS_COPY.replacementNotSent;
    default:
      return exchangeLineStatusLabel(line.status);
  }
}

/**
 * The REPLACEMENT card's quantity: "Qty handed over: 2" once all of it was
 * handed over, else "Qty requested: 2" (the approved quantity, else the one
 * asked for). Part handed over keeps the quantity asked for: lines that ask
 * for the same item share one order line, so a per-line count is not known.
 */
export function replacementCardQuantityLabel(
  line: { status: ExchangeLineStatus; approvedItemId: string | null; approvedQuantity: number | null; requestedQuantity: number },
  replacement: ReplacementCardReplacement | null | undefined,
): string {
  const qty = line.approvedQuantity ?? line.requestedQuantity;
  return replacementLineHandOver(line, replacement) === 'all' ? qtyHandedOverLabel(qty) : qtyRequestedLabel(qty);
}

// ── The original order's returns section ───────────────────────────────────

/**
 * One exchange line of the original order's returns section, the web order
 * page and the phone's order screen (returns RX-3 PR stage, polish (d), from
 * the RX-2 Demo Co walk: a cancelled RMA's card showed no exchange line,
 * because declined and cancelled lines were left out). Each line reads in its
 * own words:
 *
 *   approved   "Exchange: Large ×1 → SO-000104 (<the RMA's exchange status>)"
 *   requested  "Exchange: Large ×1 (Exchange requested)"
 *   declined   "Exchange: Large ×1 (Exchange declined)"
 *   cancelled  the RMA's words when the whole exchange was cancelled or its
 *              replacement was ("Exchange cancelled", "Replacement cancelled:
 *              …"), else "Exchange cancelled"
 *
 * Only an approved line names the replacement order: a cancelled replacement
 * is listed on its RMA. A request made with a note names no item until one is
 * approved: "Warehouse will review" while requested, "A different
 * replacement" once it ended (the requester tracking's words).
 */
export function originalExchangeLineFor(input: {
  /** return_exchange_lines.status. */
  status: string;
  /** "Walk Exchange Tee, L" (the approved item, else the one asked for); null for a note. */
  itemLabel: string | null;
  quantity: number;
  /** The RMA's replacement order (the live one). */
  replacementOrderNumber: number | null;
  /** The RMA's exchange status and its staff words (exchangeStatusStaffLabel). */
  exchangeStatus: ExchangeStatus;
  statusWords: string;
}): string {
  const what = input.itemLabel
    ? itemQuantityLabel(input.itemLabel, input.quantity)
    : input.status === 'requested'
      ? RETURNS_COPY.replacementWarehouseReview
      : RETURNS_COPY.replacementAskedByNote;
  switch (input.status) {
    case 'approved':
      return originalExchangeLine(what, input.replacementOrderNumber, input.statusWords);
    case 'declined':
      return originalExchangeLine(what, null, EXCHANGE_STATUS_STAFF_LABELS.declined);
    case 'cancelled':
      return originalExchangeLine(
        what,
        null,
        input.exchangeStatus === 'cancelled' || input.exchangeStatus === 'replacement_cancelled'
          ? input.statusWords
          : EXCHANGE_STATUS_STAFF_LABELS.cancelled,
      );
    default:
      return originalExchangeLine(what, null, input.statusWords);
  }
}

// ── The outbound rail ──────────────────────────────────────────────────────

export type RailStepId = 'requested' | 'reserved' | 'gate' | 'picking' | 'ready' | 'handed_over';
/**
 * done; the one being waited on (current); still to come (upcoming, "next");
 * where the exchange stopped (declined, cancelled, a replacement cancelled, or
 * a replacement closed with part never sent); after a declined or cancelled
 * exchange's stop, a step never reached (skipped); after a replacement
 * cancel, a step not started (a new replacement may still be issued).
 */
export type RailStepState = 'done' | 'current' | 'upcoming' | 'stopped' | 'skipped' | 'not_started';

/** Each step state in words: the web's step text and both screen readers. */
export const RAIL_STEP_STATE_WORDS: Readonly<Record<RailStepState, string>> = {
  done: RETURNS_COPY.railStateDone,
  current: RETURNS_COPY.railStateNow,
  upcoming: RETURNS_COPY.railStateNext,
  stopped: RETURNS_COPY.railStateStopped,
  skipped: RETURNS_COPY.railStateNotReached,
  not_started: RETURNS_COPY.railStateNotStarted,
};

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
  /** The replacement shown: its order status (review fix P21). */
  replacementStatus?: string | null;
  /** What that replacement still owes (requested minus handed over). */
  replacementOwed?: number | null;
  /**
   * The replacement shown held stock at some point (its holds, released or
   * not). Read for a cancelled exchange only: after Cancel return following an
   * approval the replacement had reached Reserved and waited, so the rail
   * keeps Reserved done and stops at the gate (RX-2 verification L12). Null
   * or false: unknown or never held, the stop stays at Reserved.
   */
  replacementWasReserved?: boolean | null;
}

const RAIL_ORDER: readonly RailStepId[] = ['requested', 'reserved', 'gate', 'picking', 'ready', 'handed_over'];

const PARTLY_SENT_END: readonly ExchangeStatus[] = ['completed', 'handed_over_return_open', 'handed_over_return_cancelled'];

/**
 * Requested, Reserved or Not in stock, Waiting for return or Released early
 * (or Return received), Picking, Ready for pickup or Out for delivery, Handed
 * over (plan RX-2 web UI). Empty for a return without an exchange.
 *
 * Review fixes: after a stop nothing is next. A declined or cancelled
 * exchange's later steps were never reached (skipped); after a replacement
 * cancel they have not started; either way each reads its plain name (P4). A
 * replacement closed with part never sent ends "Partly handed over", stopped
 * (P21, exchange-status.ts replacementPartlySent).
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
  // What the steps after a stop are.
  let after: RailStepState = 'upcoming';
  switch (ex) {
    case 'requested':
      current = 0;
      break;
    case 'declined':
    case 'cancelled':
    case 'replacement_cancelled':
      stopped = true;
      after = ex === 'replacement_cancelled' ? 'not_started' : 'skipped';
      if (ex === 'cancelled' && input.returnStatus !== 'denied' && input.replacementWasReserved === true) {
        // L12: the RMA was cancelled after its replacement was reserved and
        // waited for the return: Reserved stays done, the stop is the gate.
        current = 2;
        labels.gate = RETURNS_COPY.railCancelled;
        break;
      }
      current = 1;
      labels.reserved = ex === 'declined' || input.returnStatus === 'denied' ? RETURNS_COPY.railDeclined : RETURNS_COPY.railCancelled;
      // The replacement never reached the gate: its plain name, never
      // "Return received" or "Released early".
      labels.gate = RETURNS_COPY.railWaitingForReturn;
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
      // completed, handed_over_return_open, handed_over_return_cancelled:
      // every step done, unless part was never sent (P21).
      if (
        PARTLY_SENT_END.includes(ex) &&
        replacementPartlySent({ replacementStatus: input.replacementStatus, replacementOwed: input.replacementOwed })
      ) {
        current = RAIL_ORDER.length - 1;
        stopped = true;
        labels.handed_over = RETURNS_COPY.railPartlyHandedOver;
      } else {
        current = RAIL_ORDER.length;
      }
  }
  return RAIL_ORDER.map((id, i) => ({
    id,
    label: labels[id],
    state: i < current ? 'done' : i === current ? (stopped ? 'stopped' : 'current') : after,
  }));
}

/** A step's state in words ("done", "now", "next", "stopped", "not reached", "not started"). */
export function railStepStateWords(step: Pick<RailStep, 'state'>): string {
  return RAIL_STEP_STATE_WORDS[step.state];
}

/**
 * The rail as one accessible label, for the web list and the phone's
 * VoiceOver alike: "Replacement progress: Requested, done; Declined, stopped;
 * Waiting for return, not reached; …". Empty for no rail.
 */
export function exchangeRailAccessibilityLabel(rail: readonly RailStep[]): string {
  if (rail.length === 0) return '';
  return `${RETURNS_COPY.railProgress}: ${rail.map((s) => `${s.label}, ${railStepStateWords(s)}`).join('; ')}`;
}

/**
 * Why the exchange has no replacement order (the REPLACEMENT ORDER block,
 * review fix P4): declined, cancelled with the return (a denied return's
 * exchange reads declined, as its staff label does), or not yet approved.
 */
export function noReplacementLine(
  status: ExchangeStatus,
  facts: { returnStatus?: string | null; denied?: boolean } = {},
): string {
  if (status === 'declined') return RETURNS_COPY.noReplacementDeclined;
  if (status === 'cancelled') {
    return facts.denied || facts.returnStatus === 'denied' ? RETURNS_COPY.noReplacementDeclined : RETURNS_COPY.noReplacementCancelled;
  }
  return RETURNS_COPY.noReplacementYet;
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

// ── The approval's exchange review (web and phone) ───────────────────────────

/** One requested exchange line's choice at approval (plan RX-2 web UI):
 *  approve as requested, change the replacement (with a reason when it
 *  differs from the request), or decline with a reason. */
export type ExchangeReviewState =
  | { kind: 'as_requested' }
  | { kind: 'change'; itemId: string | null; label: string | null; free: number | null; quantity: number; reason: string }
  | { kind: 'decline'; reason: string };

/** The fields of an exchange line the review reads. */
export interface ExchangeReviewLine {
  id: string;
  requestedItemId: string | null;
  requestNote: string | null;
}

/**
 * The review header's accessible label (review fix P26): "Walk Exchange Tee -
 * M, exchange for Walk Exchange Tee - L" (VoiceOver reads the visible "→" as
 * "right arrow"); for a note-only request, "…, exchange: Warehouse will
 * review".
 */
export function exchangeReviewHeaderLabel(returned: string, replacement: string | null): string {
  return replacement ? `${returned}, exchange for ${replacement}` : `${returned}, exchange: ${RETURNS_COPY.replacementWarehouseReview}`;
}

/** Who is reviewing: approving or changing a replacement needs order approval. */
export interface ExchangeReviewViewer {
  canApproveOrders: boolean;
}

/** One choice of the review, as the web radio and the phone row show it. */
export interface ExchangeReviewOption {
  kind: ExchangeReviewState['kind'];
  label: string;
  disabled: boolean;
}

/** "Change replacement. Needs order approval permission." (an off choice opens nothing, so no ellipsis). */
function needsOrderApprovalLabel(label: string): string {
  return `${label.replace(/…$/, '')}. ${RETURNS_COPY.needsOrderApproval}`;
}

/**
 * The review's three choices for one requested exchange line (review fix
 * P1, web and phone): "Approve as requested" (off for a note-only request),
 * "Change replacement…", "Decline the exchange, return only". A viewer
 * without order approval may only decline (the database asks for order
 * approval to approve or add a replacement, never to decline one): the other
 * two are off and say why.
 */
export function exchangeReviewOptions(
  line: Pick<ExchangeReviewLine, 'requestedItemId'>,
  viewer: ExchangeReviewViewer,
): ExchangeReviewOption[] {
  const can = viewer.canApproveOrders;
  return [
    {
      kind: 'as_requested',
      label: can ? RETURNS_COPY.approveAsRequested : needsOrderApprovalLabel(RETURNS_COPY.approveAsRequested),
      disabled: !can || !line.requestedItemId,
    },
    {
      kind: 'change',
      label: can ? RETURNS_COPY.changeReplacementEllipsis : needsOrderApprovalLabel(RETURNS_COPY.changeReplacementEllipsis),
      disabled: !can,
    },
    { kind: 'decline', label: RETURNS_COPY.declineExchange, disabled: false },
  ];
}

/** The fields of an exchange line where the review starts reads. */
export interface ExchangeReviewStartLine {
  requestedItemId: string | null;
  /** The replacement quantity asked for. */
  requestedQuantity: number;
  /** How many of the returned item come back (the return line's quantity). */
  returnedQuantity?: number | null;
}

/**
 * Where the review starts: the decline for a viewer who can only decline;
 * else "Approve as requested", except for a request made with a note
 * ("warehouse will review"), which has nothing to approve as requested and
 * opens at "Change replacement…" with nothing chosen yet, at the quantity
 * coming back (RX-3 fix round 1, desk check M3; RX-2 verify C-4). Without the
 * line (an older caller) it starts as requested.
 */
export function defaultExchangeReviewState(viewer: ExchangeReviewViewer, line?: ExchangeReviewStartLine): ExchangeReviewState {
  if (!viewer.canApproveOrders) return { kind: 'decline', reason: '' };
  if (line && !line.requestedItemId) {
    const returned = typeof line.returnedQuantity === 'number' && line.returnedQuantity > 0 ? line.returnedQuantity : line.requestedQuantity;
    return { kind: 'change', itemId: null, label: null, free: null, quantity: Math.max(1, Math.min(line.requestedQuantity, returned)), reason: '' };
  }
  return { kind: 'as_requested' };
}

/** Why the approval cannot be sent yet for this line, or null. With the
 *  viewer, a choice they may not make is refused before anything is sent. */
export function exchangeReviewProblem(
  line: ExchangeReviewLine,
  state: ExchangeReviewState,
  viewer?: ExchangeReviewViewer,
): string | null {
  if (viewer && !viewer.canApproveOrders && state.kind !== 'decline') return RETURNS_COPY.noOrdersApprovePermission;
  if (state.kind === 'as_requested') {
    // A note-only request ("the warehouse will review") must be changed
    // first. The problem never carries the requester's note (up to 500
    // characters): it is pinned above the phone's button, and the note shows
    // in the review body (review fix, simulator fault F-A).
    return line.requestedItemId ? null : RETURNS_COPY.chooseReplacement;
  }
  if (state.kind === 'decline') return state.reason.trim() ? null : RETURNS_COPY.declineReasonLabel;
  if (!state.itemId) return RETURNS_COPY.chooseReplacement;
  if (state.itemId !== line.requestedItemId && !state.reason.trim()) return RETURNS_COPY.replacementReasonLabel;
  return null;
}

/** The decision the approval sends for one exchange line. */
export function exchangeReviewDecision(line: ExchangeReviewLine, state: ExchangeReviewState): Record<string, unknown> {
  if (state.kind === 'decline') return { action: 'decline', exchangeLineId: line.id, reason: state.reason.trim() };
  if (state.kind === 'as_requested') return { action: 'approve', exchangeLineId: line.id };
  return {
    action: 'approve',
    exchangeLineId: line.id,
    itemId: state.itemId,
    quantity: state.quantity,
    ...(state.reason.trim() ? { reason: state.reason.trim() } : {}),
  };
}

/** "Add a replacement" on a return-only line (G9): the decision, once an item is chosen. */
export function addReplacementDecision(
  returnLineId: string,
  add: { itemId: string | null; quantity: number; reason?: string | null },
): Record<string, unknown> | null {
  if (!add.itemId) return null;
  const reason = (add.reason ?? '').trim();
  return { action: 'add', returnLineId, itemId: add.itemId, quantity: add.quantity, ...(reason ? { reason } : {}) };
}

// ── Where the replacement goes (desk check F6) ──────────────────────────────

/** An active delivery site the original order's warehouse serves. */
export interface ReplacementDeliverySite {
  id: string;
  name: string;
}

/** The replacement's fulfilment override sent with an approval, a change or a re-issue. */
export interface ReplacementFulfilment {
  fulfillmentType: 'pickup' | 'delivery';
  deliveryCharterId: string | null;
}

export interface ReplacementSiteOption {
  key: string;
  label: string;
  value: ReplacementFulfilment;
}

/**
 * The choices after replacement_site_not_available (the original delivery
 * site is missing, closed or not served by the warehouse): every active site
 * the warehouse serves, by name, then "Pickup instead". Web and phone show
 * these in this order and send the chosen value as the request's
 * `replacement` (the database checks the pair again).
 */
export function replacementSiteOptions(sites: readonly ReplacementDeliverySite[] | null | undefined): ReplacementSiteOption[] {
  const out: ReplacementSiteOption[] = [...(sites ?? [])]
    .filter((s) => s && typeof s.id === 'string' && typeof s.name === 'string')
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
    .map((s) => ({ key: s.id, label: deliverToSiteLabel(s.name), value: { fulfillmentType: 'delivery', deliveryCharterId: s.id } }));
  out.push({ key: 'pickup', label: RETURNS_COPY.pickupInstead, value: { fulfillmentType: 'pickup', deliveryCharterId: null } });
  return out;
}
