import type { OutboxRow } from './cycle-count-cache';

/**
 * Newest-wins per line for record_count outbox rows.
 *
 * WHY: two rows for the same line can coexist when an edit lands while the
 * earlier row is 'sending' (updateLocalLine only supersedes pending/failed
 * rows). If both are later due, sending the OLDER one after the newer lands
 * reverts the operator's correction on the server. The drain sends only the
 * newest row per line and acks the rest without sending them.
 *
 * "Newest" is the highest id: pending_actions ids are monotonic
 * (autoincrement), which is a stricter order than created_at's millisecond
 * clock. Rows without a string lineId are passed through untouched.
 */
export function latestRowsPerLine(rows: readonly OutboxRow[]): {
  send: OutboxRow[];
  superseded: OutboxRow[];
} {
  const newestByLine = new Map<string, OutboxRow>();
  for (const r of rows) {
    const lineId = typeof r.payload.lineId === 'string' ? r.payload.lineId : null;
    if (!lineId) continue;
    const cur = newestByLine.get(lineId);
    if (!cur || r.id > cur.id) newestByLine.set(lineId, r);
  }
  const send: OutboxRow[] = [];
  const superseded: OutboxRow[] = [];
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
