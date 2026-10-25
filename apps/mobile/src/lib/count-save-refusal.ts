import { outboxRefusalSentence } from './outbox-scope';

/**
 * WHAT A COUNT SCREEN SAYS WHEN THE PHONE DID NOT SAVE A COUNT (docket B10).
 *
 * updateLocalLine (cycle-count-cache.ts) saves a count on the phone and queues
 * it for the server in one step, and throws when it cannot: the outbox refused
 * it (no account to queue it for, or the workspace still loading after a
 * different account signed in; outbox-scope.ts), or the phone's own store
 * failed. Nothing is saved either way. The count screen and the count scanner
 * let that throw escape as an unhandled rejection, so nothing was said: the
 * count screen kept the number in its box as if it were saved, and the
 * scanner stayed busy and ignored every scan after it. The AI shelf scan said
 * to check the connection. Each now says why, in the outbox's own sentence.
 */

/** The phone's own store failed. Its error text is not written for people. */
export const COUNT_NOT_SAVED_ON_PHONE = 'This phone could not save the count. Try again.';

/** The alert for a count updateLocalLine did not save. */
export function countNotSavedAlert(e: unknown): { title: string; message: string } {
  return {
    title: 'Count not saved',
    message: outboxRefusalSentence(e) ?? COUNT_NOT_SAVED_ON_PHONE,
  };
}

/**
 * The AI shelf scan's "Partially saved" sentence. `refusal` is the outbox's
 * sentence when a line's copy on the phone was refused
 * (outboxRefusalSentence), said as it is; otherwise the connection is the
 * likely cause, as before.
 */
export function partialSaveMessage(total: number, failed: number, refusal: string | null): string {
  const saved = `${total - failed} of ${total} counts saved. `;
  return refusal
    ? `${saved}${failed} couldn't save: ${refusal}`
    : `${saved}${failed} couldn't save — check your connection and tap Confirm to retry.`;
}
