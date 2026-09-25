/**
 * When did the counter physically count? (Phase 0 S5-C, migration 0369.)
 *
 * The phone queues a count while offline and sends it later, so the moment it
 * reaches the server is not the moment the shelf was counted. It sends two
 * device-clock readings with every send:
 *
 *   capturedAt   - when the count was typed (stamped at enqueue),
 *   clientSentAt - when this request left the phone (stamped as late as the
 *                  phone can: after its credentials are resolved).
 *
 * A device clock can be minutes or hours off, so neither reading is trusted
 * as an absolute time. Only the ELAPSED time between them is: the count was
 * taken `clientSentAt - capturedAt` before the request left, so on the
 * server's clock it was taken at `serverNow - (clientSentAt - capturedAt)`.
 *
 * THE RESULT IS LATE, NEVER EARLY. `serverNow` is later than the true send by
 * the request's transit time plus whatever the server did before reading its
 * clock, so the resolved capture lands that much AFTER the real count. A pick
 * inside that window reads as before the count (a small phantom variance), so
 * the route reads its clock as the FIRST thing it does, and the phone stamps
 * clientSentAt as late as it can. The database clamps the result to the
 * count's own window [started_at, now()].
 *
 * LENIENT BY DESIGN. Anything that cannot be read - a missing value, a
 * non-string, an unparseable date, either reading absent, or a pair whose gap
 * puts the capture before any real count (a corrupt or hostile pair: the
 * database cannot even store a date that far back and would refuse the record
 * on every retry) - is DROPPED and the record is an online record (measured at
 * arrival, today's behaviour). The route never answers 400 for it: the phone's
 * drain treats a 400 as a final refusal and would discard the operator's count
 * over a bad timestamp.
 *
 * The review label ("Counted offline <time>") lives in @stockpilot/core
 * (offlineCaptureLabel), shared with the phone.
 */

/** No real count was captured before this; a resolved capture earlier than it
 *  comes from an unreadable pair (the phone's own floor for an outbox
 *  created_at, cycle-count-record-body.ts, is the same date). */
const EARLIEST_PLAUSIBLE_CAPTURE_MS = Date.UTC(2020, 0, 1);

export function resolveCapturedAt(input: {
  capturedAt: unknown;
  clientSentAt: unknown;
  /** The server clock (ms since epoch) when the request arrived. */
  serverNow: number;
}): string | undefined {
  const captured = parseInstant(input.capturedAt);
  const sent = parseInstant(input.clientSentAt);
  if (captured === null || sent === null) return undefined;
  if (!Number.isFinite(input.serverNow)) return undefined;
  // A capture "after" the send means the device clock moved in between (an
  // NTP correction): the count cannot be later than the send, so it is now.
  const elapsed = Math.max(0, sent - captured);
  const at = input.serverNow - elapsed;
  if (!Number.isFinite(at) || at < EARLIEST_PLAUSIBLE_CAPTURE_MS) return undefined;
  return new Date(at).toISOString();
}

/** A date string to ms since epoch, or null when it is not one. */
function parseInstant(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  // Bounded: a timestamp is short; anything longer is not one.
  if (trimmed === '' || trimmed.length > 64) return null;
  const ms = Date.parse(trimmed);
  return Number.isFinite(ms) ? ms : null;
}
