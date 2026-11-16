import { AUTHENTICATOR_SET_UP_OWED_COPY } from '@stockpilot/core';

import {
  ADJUST_STOCK_KIND,
  describeQueuedAdjust,
  refusedQueuedAdjustMessage,
} from './adjust-outbox';

/**
 * WHAT UNSENT WORK SAYS FOR A ROW PARKED ON THE AUTHENTICATOR ANSWER.
 *
 * A row in Settings > Unsent work whose stored message is the server's
 * sentence for the authenticator answer (the organization requires an
 * authenticator the account had not set up) is not sent: most kinds are
 * relative (receive N more, move N, add or remove N), and sending one days
 * later would apply it on top of whatever the person entered since. That is
 * a decision for a person with the current facts. These words say so.
 *
 * Such a row stored only the server's sentence, no code, so this is the one
 * place a stored message is matched, EXACTLY, against the sentences the
 * server sends for that answer, and only to choose what is displayed. The
 * drains never decide anything by a message (drain-failure.ts).
 */

/** Shown in place of the server's sentence for such a row. */
export const PARKED_FOR_AUTHENTICATOR_COPY =
  'Not sent: your organization required an authenticator before this could be saved. If it is still needed, enter it again.';

/**
 * The server's sentences for the set-up answer: the one its services send
 * with details.reason 'mfa_required', and core's, which the API sends for
 * the same answer on reads.
 */
const SET_UP_REFUSAL_SENTENCES: readonly string[] = [
  'Multi-factor authentication required. Enroll in MFA before performing this action.',
  AUTHENTICATOR_SET_UP_OWED_COPY,
];

/**
 * The lastError to show for a stored row: the plain sentence for a REJECTED
 * row whose stored message is exactly the set-up answer (for an adjustment,
 * exactly what the drain stored for it, so the item and the change are still
 * named); otherwise the stored message unchanged.
 */
export function shownLastError(row: {
  status: string;
  kind: string;
  payload: Record<string, unknown>;
  lastError: string | null;
}): string | null {
  const stored = row.lastError;
  if (row.status !== 'rejected' || !stored) return stored;
  if (row.kind === ADJUST_STOCK_KIND) {
    const matched = SET_UP_REFUSAL_SENTENCES.some(
      (sentence) => refusedQueuedAdjustMessage(row.payload, sentence) === stored,
    );
    return matched
      ? `${describeQueuedAdjust(row.payload)}. ${PARKED_FOR_AUTHENTICATOR_COPY}`
      : stored;
  }
  return SET_UP_REFUSAL_SENTENCES.includes(stored) ? PARKED_FOR_AUTHENTICATOR_COPY : stored;
}
