/**
 * Terminal-vs-retryable classification for the offline outbox.
 *
 * BOTH drains use this — `sync.ts::drainQueue` (everything except
 * `record_count`) and `CycleCountSyncEngine` (the `record_count` rows). They
 * are separate engines with separate tables of behaviour, but they must agree
 * on this one verdict, or one class of failure stops half the queue and leaves
 * the other half retrying.
 *
 * TWO kinds of failure are terminal ('rejected' — parked in Settings > Unsent
 * work with the server's message, never re-sent):
 *
 *   1. A 401 raised while the client already knows the account is disabled
 *      (the original rule): that write must never land when the account is
 *      re-enabled.
 *   2. A DEFINITIVE refusal from our own route — 400, 409, 422, a 404 that
 *      carries a JSON error code, or a 403 after the authenticator check
 *      below. The server evaluated this exact
 *      request and said no: the count was posted or reassigned, the bundle
 *      is archived, the quantity is invalid, the permission is gone. Before
 *      this rule those rows stayed 'failed' and were re-sent every 60 s
 *      forever; on a device with one such row the "Sync first" gate blocked
 *      posting EVERY count, and a shortage refusal would have distributed
 *      later, silently, once stock was topped up (SP-006 / SP-037).
 *
 * Everything else stays retryable — 401 on a live account (token blip), 408,
 * 429, every 5xx, a timeout, a network error, a null throw — because the
 * outbox holds real operator work and discarding it on a transient failure
 * would silently lose warehouse activity. That includes the 503 the server
 * marks as refused before any write (docket S26): nothing was written, so it
 * is retryable here like any 5xx. The `adjust_stock` kind, which is sent at
 * most once, reads that mark itself (adjust-outbox.ts adjustDrainVerdict).
 *
 * The verdict keys off the numeric HTTP status, never the message: a handful
 * of routes put a human sentence in `error`. The ONE place `code` matters is
 * the 404: a framework 404 (route missing during a deploy, older binary)
 * arrives with no JSON body and stays retryable; a route's own
 * `{ error: 'not_found' }` is a verdict about the resource.
 *
 * A 403 IS FINAL ONLY AFTER A CHECK OF THE AUTHENTICATOR POLICY. While a
 * workspace's policy requires an authenticator the account has not set up,
 * the server refuses every queued change there with a 403 (its answer has
 * `details.reason` 'mfa_required' on the routes that forward details; some
 * send the same sentence without them). That refusal says nothing about the
 * change itself: the same row lands once the account has an authenticator.
 * So a 403 is 'rejected' only when its reason is neither 'mfa_required' nor
 * 'aal2_required' AND the phone, from reads made after that refusal, finds
 * this account owes no set-up in the row's workspace (`setUp` 'clear':
 * set-up-inputs.ts setUpAnswerAfterRefusal). Anything else keeps the row
 * ('failed'): the drain notes the refusal and the inputs are read again
 * (keptForSetUpCheck, set-up-inputs.ts noteKeptRefusal), and while the row's
 * workspace owes set-up the send decision holds it (outbox-scope.ts). The
 * authenticator answer itself is never final, even when the phone's read says
 * nothing is owed: the server holds a member whose policy it could not read
 * to the strictest one.
 *
 * Note on ordering: the disabled flag is raised asynchronously by the auth
 * probe that `notifyUnauthorized` kicks off, so the FIRST 401 of a drain can
 * still classify as 'failed'. That is deliberate and safe — the row stays
 * retryable, the next tick re-reads it, and by then the probe has resolved and
 * the row goes terminal. It converges toward rejection, never away from it.
 */
import type { SetUpAnswer } from './set-up-inputs';

export type DrainOutcome = 'rejected' | 'failed';

/**
 * `last_error` for rows rejected in BULK at eviction, where there is no
 * per-row server error to quote — the account was confirmed disabled out of
 * band and nothing was ever put on the wire.
 *
 * Written to a diagnostic column, not rendered as the disabled copy: the screen
 * uses ACCOUNT_DISABLED_MESSAGE from @stockpilot/core. This sentence exists so
 * that a row seen later is self-explanatory rather than an unexplained corpse.
 */
export const ACCOUNT_DISABLED_REJECTION =
  'Account disabled: this queued change was never sent.';

/**
 * Statuses that are a verdict on THIS request, from our own route. A 403 is
 * decided before this set is read: only after the authenticator check below.
 */
const DEFINITIVE_REFUSALS: ReadonlySet<number> = new Set([400, 403, 409, 422]);

/** The reasons a 403 carries when it is the authenticator answer, not one about the change. */
const AUTHENTICATOR_REASONS: ReadonlySet<string> = new Set(['mfa_required', 'aal2_required']);

/** The route's app-authored `details.reason`, or null. */
function detailsReason(details: unknown): string | null {
  if (!details || typeof details !== 'object') return null;
  const reason = (details as { reason?: unknown }).reason;
  return typeof reason === 'string' ? reason : null;
}

export function classifyDrainFailure(
  err: unknown,
  opts: {
    accountDisabled: boolean;
    /** The row workspace's answer from reads made after its last kept refusal. */
    setUp: SetUpAnswer;
  },
): DrainOutcome {
  const e = err as { status?: unknown; code?: unknown; details?: unknown } | null | undefined;
  const status = typeof e?.status === 'number' ? e.status : null;
  if (status === null) return 'failed';
  if (status === 401) return opts.accountDisabled ? 'rejected' : 'failed';
  if (status === 403) {
    const reason = detailsReason(e?.details);
    if (reason !== null && AUTHENTICATOR_REASONS.has(reason)) return 'failed';
    return opts.setUp === 'clear' ? 'rejected' : 'failed';
  }
  if (DEFINITIVE_REFUSALS.has(status)) return 'rejected';
  if (status === 404 && typeof e?.code === 'string' && e.code.length > 0) return 'rejected';
  return 'failed';
}

/**
 * Whether a failure classifyDrainFailure did NOT reject was a 403 kept for a
 * check of the authenticator policy (every other 403 is rejected). The drain
 * then notes it and asks for the inputs to be read again
 * (set-up-inputs.ts noteKeptRefusal).
 */
export function keptForSetUpCheck(err: unknown): boolean {
  return (err as { status?: unknown } | null | undefined)?.status === 403;
}
