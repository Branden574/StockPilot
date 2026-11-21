/**
 * The words of a recovery code on the web (answers Q6 and Q7 of the passkey
 * plan): a used code removes the account's second-step methods and signs out
 * its other devices, and the session that used it stays. The dialog's words
 * are the same for every member, so they name no passkey. The words after a
 * press are the true ones for this account, from the action's answer (the
 * review of stage 5, finding 1): the count of authenticator apps removed, the
 * passkeys only for an account that had them, a method that could not be
 * removed (which kind, never which one), and whether the other devices were
 * signed out. Client-safe: no server import.
 */
export const RECOVERY_CODE_WORDS = {
  /** The code page's dialog, before the press. */
  dialogBody:
    'Enter one of the recovery codes you saved when you set up two-factor authentication. This uses up the code and removes your two-factor sign-in methods. Your other devices are signed out. You stay signed in here and set up a new one next.',
} as const;

/** What could not be removed: which kind, never which one. */
export type RecoveryMethodsLeft = 'app' | 'passkey' | 'app_and_passkey' | 'unchecked';

/** The action's answer after a used code (consumeMfaRecoveryCodeAction). */
export interface RecoveryCodeDone {
  /** Every factor removed, the passkey's hidden one included. */
  unenrolled: number;
  /** The other sessions could not be ended. */
  otherSessionsLeft?: boolean;
  /** The account's passkeys were removed (only for an account that had them). */
  passkeysRemoved?: boolean;
  /** Authenticator apps removed, when the account had passkeys (else `unenrolled`). */
  appsRemoved?: number;
  /** A method that could not be removed, or a factor list that could not be read. */
  methodsLeft?: RecoveryMethodsLeft;
}

const LEFT_WORDS: Record<RecoveryMethodsLeft, string> = {
  app: 'An authenticator app could not be removed.',
  passkey: 'A passkey could not be removed.',
  app_and_passkey: 'An authenticator app and a passkey could not be removed.',
  unchecked: 'We could not check that your sign-in methods were removed.',
};

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
    words.push(LEFT_WORDS[answer.methodsLeft]);
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
