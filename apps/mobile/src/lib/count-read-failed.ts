import {
  CYCLE_COUNTS_NOT_AVAILABLE,
  NOT_SYNCED_YET,
  SAVED_ACCESS_UNREADABLE,
} from './screen-access';

/**
 * WHAT THE COUNT SCREEN SHOWS WHEN IT HAS NO COUNT TO SHOW (S75).
 *
 * The count screen's read-failed state carries one sentence (readError). By
 * that sentence:
 *   - a member who may not see cycle counts ('denied'): "Not available", the
 *     sentence, and Back. Nothing to try again;
 *   - this workspace not synced yet for this member, offline ('not-synced'):
 *     "Not synced yet", and Retry;
 *   - what the phone saved about the member's access could not be read
 *     ('unreadable'): Retry, which reads it again first;
 *   - any other failed read: "Could not load this count", the sentence, the
 *     note that the server may be catching up after an update, and Retry.
 */
export interface CountReadFailedView {
  title: string;
  /** Add "If the app was just updated, the server may still be catching up." */
  catchingUpNote: boolean;
  action: 'retry' | 'back';
  /** Retry reads the saved access again first (use-screen-access.ts retrySavedAccess). */
  rereadAccess: boolean;
}

export function countReadFailedView(readError: string | null): CountReadFailedView {
  if (readError === CYCLE_COUNTS_NOT_AVAILABLE) {
    return { title: 'Not available', catchingUpNote: false, action: 'back', rereadAccess: false };
  }
  if (readError === NOT_SYNCED_YET) {
    return { title: 'Not synced yet', catchingUpNote: false, action: 'retry', rereadAccess: false };
  }
  if (readError === SAVED_ACCESS_UNREADABLE) {
    return {
      title: 'Could not load this count',
      catchingUpNote: false,
      action: 'retry',
      rereadAccess: true,
    };
  }
  return {
    title: 'Could not load this count',
    catchingUpNote: true,
    action: 'retry',
    rereadAccess: false,
  };
}
