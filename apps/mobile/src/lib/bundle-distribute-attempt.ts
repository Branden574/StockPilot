import { outboxRefusalSentence } from './outbox-scope';

/**
 * ONE DISTRIBUTION, ONE KEY, ACROSS A RETRY (docket B10).
 *
 * The Distribute screen (app/bundles/[id].tsx) sends a distribution with an
 * idempotency key minted before the first attempt. When the server cannot be
 * reached (no answer, its own timeout, a 5xx), the server may or may not have
 * made the distribution, so the screen queues the SAME request with the SAME
 * key, and the server makes it once (0347: same key and same request returns
 * the first distribution).
 *
 * The queue can refuse: no account to queue it for, or the workspace still
 * loading after a different account signed in (outbox-scope.ts). The screen
 * let that refusal escape as an unhandled rejection, so nothing was said, and
 * a person who tapped Distribute again sent it with a NEW key: when the first
 * try had reached the server, the kits were distributed twice. Now the
 * refusal is said, and the key is kept while that distribution's outcome is
 * unknown, so trying again with the same quantity, warehouse and shortage
 * choice is the same request with the same key.
 */

export interface DistributeKey {
  /** The request the key stands for (distributeSignature). */
  signature: string;
  key: string;
}

/**
 * What the server's idempotency check compares (0347 distribute_bundle: the
 * bundle, quantity, warehouse and shortage choice; notes are commentary, not
 * the request). The same key with another request is refused as a conflict.
 */
export function distributeSignature(req: {
  bundleId: string;
  quantity: number;
  warehouseId: string;
  allowShortage: boolean;
}): string {
  return JSON.stringify([req.bundleId, req.quantity, req.warehouseId, req.allowShortage]);
}

/** The key for this attempt: the kept one when it is the same request, else a new one. */
export function distributeKeyFor(
  kept: DistributeKey | null,
  signature: string,
  mint: () => string,
): DistributeKey {
  return kept && kept.signature === signature ? kept : { signature, key: mint() };
}

/**
 * The alert when the server could not be reached and the phone could not
 * queue the distribution either: the outbox's own sentence when it refused,
 * else the phone's store failed (its error text is not written for people).
 */
export function distributeNotSavedAlert(
  sendError: unknown,
  queueError: unknown,
): { title: string; message: string } {
  const why = sendError instanceof Error && sendError.message ? sendError.message : 'network error';
  const refusal = outboxRefusalSentence(queueError) ?? 'This phone could not save it. Try again.';
  return {
    title: 'Could not save offline',
    message: `Couldn't reach the server (${why}), and the distribution could not be saved on this phone: ${refusal}`,
  };
}
