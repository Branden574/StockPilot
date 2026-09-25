/**
 * The body a queued cycle-count record is sent with (Phase 0 S5-C, server
 * migration 0369).
 *
 * A count typed while offline can reach the server hours later, after picks
 * and receipts of the same item. The server measures the count against the
 * book AT THE MOMENT IT WAS TAKEN, so the phone says when that was:
 *
 *   capturedAt   - when the count was typed. Stamped into the payload at
 *                  enqueue (cycle-count-cache.ts updateLocalLine). A row queued
 *                  by a build from before this field falls back to the outbox
 *                  row's own created_at, which is the same moment (Date.now()
 *                  at enqueue), so counts already waiting on a phone get their
 *                  real capture time after the update too.
 *   clientSentAt - when this request leaves the phone, set per send (a retry
 *                  sends a new one). The sync engine hands api() this builder
 *                  as a body FACTORY, so the stamp is taken after the bearer
 *                  is resolved, right before the send: the server places the
 *                  capture at its arrival clock minus the gap, so a stamp
 *                  taken early lands the capture late.
 *
 * The phone's clock may be wrong. The server trusts only the gap between the
 * two readings and places the capture on its own clock, then clamps it to the
 * count's window; an unreadable pair is ignored there, never refused.
 */

/** Before this an outbox created_at is not a real enqueue time (a fixture, a
 *  corrupt row): send no capture time rather than a wildly early one. */
const EARLIEST_PLAUSIBLE_MS = Date.UTC(2020, 0, 1);

export function recordCountBody(
  payload: Record<string, unknown>,
  countedQuantity: number,
  rowCreatedAt: number | null | undefined,
  now: number = Date.now(),
): Record<string, unknown> {
  const body: Record<string, unknown> = { ...payload, countedQuantity };
  const stamped = typeof payload.capturedAt === 'string' && payload.capturedAt.trim() !== '';
  if (!stamped) {
    delete body.capturedAt;
    if (
      typeof rowCreatedAt === 'number' &&
      Number.isFinite(rowCreatedAt) &&
      rowCreatedAt >= EARLIEST_PLAUSIBLE_MS
    ) {
      body.capturedAt = new Date(rowCreatedAt).toISOString();
    }
  }
  if (typeof body.capturedAt === 'string') {
    body.clientSentAt = new Date(now).toISOString();
  } else {
    delete body.clientSentAt;
  }
  return body;
}
