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
 * scanner stayed busy and ignored every scan after it. Each now says why, in
 * the outbox's own sentence. (The AI shelf scan copies a count the server
 * already recorded with mirrorRecordedCount, which queues nothing and is
 * never refused.)
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
