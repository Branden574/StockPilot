/**
 * The words of a recovery code on the web (answers Q6 and Q7 of the passkey
 * plan): a used code removes the account's second-step methods and signs out
 * its other devices, and the session that used it stays. The same words for
 * every member, so they name no passkey. Client-safe: no server import.
 */
export const RECOVERY_CODE_WORDS = {
  /** The code page's dialog, before the press. */
  dialogBody:
    'Enter one of the recovery codes you saved when you set up two-factor authentication. This uses up the code and removes your two-factor sign-in methods. Your other devices are signed out. You stay signed in here and set up a new one next.',
  /** After a used code, when every other session ended. */
  done: 'Your sign-in methods were removed and your other devices were signed out. Set up a new one now.',
  /** After a used code, when the other sessions could not be ended. */
  doneOthersLeft:
    'Your sign-in methods were removed. We could not sign out your other devices, so change your password now. Then set up a new one.',
} as const;

/** The words after a used code, from the action's answer. */
export function recoveryCodeDoneWords(answer: { otherSessionsLeft?: boolean }): string {
  return answer.otherSessionsLeft === true
    ? RECOVERY_CODE_WORDS.doneOthersLeft
    : RECOVERY_CODE_WORDS.done;
}
