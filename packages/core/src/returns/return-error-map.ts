/**
 * The returns error contract (plan 3.11, graft G13): ONE table from a
 * database refusal to the service error, the HTTP status and the words, for
 * the web services, the API routes and the phone.
 *
 * MAP BY HINT, NEVER BY MESSAGE TEXT (pattern 28). Every RMA function raises
 * with a stable `hint`. Two older paths raise a bare token as the whole
 * message with no hint: the frozen ledger body (`forbidden`,
 * `invalid_status_transition`, `insufficient_stock`, `return_exceeds_fulfilled`,
 * `return_not_found`) and the 0153 cap trigger (`return_exceeds_fulfilled`).
 * For those, and only when no hint is present, a message that IS exactly one
 * lower-case token is read as the key. A sentence never is.
 *
 * Specific before general: a hint wins over the SQLSTATE; 55P03 and 57014
 * (lock wait, statement timeout) map to a retryable "Busy" only when no hint
 * matched; anything unknown is an internal error with a generic sentence (the
 * raw text stays server-side).
 *
 * Plain literals and pure functions only: importing this module runs nothing.
 */

export type ReturnServiceErrorCode =
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'validation_error'
  | 'module_disabled'
  | 'conflict'
  | 'internal_error';

export interface ReturnErrorEntry {
  code: ReturnServiceErrorCode;
  status: number;
  message: string;
  /** The same body may be sent again safely. */
  retryable?: boolean;
}

/** The words a refusal shows. Exported for the web and phone surfaces. */
export const RETURN_ERROR_WORDS = {
  unauthenticated: 'Sign in again.',
  returnNotFound: "This return isn't available.",
  orderNotFound: "This order isn't available.",
  returnsManage: "You don't have permission to manage returns.",
  returnsRead: "You don't have permission to view returns.",
  ordersApprove: 'Approving the replacement needs order approval permission.',
  warehouseWrite: "You can't manage returns for this warehouse.",
  warehouseRead: "You can't view returns for this warehouse.",
  moduleDisabled: 'Returns are turned off for this organization.',
  invalidStatus: 'This return changed. It now shows the latest.',
  returnChanged: 'Another person changed this return. Review it again.',
  planChanged: 'The destination was changed by someone else. Review it again.',
  idempotencyConflict: 'This request was already sent with different details. Reload and try again.',
  keyRequired: 'Reload and try again.',
  replacementUnavailable: 'The replacement is not available in the quantity needed.',
  restockUnavailable: 'Original rack is no longer available.',
  restockNotOffered: "That rack isn't one this item was picked from.",
  restockStale: 'The original locations changed. Choose the destination again.',
  exchangeItemNotEligible: "That item can't be used as a replacement.",
  exchangeQuantity: "A replacement can't be more than the quantity returned.",
  reasonRequired: 'Add a reason.',
  siteNotAvailable: 'Choose a delivery site this warehouse serves.',
  replacementDrawn:
    'The replacement has been picked. Cancel the replacement first; the picked items go back to Staging.',
  replacementHandedOver: 'The replacement was already handed over.',
  replacementNotWaiting: "The replacement isn't waiting for the return.",
  replacementWaiting: 'Waiting for the returned item.',
  replacementCancelViaReturn: 'Change or cancel this replacement from its RMA.',
  replacementLinesFixed: "A replacement's items come from its RMA and can't be edited here.",
  notAllowed: 'Not allowed.',
  reload: 'Reload the page to continue.',
  exchangeNotAvailable: 'Exchanges are turned off right now. Request a return only.',
  exceedsFulfilled: 'That is more than was handed over.',
  busy: 'Busy. Try again.',
  invalid: 'Check the return and try again.',
  decisionIncomplete: 'Choose what happens to every returned line.',
  notReturnable: 'Only orders that were handed over can be returned.',
  insufficientStock: 'Scrapping this line would take stock on record below zero.',
  internal: 'Something went wrong. Try again.',
} as const;

const W = RETURN_ERROR_WORDS;

/** Hint (or bare token) -> entry. */
export const RETURN_ERROR_TABLE: Readonly<Record<string, ReturnErrorEntry>> = {
  unauthenticated: { code: 'unauthenticated', status: 401, message: W.unauthenticated },
  return_not_found: { code: 'not_found', status: 404, message: W.returnNotFound },
  order_not_found: { code: 'not_found', status: 404, message: W.orderNotFound },
  returns_manage: { code: 'forbidden', status: 403, message: W.returnsManage },
  returns_read: { code: 'forbidden', status: 403, message: W.returnsRead },
  orders_approve: { code: 'forbidden', status: 403, message: W.ordersApprove },
  warehouse_write: { code: 'forbidden', status: 403, message: W.warehouseWrite },
  warehouse_read: { code: 'forbidden', status: 403, message: W.warehouseRead },
  // The frozen ledger body's bare permission refusal.
  forbidden: { code: 'forbidden', status: 403, message: W.returnsManage },
  module_disabled: { code: 'module_disabled', status: 403, message: W.moduleDisabled },
  invalid_status_transition: { code: 'conflict', status: 409, message: W.invalidStatus },
  return_changed: { code: 'conflict', status: 409, message: W.returnChanged },
  return_plan_changed: { code: 'conflict', status: 409, message: W.planChanged },
  idempotency_conflict: { code: 'conflict', status: 409, message: W.idempotencyConflict },
  idempotency_key_required: { code: 'validation_error', status: 400, message: W.keyRequired },
  replacement_unavailable: { code: 'validation_error', status: 400, message: W.replacementUnavailable },
  restock_location_unavailable: { code: 'validation_error', status: 400, message: W.restockUnavailable },
  restock_location_not_offered: { code: 'validation_error', status: 400, message: W.restockNotOffered },
  restock_plan_stale: { code: 'validation_error', status: 400, message: W.restockStale },
  restock_plan_mismatch: { code: 'validation_error', status: 400, message: W.restockStale },
  exchange_item_not_eligible: { code: 'validation_error', status: 400, message: W.exchangeItemNotEligible },
  exchange_quantity_exceeds_return: { code: 'validation_error', status: 400, message: W.exchangeQuantity },
  reason_required: { code: 'validation_error', status: 400, message: W.reasonRequired },
  replacement_site_not_available: { code: 'validation_error', status: 400, message: W.siteNotAvailable },
  replacement_already_drawn: { code: 'conflict', status: 409, message: W.replacementDrawn },
  replacement_handed_over: { code: 'conflict', status: 409, message: W.replacementHandedOver },
  replacement_not_waiting: { code: 'conflict', status: 409, message: W.replacementNotWaiting },
  replacement_waiting_for_return: { code: 'conflict', status: 409, message: W.replacementWaiting },
  replacement_cancel_via_return: { code: 'forbidden', status: 403, message: W.replacementCancelViaReturn },
  replacement_lines_fixed: { code: 'forbidden', status: 403, message: W.replacementLinesFixed },
  replacement_link_server_only: { code: 'forbidden', status: 403, message: W.notAllowed },
  replacement_link_immutable: { code: 'forbidden', status: 403, message: W.notAllowed },
  return_exchange_through_rpc: { code: 'forbidden', status: 403, message: W.reload },
  return_close_through_rpc: { code: 'forbidden', status: 403, message: W.reload },
  return_insert_through_rpc: { code: 'forbidden', status: 403, message: W.reload },
  return_stamp_forged: { code: 'forbidden', status: 403, message: W.reload },
  return_line_insert_through_rpc: { code: 'forbidden', status: 403, message: W.reload },
  return_decisions_append_only: { code: 'forbidden', status: 403, message: W.notAllowed },
  exchange_not_available: { code: 'validation_error', status: 400, message: W.exchangeNotAvailable },
  return_exceeds_fulfilled: { code: 'validation_error', status: 400, message: W.exceedsFulfilled },
  return_number_unavailable: { code: 'conflict', status: 409, message: W.busy, retryable: true },
  return_invalid: { code: 'validation_error', status: 400, message: W.invalid },
  return_decision_incomplete: { code: 'validation_error', status: 400, message: W.decisionIncomplete },
  order_not_returnable: { code: 'validation_error', status: 400, message: W.notReturnable },
  insufficient_stock: { code: 'validation_error', status: 400, message: W.insufficientStock },
};

const BUSY: ReturnErrorEntry = { code: 'conflict', status: 409, message: W.busy, retryable: true };
const INTERNAL: ReturnErrorEntry = { code: 'internal_error', status: 500, message: W.internal };

/** A PostgREST / Postgres error as supabase-js hands it back. */
export interface ReturnDbError {
  code?: string | null;
  hint?: string | null;
  message?: string | null;
  details?: string | null;
}

export interface MappedReturnError extends ReturnErrorEntry {
  /** The key that matched (hint or bare token), `busy`, or `internal_error`. */
  reason: string;
  /** The parsed `detail` when it is JSON (e.g. {rule, locationId}). */
  detail: Record<string, unknown> | null;
}

const TOKEN = /^[a-z][a-z0-9_]*$/;

/** The key a refusal is mapped by: its hint, else a bare-token message. */
export function returnErrorKey(err: ReturnDbError | null | undefined): string | null {
  if (!err) return null;
  const hint = (err.hint ?? '').trim();
  if (hint && Object.prototype.hasOwnProperty.call(RETURN_ERROR_TABLE, hint)) return hint;
  if (!hint) {
    const msg = (err.message ?? '').trim();
    if (TOKEN.test(msg) && Object.prototype.hasOwnProperty.call(RETURN_ERROR_TABLE, msg)) return msg;
  }
  return null;
}

function parseDetail(details: string | null | undefined): Record<string, unknown> | null {
  if (!details) return null;
  const text = details.trim();
  if (!text.startsWith('{')) return null;
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** One refusal -> its entry, the key that matched and any structured detail. */
export function mapReturnError(err: ReturnDbError | null | undefined): MappedReturnError {
  const key = returnErrorKey(err);
  const detail = parseDetail(err?.details);
  if (key) return { ...RETURN_ERROR_TABLE[key]!, reason: key, detail };
  const code = (err?.code ?? '').toUpperCase();
  if (code === '55P03' || code === '57014') return { ...BUSY, reason: 'busy', detail };
  return { ...INTERNAL, reason: 'internal_error', detail };
}

/** The rule names restock_location_unavailable carries, as words for the
 *  "no longer available" line (plan section 6). */
export const RESTOCK_PROBLEM_WORDS: Readonly<Record<string, string>> = {
  archived: '(archived)',
  moved_warehouse: '(moved to another warehouse)',
  warehouse_inactive: '(its warehouse is closed)',
  not_a_placement: '(no longer a rack)',
  item_deleted: '(the item was deleted)',
  missing: '(no longer exists)',
  remaining: '(already holds every unit returned from this order)',
};

export function restockProblemWords(rule: string | null | undefined): string | null {
  if (!rule) return null;
  return RESTOCK_PROBLEM_WORDS[rule] ?? null;
}
