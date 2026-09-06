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
 *   2. A DEFINITIVE refusal from our own route — 400, 403, 409, 422, or a 404
 *      that carries a JSON error code. The server evaluated this exact
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
 * would silently lose warehouse activity.
 *
 * The verdict keys off the numeric HTTP status, never the message: a handful
 * of routes put a human sentence in `error`. The ONE place `code` matters is
 * the 404: a framework 404 (route missing during a deploy, older binary)
 * arrives with no JSON body and stays retryable; a route's own
 * `{ error: 'not_found' }` is a verdict about the resource.
 *
 * Note on ordering: the disabled flag is raised asynchronously by the auth
 * probe that `notifyUnauthorized` kicks off, so the FIRST 401 of a drain can
 * still classify as 'failed'. That is deliberate and safe — the row stays
 * retryable, the next tick re-reads it, and by then the probe has resolved and
 * the row goes terminal. It converges toward rejection, never away from it.
 */
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

/** Statuses that are a verdict on THIS request, from our own route. */
const DEFINITIVE_REFUSALS: ReadonlySet<number> = new Set([400, 403, 409, 422]);

export function classifyDrainFailure(
  err: unknown,
  opts: { accountDisabled: boolean },
): DrainOutcome {
  const e = err as { status?: unknown; code?: unknown } | null | undefined;
  const status = typeof e?.status === 'number' ? e.status : null;
  if (status === null) return 'failed';
  if (status === 401) return opts.accountDisabled ? 'rejected' : 'failed';
  if (DEFINITIVE_REFUSALS.has(status)) return 'rejected';
  if (status === 404 && typeof e?.code === 'string' && e.code.length > 0) return 'rejected';
  return 'failed';
}
