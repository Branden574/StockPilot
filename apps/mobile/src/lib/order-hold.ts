/**
 * HOLDING STOCK FOR AN ORDER, ON THE PHONE (F2-2, migration 0378).
 *
 * Lines added to an approved order, or raised on one, were never held (L4L
 * SO-60 and SO-77, Demo Co SO-4). The server now tops the order's holds up
 * after an approver adds or raises a line, and "Hold available stock" does the
 * same by hand. This module is what the phone decides about it:
 *
 *   - `parseHoldOutcome`: the `hold` the lines route sends back after an add
 *     or a raise, read defensively (an older server sends none);
 *   - `holdTopUpNotice`: the sentence the add-items and line-edit
 *     confirmations end with, core's words (describeHoldTopUp). A failed hold
 *     always says so and points to "Hold available stock"; never swallowed;
 *   - `describeHoldError`: what a refused or failed "Hold available stock"
 *     says.
 *
 * Whether the readiness card offers the button is core's shouldOfferHoldStock,
 * the web strip's own rule. Every sentence is core's (order-hold.ts), so the
 * phone and the web page word a hold identically. Pure: no React Native
 * import, no API client.
 */

import {
  HOLD_FAILED_COPY,
  HOLD_MODULE_OFF_COPY,
  HOLD_NOT_APPLICABLE_COPY,
  HOLD_NOT_APPROVER_COPY,
  HOLD_ORDER_NOT_FOUND_COPY,
  HoldResultShapeError,
  describeHoldTopUp,
  parseHoldOrderStockResult,
  type HoldFailureReason,
  type HoldOutcome,
} from '@stockpilot/core';

import { CONNECTION_FAILURE_COPY, REQUEST_TIMED_OUT_COPY } from './connection-copy';

const FAILURE_REASONS: ReadonlySet<string> = new Set<HoldFailureReason>([
  'forbidden',
  'not_applicable',
  'busy',
  'not_found',
  'module_disabled',
  'failed',
]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const UNREADABLE: HoldOutcome = { ok: false, reason: 'failed', message: HOLD_FAILED_COPY };

/**
 * The `hold` beside a line add or a raise (POST / PATCH
 * /api/v1/orders/[id]/lines), as a HoldOutcome:
 *   - absent or null: no hold was tried (the order is not at a hold status,
 *     the editor may not approve orders, a lowering), or a server from before
 *     F2-2 answered. Nothing to say;
 *   - `{ ok: true, held, stillShort, hiddenHeldItems, hiddenShortItems }`:
 *     read with core's parser (numbers only for items the editor can read;
 *     others counted);
 *   - `{ ok: false, reason, message }`: the server's reason when it is one of
 *     core's, else 'failed'; its message when it has one, else core's.
 * An answer that cannot be read is a failure (the line itself was saved):
 * the confirmation then points to "Hold available stock", which is safe to
 * press again (a hold that already happened adds nothing). Never a guessed
 * number.
 */
export function parseHoldOutcome(raw: unknown): HoldOutcome | null {
  if (raw === undefined || raw === null) return null;
  if (!isRecord(raw)) {
    console.warn('[order-hold] the hold answer could not be read', typeof raw);
    return UNREADABLE;
  }
  if (raw.ok === true) {
    try {
      return { ok: true, ...parseHoldOrderStockResult(raw) };
    } catch (e) {
      console.warn(
        '[order-hold] the hold answer could not be read',
        e instanceof Error ? e.message : String(e),
      );
      return UNREADABLE;
    }
  }
  if (raw.ok === false) {
    const reason =
      typeof raw.reason === 'string' && FAILURE_REASONS.has(raw.reason)
        ? (raw.reason as HoldFailureReason)
        : 'failed';
    const message =
      typeof raw.message === 'string' && raw.message.trim() !== '' ? raw.message : HOLD_FAILED_COPY;
    return { ok: false, reason, message };
  }
  console.warn('[order-hold] the hold answer could not be read', 'no ok flag');
  return UNREADABLE;
}

/**
 * The sentence after a line is added or raised, or null when there is
 * nothing to say. Core's describeHoldTopUp ("Held 8 units for this order.",
 * "Added. Stock was not held for it; use Hold available stock."), and for a
 * failure the reason the server gave ("Holding stock for this order needs
 * write access to its warehouse."), so the person knows whether pressing the
 * button will help.
 */
export function holdTopUpNotice(
  outcome: HoldOutcome | null | undefined,
  change: 'added' | 'raised',
): string | null {
  const sentence = describeHoldTopUp(outcome ?? null, change);
  if (!sentence) return null;
  if (outcome && !outcome.ok && outcome.message && outcome.message !== HOLD_FAILED_COPY) {
    return `${sentence} ${outcome.message}`;
  }
  return sentence;
}

/** A confirmation's message with the hold sentence (when there is one) as its
 *  own paragraph. */
export function withHoldNotice(message: string, notice: string | null): string {
  return notice ? `${message}\n\n${notice}` : message;
}

/** The title of the alert a refused or failed hold shows. */
export const HOLD_REFUSED_TITLE = 'Stock was not held';

/**
 * What a refused or failed "Hold available stock" says. The route answers
 * every refusal with core's sentence (not an approver, no write access to the
 * warehouse, not approved or being picked, busy, order not found, orders
 * off), which is used as it is. A bare code is worded here (a 500 carries only
 * `internal_error`); no answer at all is the phone's one connection sentence;
 * an answer that could not be read is core's "couldn't be held" (pressing
 * again is safe). Raw text is never shown.
 */
export function describeHoldError(e: unknown): string {
  if (e instanceof HoldResultShapeError) return HOLD_FAILED_COPY;
  const status = isRecord(e) && typeof e.status === 'number' ? e.status : null;
  const message = e instanceof Error && e.message ? e.message : null;
  if (status === null) {
    if (message === REQUEST_TIMED_OUT_COPY) return REQUEST_TIMED_OUT_COPY;
    return CONNECTION_FAILURE_COPY;
  }
  if (status === 429) return 'Too many requests. Wait a moment and try again.';
  // 400: the route did not take the request (only its own body check can
  // refuse it, e.g. a server from before F2-2 that does not know hold_stock);
  // its validation text is not for a person.
  if (status === 400 || status >= 500) return HOLD_FAILED_COPY;
  // A lone snake_case token is a code, not a sentence.
  if (message && !/^[a-z0-9_]+$/.test(message)) return message;
  const code = isRecord(e) && typeof e.code === 'string' ? e.code : message;
  switch (code) {
    case 'forbidden':
      return HOLD_NOT_APPROVER_COPY;
    case 'module_disabled':
      return HOLD_MODULE_OFF_COPY;
    case 'not_found':
      return HOLD_ORDER_NOT_FOUND_COPY;
    case 'conflict':
      return HOLD_NOT_APPLICABLE_COPY;
    case 'unauthenticated':
      return 'Your session has expired. Sign in again to hold stock.';
    default:
      return HOLD_FAILED_COPY;
  }
}
