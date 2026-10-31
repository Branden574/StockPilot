// What Manage order items does with the answer of a Show or Hide (ordering
// visibility, design 8.2 States and 3.7). Pure.
//
// Decided by `details.reason` (core ORDER_CATALOG_REFUSALS, plus the
// action's 'rate_limited'), never by message text, and said in core's words.
// The only server sentence shown as it came is the rate limit's (the web
// service's own words). A reason this page does not know is never shown as
// success: it is "couldn't be confirmed", and the list is re-read.

import {
  isFinalOrderCatalogRefusal,
  ORDER_ITEMS_INTERNAL_COPY,
  orderItemsRefusalCopy,
  orderItemsSavedCopy,
  type ActionResult,
  type OrderCatalogRefusal,
  type OrderCatalogVisibilityWriteAnswer,
} from '@stockpilot/core';

export type WriteOutcome =
  /** Committed: what changed and what already was in that state. */
  | { kind: 'saved'; message: string; visible: boolean; changed: string[]; unchanged: string[] }
  /** The session must step up: prompt, then send the SAME operation again. */
  | { kind: 'step_up' }
  /** Final (forbidden, feature off, module off): lock the page, no retries. */
  | { kind: 'locked'; message: string }
  /** Nothing changed; these ids (the caller's own) are deselected. */
  | { kind: 'unavailable'; message: string; itemIds: string[] }
  /** Nothing changed (busy, rate limited): Try again sends the same operation. */
  | { kind: 'retry'; message: string }
  /** The outcome is not known (no answer, an internal error): re-read the
   *  list; a resend of the same operation is safe (it is idempotent). */
  | { kind: 'unconfirmed'; message: string }
  /** Refused for a reason a retry does not fix (MFA enrolment, a malformed
   *  request): the operation ends. */
  | { kind: 'failed'; message: string };

/** `result` is null when the call itself failed (no answer). */
export function writeOutcome(
  result: ActionResult<OrderCatalogVisibilityWriteAnswer> | null,
): WriteOutcome {
  const unconfirmed: WriteOutcome = { kind: 'unconfirmed', message: ORDER_ITEMS_INTERNAL_COPY };
  if (!result) return unconfirmed;
  if (result.ok) {
    const { visible, changed, unchanged } = result.data;
    return {
      kind: 'saved',
      message: orderItemsSavedCopy({
        visible,
        changed: changed.length,
        unchanged: unchanged.length,
      }),
      visible,
      changed,
      unchanged,
    };
  }
  const details = result.error.details ?? {};
  const reason = typeof details.reason === 'string' ? details.reason : null;
  if (reason === null) return unconfirmed;
  // forbidden, feature_disabled, module_disabled (core decides which are final).
  if (isFinalOrderCatalogRefusal(reason as OrderCatalogRefusal)) {
    return { kind: 'locked', message: orderItemsRefusalCopy(reason as OrderCatalogRefusal) };
  }
  switch (reason) {
    case 'aal2_required':
      return { kind: 'step_up' };
    case 'items_unavailable': {
      const ids = Array.isArray(details.itemIds)
        ? details.itemIds.filter((x): x is string => typeof x === 'string')
        : [];
      return {
        kind: 'unavailable',
        message: orderItemsRefusalCopy('items_unavailable'),
        itemIds: ids,
      };
    }
    case 'busy':
      return { kind: 'retry', message: orderItemsRefusalCopy('busy') };
    case 'rate_limited':
      return { kind: 'retry', message: result.error.message };
    case 'mfa_required':
      return { kind: 'failed', message: orderItemsRefusalCopy('mfa_required') };
    case 'invalid':
      return { kind: 'failed', message: orderItemsRefusalCopy('invalid') };
    default:
      return unconfirmed;
  }
}
