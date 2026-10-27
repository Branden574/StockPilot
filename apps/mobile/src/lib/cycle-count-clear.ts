/**
 * A queued clear of a cycle-count line's saved count (B4a): what the count
 * screen queues when a box that held a count is emptied, so the line is
 * uncounted again and a post skips it, as the web count screen does.
 *
 * It travels in the count outbox as a `record_count` row, so everything that
 * keeps one line's edits in order holds for it too: an edit supersedes the
 * earlier queued edits of its line (cycle-count-cache.ts), the drain sends
 * only the newest row per line (outbox-order.ts), Post waits for it ("Sync
 * first"), and it settles the line's unsynced flag as a count does.
 *
 * The row names NO countedQuantity, on purpose. A build from before clears
 * (an update rolled back while a clear waits on a phone) reads the missing
 * count as Number(undefined), which is not a number, so its sender refuses
 * the row and keeps it waiting (as it has since the first offline count
 * engine); it can never send it as a count of 0, which a post would apply as
 * the loss of everything expected.
 */
export interface ClearCountPayload {
  cycleCountId: string;
  lineId: string;
  clear: true;
}

export function clearCountPayload(cycleCountId: string, lineId: string): ClearCountPayload {
  return { cycleCountId, lineId, clear: true };
}

/** Whether a queued count row is a clear. A count's row never is. */
export function isClearCountPayload(payload: Record<string, unknown>): boolean {
  return payload.clear === true;
}

/** Where a clear is sent: the web's clear route for one line. */
export function clearCountPath(cycleCountId: string, lineId: string): string {
  return `/api/v1/cycle-counts/${cycleCountId}/lines/${lineId}/clear`;
}
