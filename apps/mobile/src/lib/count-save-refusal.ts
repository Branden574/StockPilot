import { outboxRefusalSentence } from './outbox-scope';

/**
 * WHAT A COUNT SCREEN SAYS WHEN THE PHONE DID NOT SAVE A COUNT, OR DID NOT
 * CLEAR ONE (docket B10).
 *
 * updateLocalLine (cycle-count-cache.ts) saves a count on the phone and queues
 * it for the server in one step, and throws when it cannot: the outbox refused
 * it (no account to queue it for, or the workspace still loading: the saved
 * one is another account's, or an older build's not yet recorded as this
 * account's; outbox-scope.ts), or the phone's own store failed. Nothing is saved either way. The count screen and the count scanner
 * let that throw escape as an unhandled rejection, so nothing was said: the
 * count screen kept the number in its box as if it were saved, and the
 * scanner stayed busy and ignored every scan after it. Each now says why, in
 * the outbox's own sentence. (The AI shelf scan copies a count the server
 * already recorded with mirrorRecordedCount, which queues nothing and is
 * never refused.)
 *
 * An emptied box clears the line's saved count (B4a) with clearLocalLine,
 * which queues the clear through the same writer, so it is refused in the
 * same cases and said the same way.
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

/** The phone's own store failed to clear a count. */
export const COUNT_NOT_CLEARED_ON_PHONE = 'This phone could not clear the count. Try again.';

/** The alert for an emptied box whose count clearLocalLine did not clear. */
export function countNotClearedAlert(e: unknown): { title: string; message: string } {
  return {
    title: 'Count not cleared',
    message: outboxRefusalSentence(e) ?? COUNT_NOT_CLEARED_ON_PHONE,
  };
}
