/**
 * The words of a recovery code on the web (answers Q6 and Q7 of the passkey
 * plan): a used code removes the account's second-step methods and signs out
 * its other devices, and the session that used it stays. The dialog's words
 * are the same for every member, so they name no passkey. The words after a
 * press are the true ones for this account, from the action's answer (the
 * review of stage 5, finding 1): the count of authenticator apps removed, the
 * passkeys only for an account that had them, a method that could not be
 * removed (which kind, never which one), and whether the other devices were
 * signed out. Nothing claims a removal that is not known, or a check that
 * was not made (the review of the last deltas, findings 3 and 8). Words that
 * report a problem are shown as a warning, never as a success
 * (recoveryCodeDoneReportsProblem). Client-safe: no server import.
 */
export const RECOVERY_CODE_WORDS = {
  /** The code page's dialog, before the press. */
  dialogBody:
    'Enter one of the recovery codes you saved when you set up two-factor authentication. This uses up the code and removes your two-factor sign-in methods. Your other devices are signed out. You stay signed in here and set up a new one next.',
} as const;

/**
 * What a used code left, by kind, never which one:
 *   - 'app': an authenticator app could not be removed;
 *   - 'passkey': the account's passkey records are not known to be removed,
 *     so a passkey may still be on the account;
 *   - 'app_and_passkey': both of the above;
 *   - 'second_step': the passkeys were removed, and the account still asks
 *     for a second step (the removal could not be finished);
 *   - 'unchecked': the list of methods could not be read, so no removal was
 *     tried.
 */
export type RecoveryMethodsLeft =
  'app' | 'passkey' | 'app_and_passkey' | 'second_step' | 'unchecked';

/** The action's answer after a used code (consumeMfaRecoveryCodeAction). */
export interface RecoveryCodeDone {
  /**
   * The sign-in methods removed at Auth, the passkey's hidden factor
   * included. A factor never set up (unverified) is removed too, but it is
   * no sign-in method and is not counted, so these words agree with the email
   * (the release review of stage 5, finding 2).
   */
  unenrolled: number;
  /** The other sessions could not be ended. */
  otherSessionsLeft?: boolean;
  /**
   * The account's passkeys were removed, and that is known (only for an
   * account that had them). Never set while their records may be left.
   */
  passkeysRemoved?: boolean;
  /**
   * Authenticator apps set up and removed, apart from the passkey's own
   * factor, when the account had passkeys (else `unenrolled`).
   */
  appsRemoved?: number;
  /** What the code left (RecoveryMethodsLeft). */
  methodsLeft?: RecoveryMethodsLeft;
}

/**
 * The sentence for what was left. `somethingRemoved`: the words before it
 * already say what was removed, so "your sign-in methods" would be untrue.
 */
function leftWords(left: RecoveryMethodsLeft, somethingRemoved: boolean): string {
  switch (left) {
    case 'app':
      return 'An authenticator app could not be removed.';
    case 'passkey':
      return 'A passkey may still be on your account.';
    case 'app_and_passkey':
      return 'An authenticator app could not be removed, and a passkey may still be on your account.';
    case 'second_step':
      return 'Your account still asks for a second step.';
    case 'unchecked':
      return somethingRemoved
        ? 'Your other sign-in methods could not be removed.'
        : 'Your sign-in methods could not be removed.';
  }
}

/**
 * Whether the words after a used code report a problem (a method left, or
 * the other devices not signed out): such words are shown as a warning.
 */
export function recoveryCodeDoneReportsProblem(answer: RecoveryCodeDone): boolean {
  return answer.methodsLeft !== undefined || answer.otherSessionsLeft === true;
}

const apps = (n: number) => `${n} authenticator app${n === 1 ? '' : 's'}`;

/** What was removed, as one phrase, or null when nothing was. */
function removedPhrase(answer: RecoveryCodeDone): string | null {
  const appCount = answer.appsRemoved ?? answer.unenrolled;
  if (answer.passkeysRemoved === true) {
    return appCount > 0 ? `${apps(appCount)} and your passkeys were` : 'Your passkeys were';
  }
  if (appCount === 0) return null;
  return `${apps(appCount)} ${appCount === 1 ? 'was' : 'were'}`;
}

/** The words after a used code, from the action's answer. */
export function recoveryCodeDoneWords(answer: RecoveryCodeDone): string {
  const removed = removedPhrase(answer);
  const othersLeft = answer.otherSessionsLeft === true;
  const words = ['Recovery code accepted.'];
  if (answer.methodsLeft) {
    if (removed) words.push(`${removed} removed.`);
    words.push(leftWords(answer.methodsLeft, removed !== null));
    words.push(
      othersLeft
        ? 'We could not sign out your other devices.'
        : 'Your other devices were signed out.',
    );
    words.push("Ask your organization's owner or StockPilot support for help.");
    return words.join(' ');
  }
  if (othersLeft) {
    if (removed) words.push(`${removed} removed.`);
    words.push(
      'We could not sign out your other devices, so change your password now. Then set up a new one.',
    );
    return words.join(' ');
  }
  words.push(
    removed
      ? `${removed} removed, and your other devices were signed out. Set up a new one now.`
      : 'Your other devices were signed out. Set up a sign-in method now.',
  );
  return words.join(' ');
}
