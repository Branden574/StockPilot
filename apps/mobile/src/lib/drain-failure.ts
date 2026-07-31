/**
 * Terminal-vs-retryable classification for the offline outbox.
 *
 * BOTH drains use this — `sync.ts::drainQueue` (everything except
 * `record_count`) and `CycleCountSyncEngine` (the `record_count` rows). They
 * are separate engines with separate tables of behaviour, but they must agree
 * on this one verdict, or an account disable stops half the queue and leaves
 * the other half retrying.
 *
 * Only ONE combination is terminal: a 401 raised while the client already knows
 * the account is disabled. Everything else stays retryable, because the outbox
 * holds real operator work (received PO lines, stock adjustments, counts) and
 * discarding it on a transient failure would silently lose warehouse activity.
 *
 * The verdict keys off the numeric HTTP status ONLY, never `ApiError.code` or
 * the message: a handful of routes put a human sentence in `error`, so those
 * fields cannot carry a permanent decision (see the note on ApiError in api.ts).
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

export function classifyDrainFailure(
  err: unknown,
  opts: { accountDisabled: boolean },
): DrainOutcome {
  if (!opts.accountDisabled) return 'failed';
  const status = (err as { status?: unknown } | null | undefined)?.status;
  return status === 401 ? 'rejected' : 'failed';
}
