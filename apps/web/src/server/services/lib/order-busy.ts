import 'server-only';

import { RETURN_ERROR_WORDS } from '@stockpilot/core';

import { ServiceError } from '../context';

/**
 * "Someone else is changing it right now; nothing was written; send it again"
 * for the order service's database calls (returns RX-2 review S4, built in
 * RX-3; plan 3.11):
 *
 *   55P03  a lock the database stopped waiting for (lock_timeout, 5 s);
 *   57014  a statement that ran out of time (the role's statement_timeout);
 *   40P01  a deadlock the database resolved by rolling THIS call back.
 *
 * The order functions never RAISE 40001 or 40P01 (0367: PostgREST retries
 * 40001 forever and does not retry 40P01). A 40P01 here is the server's own
 * resolution of two writers locking the same items in different orders: an
 * RMA create with an exchange (key-share on the requested items) beside an
 * order function that locks the same items for update in id order
 * (approve_partial, hold_order_stock, resume_fulfillment, complete_picking;
 * RX-2 review S3 and S4), or an ordinary multi-line insert.
 *
 * ONLY for a write that is one statement or one function call with nothing
 * written before it in the same request: then the whole write rolled back
 * (an idempotency key's row with it), so the same request is safe to send
 * again, which is what "Busy. Try again." tells the person. A request that
 * already COMMITTED an earlier write must not use it: a resend would repeat
 * what was saved. (Add items was such a request until 0413 made it one call,
 * add_order_request_lines, so its busy answer is now always true.)
 */
export function isOrderBusyError(error: { code?: string | null } | null | undefined): boolean {
  const code = (error?.code ?? '').toUpperCase();
  return code === '55P03' || code === '57014' || code === '40P01';
}

/** Plan 3.11's words for a busy refusal (the returns error map's, one source). */
export const ORDER_BUSY_TRY_AGAIN_COPY = RETURN_ERROR_WORDS.busy;

/**
 * The busy refusal for a mapper with no busy words of its own: 409 conflict,
 * "Busy. Try again.", `details: { reason: 'busy', retryable: true }`. Null for
 * any other error, so the caller's own mapping goes on (specific before
 * general: hints and messages first, then this, then internal_error).
 */
export function orderBusyRefusal(error: { code?: string | null } | null | undefined): ServiceError | null {
  return isOrderBusyError(error)
    ? new ServiceError('conflict', ORDER_BUSY_TRY_AGAIN_COPY, { reason: 'busy', retryable: true })
    : null;
}
