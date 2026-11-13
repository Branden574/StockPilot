/**
 * REFUSED BEFORE ANY WRITE: the one answer the phone may read as "nothing was
 * written" (docket S26).
 *
 * WHY THE PHONE NEEDS IT. The stock adjustment and rental checkout routes take
 * no idempotency key, so the phone cannot send either one again when it does
 * not know whether the first try landed: a gateway 502 or 504, or the route's
 * own 500, can arrive after the commit. It reads every 5xx on those routes as
 * "may or may not have been saved" (item-adjust.ts, adjust-outbox.ts,
 * rental-view.ts in apps/mobile).
 *
 * But one 5xx is known to come before any write. When get_request_context()
 * gives no usable answer, withApiContext falls back to separate reads, and
 * when one of those cannot read the caller's account status, or a non-owner's
 * permission overrides, it refuses the request by throwing
 * (AccountStatusUnavailableError, PermissionsUnavailableError in apps/web).
 * That happens before the route does anything, and withApiContext itself
 * writes nothing. The web's API context gate
 * (apps/web/src/server/lib/api-context-gate.ts) answers exactly that refusal
 * with the body below, and nothing else sends it.
 *
 * THE SHAPE. 503 with `error: 'check_failed'`, the code the API already
 * answers when a check cannot answer (account delete; unreadable warehouse
 * access, S16), plus `details`:
 *   - reason: which check, from REFUSED_BEFORE_WRITE_REASONS;
 *   - retryable: true;
 *   - nothingWritten: true, which only this answer carries.
 * A check_failed answer without those details keeps its own meaning (a check
 * could not answer, try again) and says nothing about writes.
 *
 * ONE PREDICATE. The phone reads the marker only through
 * isRefusedBeforeAnyWrite, which requires every part of it and never reads the
 * message. Guards keep a second emitter out of the web (api-context-gate.test.ts)
 * and any copy of the literals out of the phone
 * (refused-before-write.wire.test.ts in apps/mobile).
 */

/** The `details.reason` of the API context gate's refusal. */
export const CONTEXT_UNAVAILABLE_REASON = 'context_unavailable';

/**
 * The reasons a marker may carry. Each one needs its own reviewed emitter
 * that provably answers before any write, and a phone update for the phone
 * to trust it: a phone trusts only the reasons on the list it was built with.
 */
export const REFUSED_BEFORE_WRITE_REASONS: readonly string[] = [CONTEXT_UNAVAILABLE_REASON];

/** What the person is told. It claims no scope: the check did not answer. */
export const CONTEXT_UNAVAILABLE_COPY =
  'Your access could not be checked just now, so nothing was changed. Try again in a moment.';

/** The body of the API context gate's 503. A new object every call. */
export function contextUnavailableBody() {
  return {
    error: 'check_failed',
    message: CONTEXT_UNAVAILABLE_COPY,
    details: { reason: CONTEXT_UNAVAILABLE_REASON, retryable: true, nothingWritten: true },
  } as const;
}

/**
 * True only for the marker: status 503, code 'check_failed', `details.retryable`
 * and `details.nothingWritten` exactly true, and a reason on
 * REFUSED_BEFORE_WRITE_REASONS. Reads `status`, `code` and `details`, the
 * fields the phone's ApiError carries (apps/mobile/src/lib/api.ts); never the
 * message, which is for people.
 */
export function isRefusedBeforeAnyWrite(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  const e = err as { status?: unknown; code?: unknown; details?: unknown };
  if (e.status !== 503 || e.code !== 'check_failed') return false;
  const details = e.details;
  if (details === null || typeof details !== 'object') return false;
  const d = details as { reason?: unknown; retryable?: unknown; nothingWritten?: unknown };
  return (
    d.retryable === true &&
    d.nothingWritten === true &&
    typeof d.reason === 'string' &&
    REFUSED_BEFORE_WRITE_REASONS.includes(d.reason)
  );
}
