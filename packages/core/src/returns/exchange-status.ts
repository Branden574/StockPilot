/**
 * The exchange status of an RMA: DERIVED, never stored (returns plan 3.10,
 * graft G4). The RMA keeps its six statuses; this is the second, separate
 * answer the workbench, the lists and the requester tracking show BESIDE it,
 * never merged into it (brief 8).
 *
 * RX-2 computes it in ONE SQL CASE inside `return_overview`, between
 * `-- exchange-status:begin` and `-- exchange-status:end` markers, and a
 * vitest deep-equals that CASE's codes against `EXCHANGE_STATUSES` below. In
 * RX-1 no exchange can exist, so every RMA reads `none`.
 *
 * First match wins, in this order (the order of `EXCHANGE_STATUSES`).
 * `unavailable` outranks the waiting and ready codes because a shortage is
 * what someone must act on.
 *
 * Plain literals and pure functions only: importing this module runs nothing.
 */

import type { ReturnStatus } from '../orders/order-returns-view';

export const EXCHANGE_STATUSES = [
  'none',
  'handed_over_return_cancelled',
  'cancelled',
  'requested',
  'declined',
  'completed',
  'handed_over_return_open',
  'partly_handed_over',
  'out_for_delivery',
  'ready_for_pickup',
  'in_progress',
  'replacement_cancelled',
  'unavailable',
  'waiting_for_return',
  'ready_to_pick',
] as const;

export type ExchangeStatus = (typeof EXCHANGE_STATUSES)[number];

export function isExchangeStatus(value: unknown): value is ExchangeStatus {
  return typeof value === 'string' && (EXCHANGE_STATUSES as readonly string[]).includes(value);
}

/** Staff words (plan 3.10). `none` is the plain "Return" type. */
export const EXCHANGE_STATUS_STAFF_LABELS: Record<ExchangeStatus, string> = {
  none: 'Return',
  handed_over_return_cancelled: 'Replacement handed over; return cancelled',
  cancelled: 'Exchange cancelled',
  requested: 'Exchange requested',
  declined: 'Exchange declined',
  completed: 'Exchange completed',
  handed_over_return_open: 'Replacement handed over; return not received',
  partly_handed_over: 'Partly handed over; rest on backorder',
  out_for_delivery: 'Out for delivery',
  ready_for_pickup: 'Ready for pickup',
  in_progress: 'Replacement in progress',
  replacement_cancelled: 'Replacement cancelled: issue a new one or close as return only',
  unavailable: 'Replacement unavailable (backordered)',
  waiting_for_return: 'Replacement reserved. Waiting for returned item',
  ready_to_pick: 'Ready for picking',
};

/** Facts that refine a few staff and requester words. */
export interface ExchangeStatusFacts {
  /** The RMA's own status (always shown beside the exchange status). */
  returnStatus?: ReturnStatus | string | null;
  /** `cancelled` reached through a denial reads "declined". */
  denied?: boolean;
  /** At `requested`: advice from free stock (brief 8 "Replacement available"). */
  replacementShort?: boolean | null;
}

/** The staff label with its refinements. */
export function exchangeStatusStaffLabel(status: ExchangeStatus, facts: ExchangeStatusFacts = {}): string {
  if (status === 'cancelled' && (facts.denied || facts.returnStatus === 'denied')) return 'Exchange declined';
  if (status === 'handed_over_return_open' && facts.returnStatus === 'received') {
    return 'Replacement handed over; return not processed';
  }
  if (status === 'requested' && facts.replacementShort != null) {
    return facts.replacementShort ? 'Exchange requested · replacement short' : 'Exchange requested · replacement available';
  }
  return EXCHANGE_STATUS_STAFF_LABELS[status];
}

/**
 * The requester's sentence (token page, portal, member requester). Never
 * names a rack, Staging, a disposition, a quantity on record, a cost, a
 * supplier or a staff member. `none` has no sentence (the return's own
 * status speaks).
 */
export function exchangeRequesterSentence(status: ExchangeStatus, facts: ExchangeStatusFacts = {}): string | null {
  switch (status) {
    case 'none':
      return null;
    case 'handed_over_return_cancelled':
    case 'handed_over_return_open':
      return 'Replacement handed over.';
    case 'cancelled':
      return facts.denied || facts.returnStatus === 'denied'
        ? 'Exchange request declined.'
        : 'Exchange request cancelled.';
    case 'requested':
      return 'Exchange requested. The warehouse will review it.';
    case 'declined':
      return 'Exchange declined. Your return was approved.';
    case 'completed':
      return 'Exchange completed.';
    case 'partly_handed_over':
      return 'Part of your replacement was handed over. The rest will follow.';
    case 'out_for_delivery':
      return 'Your replacement is on the way.';
    case 'ready_for_pickup':
      return 'Replacement ready for pickup.';
    case 'in_progress':
      return 'Your replacement is being prepared.';
    case 'replacement_cancelled':
      return 'Your replacement was cancelled. The warehouse will follow up.';
    case 'unavailable':
      return 'Your replacement is not in stock yet. The warehouse will follow up.';
    case 'waiting_for_return':
      return 'Replacement reserved. Waiting for your return.';
    case 'ready_to_pick':
      return 'Return received. Your replacement is being prepared.';
  }
}

// ── The list filters (plan 3.10, graft G5) ─────────────────────────────────

export const RETURN_LIST_FILTER_IDS = [
  'all',
  'returns',
  'exchanges',
  'awaiting_approval',
  'waiting_for_return',
  'received_not_processed',
  'replacement_unavailable',
  'replacement_ready',
  'closed',
] as const;

export type ReturnListFilterId = (typeof RETURN_LIST_FILTER_IDS)[number];

export interface ReturnListFilter {
  id: ReturnListFilterId;
  label: string;
  /** RMA statuses the filter keeps (null: any). */
  statuses: readonly ReturnStatus[] | null;
  /**
   * Needs the exchange columns RX-2 appends to `return_overview` (kind,
   * exchange_status). RX-1 surfaces hide these filters: every RMA is a
   * return, so they would be empty or equal to All.
   */
  requiresExchanges: boolean;
  /** Oldest approval first (the waiting list shows its age). */
  sort: 'created_desc' | 'approved_asc';
}

export const RETURN_LIST_FILTERS: readonly ReturnListFilter[] = [
  { id: 'all', label: 'All', statuses: null, requiresExchanges: false, sort: 'created_desc' },
  { id: 'returns', label: 'Returns only', statuses: null, requiresExchanges: true, sort: 'created_desc' },
  { id: 'exchanges', label: 'Exchanges', statuses: null, requiresExchanges: true, sort: 'created_desc' },
  { id: 'awaiting_approval', label: 'Awaiting approval', statuses: ['requested'], requiresExchanges: false, sort: 'created_desc' },
  { id: 'waiting_for_return', label: 'Waiting for returned item', statuses: ['approved'], requiresExchanges: false, sort: 'approved_asc' },
  { id: 'received_not_processed', label: 'Received, not processed', statuses: ['received'], requiresExchanges: false, sort: 'created_desc' },
  { id: 'replacement_unavailable', label: 'Replacement unavailable', statuses: null, requiresExchanges: true, sort: 'created_desc' },
  { id: 'replacement_ready', label: 'Replacement ready', statuses: null, requiresExchanges: true, sort: 'created_desc' },
  { id: 'closed', label: 'Closed', statuses: ['closed', 'denied', 'cancelled'], requiresExchanges: false, sort: 'created_desc' },
];

/** The filters a surface offers: RX-1 passes `exchanges: false`. */
export function availableReturnListFilters(opts: { exchanges: boolean }): readonly ReturnListFilter[] {
  return RETURN_LIST_FILTERS.filter((f) => opts.exchanges || !f.requiresExchanges);
}

/** A `?filter=` value -> a known filter id ('all' for anything else). */
export function parseReturnListFilter(raw: unknown, opts: { exchanges: boolean } = { exchanges: false }): ReturnListFilterId {
  const first = Array.isArray(raw) ? raw[0] : raw;
  if (typeof first !== 'string') return 'all';
  const found = availableReturnListFilters(opts).find((f) => f.id === first);
  return found ? found.id : 'all';
}

export function returnListFilter(id: ReturnListFilterId): ReturnListFilter {
  return RETURN_LIST_FILTERS.find((f) => f.id === id) ?? RETURN_LIST_FILTERS[0]!;
}

/** From this many days waiting the workbench prompts (no auto-expiry, D28). */
export const RETURN_WAITING_PROMPT_DAYS = 14;

/** Rows per page on the list (web, phone and API). */
export const RETURN_LIST_PAGE_SIZE = 25;
