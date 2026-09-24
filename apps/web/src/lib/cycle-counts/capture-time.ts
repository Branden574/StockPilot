/**
 * When did the counter physically count? (Phase 0 S5-C, migration 0369.)
 *
 * The phone queues a count while offline and sends it later, so the moment it
 * reaches the server is not the moment the shelf was counted. It sends two
 * device-clock readings with every send:
 *
 *   capturedAt   - when the count was typed (stamped at enqueue),
 *   clientSentAt - when this request left the phone.
 *
 * A device clock can be minutes or hours off, so neither reading is trusted
 * as an absolute time. Only the ELAPSED time between them is: the count was
 * taken `clientSentAt - capturedAt` before the request left, so on the
 * server's clock it was taken at `serverNow - (clientSentAt - capturedAt)`.
 * (Transit time is ignored: it makes the capture look slightly earlier, and
 * the database clamps the result to the count's own window anyway.)
 *
 * LENIENT BY DESIGN. Anything that cannot be read - a missing value, a
 * non-string, an unparseable date, either reading absent - is DROPPED and the
 * record is an online record (measured at arrival, today's behaviour). The
 * route never answers 400 for it: the phone's drain treats a 400 as a final
 * refusal and would discard the operator's count over a bad timestamp.
 */
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
  const iso = new Date(at);
  return Number.isFinite(iso.getTime()) ? iso.toISOString() : undefined;
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

/**
 * How long before its write a line must have been captured to read as an
 * offline count. A phone that is online sends within seconds of the count.
 */
export const OFFLINE_CAPTURE_MIN_GAP_MS = 2 * 60 * 1000;

/**
 * The review label for a line counted offline and synced later (0369, D7: an
 * old capture is accepted, and whoever posts sees when it was taken), e.g.
 * "Counted offline Sep 24, 3:14 PM". Null for an online record, a line with
 * no capture time, or an unreadable one. `timeZone` is the organization's, so
 * the server render and the browser agree.
 */
export function offlineCaptureLabel(
  line: { captured_at?: string | null; counted_at: string | null },
  timeZone?: string,
): string | null {
  if (!line.captured_at) return null;
  const captured = Date.parse(line.captured_at);
  if (!Number.isFinite(captured)) return null;
  const counted = line.counted_at ? Date.parse(line.counted_at) : Number.NaN;
  if (Number.isFinite(counted) && counted - captured < OFFLINE_CAPTURE_MIN_GAP_MS) return null;
  const opts: Intl.DateTimeFormatOptions = {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  };
  let when: string;
  try {
    when = new Intl.DateTimeFormat('en-US', { ...opts, timeZone }).format(new Date(captured));
  } catch {
    // An unknown zone name: the viewer's own zone beats no label.
    when = new Intl.DateTimeFormat('en-US', opts).format(new Date(captured));
  }
  return `Counted offline ${when}`;
}
