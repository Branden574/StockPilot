import type { OutboxRow } from './cycle-count-cache';

/**
 * Newest-wins per line for record_count outbox rows.
 *
 * WHY: two rows for the same line can coexist when an edit lands while the
 * earlier row is 'sending' (updateLocalLine only supersedes pending/failed
 * rows). Sending the OLDER one after the newer lands reverts the operator's
 * correction on the server. The drain sends only the newest row per line and
 * acks the rest without sending them. It must pass EVERY queued row for a
 * line, including one still in retry backoff (cycle-count-cache.ts
 * outboxQueued): judged only among due rows, a failed older row was invisible
 * until the correction had been acked and was then sent on its own.
 *
 * "Newest" is the highest id: pending_actions ids are monotonic
 * (autoincrement), which is a stricter order than created_at's millisecond
 * clock. Rows without a string lineId are passed through untouched.
 */
export function latestRowsPerLine<R extends OutboxRow>(rows: readonly R[]): {
  send: R[];
  superseded: R[];
} {
  const newestByLine = new Map<string, R>();
  for (const r of rows) {
    const lineId = typeof r.payload.lineId === 'string' ? r.payload.lineId : null;
    if (!lineId) continue;
    const cur = newestByLine.get(lineId);
    if (!cur || r.id > cur.id) newestByLine.set(lineId, r);
  }
  const send: R[] = [];
  const superseded: R[] = [];
  for (const r of rows) {
    const lineId = typeof r.payload.lineId === 'string' ? r.payload.lineId : null;
    if (!lineId) {
      send.push(r);
      continue;
    }
    (newestByLine.get(lineId) === r ? send : superseded).push(r);
  }
  return { send, superseded };
}
