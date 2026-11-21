import { describe, expect, it } from 'vitest';

import { recoveryCodeDoneReportsProblem, recoveryCodeDoneWords } from './recovery-code-words';

/**
 * The words after a used recovery code (stage 5, answers Q6 and Q7; the
 * review of stage 5, finding 1). They say what really happened, from the
 * action's answer: how many authenticator apps were removed (the true count
 * the old toast gave), the passkeys only for an account that had them, a
 * method that could not be removed (which kind, never which one), and whether
 * the other devices were signed out. Nothing claims a removal that did not
 * happen, and nothing claims a check that was not made (the review of the
 * last deltas, findings 3 and 8):
 *   - when no removal was tried (the list of methods could not be read), the
 *     words say the methods could not be removed, never that a check failed;
 *   - when the passkeys were removed but the account still lists a second
 *     step, the words say exactly that, never that a passkey is still there;
 *   - when the passkey records are not known to be removed, the words say a
 *     passkey may still be on the account, never that it was removed.
 * Words that report a problem are shown as a warning, never as a success
 * (recoveryCodeDoneReportsProblem).
 */

describe('recoveryCodeDoneWords', () => {
  it.each([
    [
      { unenrolled: 1 },
      'Recovery code accepted. 1 authenticator app was removed, and your other devices were signed out. Set up a new one now.',
    ],
    [
      { unenrolled: 2 },
      'Recovery code accepted. 2 authenticator apps were removed, and your other devices were signed out. Set up a new one now.',
    ],
    [
      { unenrolled: 0 },
      'Recovery code accepted. Your other devices were signed out. Set up a sign-in method now.',
    ],
    [
      { unenrolled: 1, otherSessionsLeft: true },
      'Recovery code accepted. 1 authenticator app was removed. We could not sign out your other devices, so change your password now. Then set up a new one.',
    ],
    [
      { unenrolled: 2, passkeysRemoved: true, appsRemoved: 1 },
      'Recovery code accepted. 1 authenticator app and your passkeys were removed, and your other devices were signed out. Set up a new one now.',
    ],
    [
      { unenrolled: 1, passkeysRemoved: true, appsRemoved: 0 },
      'Recovery code accepted. Your passkeys were removed, and your other devices were signed out. Set up a new one now.',
    ],
  ] as const)('everything removed: %j', (answer, words) => {
    expect(recoveryCodeDoneWords(answer)).toBe(words);
  });

  it.each([
    [
      { unenrolled: 0, methodsLeft: 'app' },
      "Recovery code accepted. An authenticator app could not be removed. Your other devices were signed out. Ask your organization's owner or StockPilot support for help.",
    ],
    [
      { unenrolled: 1, methodsLeft: 'app' },
      "Recovery code accepted. 1 authenticator app was removed. An authenticator app could not be removed. Your other devices were signed out. Ask your organization's owner or StockPilot support for help.",
    ],
    [
      { unenrolled: 1, appsRemoved: 1, methodsLeft: 'passkey' },
      "Recovery code accepted. 1 authenticator app was removed. A passkey may still be on your account. Your other devices were signed out. Ask your organization's owner or StockPilot support for help.",
    ],
    [
      { unenrolled: 1, appsRemoved: 0, methodsLeft: 'passkey' },
      "Recovery code accepted. A passkey may still be on your account. Your other devices were signed out. Ask your organization's owner or StockPilot support for help.",
    ],
    [
      { unenrolled: 0, methodsLeft: 'app_and_passkey', otherSessionsLeft: true },
      "Recovery code accepted. An authenticator app could not be removed, and a passkey may still be on your account. We could not sign out your other devices. Ask your organization's owner or StockPilot support for help.",
    ],
    [
      { unenrolled: 0, passkeysRemoved: true, appsRemoved: 0, methodsLeft: 'second_step' },
      "Recovery code accepted. Your passkeys were removed. Your account still asks for a second step. Your other devices were signed out. Ask your organization's owner or StockPilot support for help.",
    ],
    [
      { unenrolled: 1, passkeysRemoved: true, appsRemoved: 1, methodsLeft: 'second_step' },
      "Recovery code accepted. 1 authenticator app and your passkeys were removed. Your account still asks for a second step. Your other devices were signed out. Ask your organization's owner or StockPilot support for help.",
    ],
    [
      { unenrolled: 1, passkeysRemoved: true, appsRemoved: 1, methodsLeft: 'app' },
      "Recovery code accepted. 1 authenticator app and your passkeys were removed. An authenticator app could not be removed. Your other devices were signed out. Ask your organization's owner or StockPilot support for help.",
    ],
    [
      { unenrolled: 0, methodsLeft: 'unchecked' },
      "Recovery code accepted. Your sign-in methods could not be removed. Your other devices were signed out. Ask your organization's owner or StockPilot support for help.",
    ],
    [
      { unenrolled: 0, passkeysRemoved: true, methodsLeft: 'unchecked' },
      "Recovery code accepted. Your passkeys were removed. Your other sign-in methods could not be removed. Your other devices were signed out. Ask your organization's owner or StockPilot support for help.",
    ],
  ] as const)('a method left: %j', (answer, words) => {
    expect(recoveryCodeDoneWords(answer)).toBe(words);
  });

  it('never says a check failed, and never says a passkey is still there when it is only the second step that is', () => {
    for (const methodsLeft of [
      'app',
      'passkey',
      'app_and_passkey',
      'second_step',
      'unchecked',
    ] as const) {
      for (const passkeysRemoved of [true, false]) {
        const words = recoveryCodeDoneWords({ unenrolled: 0, passkeysRemoved, methodsLeft });
        expect(words).not.toMatch(/could not check/i);
        if (methodsLeft === 'second_step') {
          expect(words).not.toMatch(/passkey (could not be removed|may still be|is still)/i);
          expect(words).not.toMatch(/bridge|factor|hidden/i);
        }
        if (methodsLeft === 'passkey' || methodsLeft === 'app_and_passkey') {
          expect(recoveryCodeDoneWords({ unenrolled: 0, methodsLeft })).not.toMatch(
            /passkeys? (was|were) removed/i,
          );
        }
      }
    }
  });

  it('an account with no passkey never reads the word', () => {
    for (const answer of [
      { unenrolled: 1 },
      { unenrolled: 0, methodsLeft: 'app' as const },
      { unenrolled: 0, methodsLeft: 'unchecked' as const, otherSessionsLeft: true },
    ]) {
      expect(recoveryCodeDoneWords(answer)).not.toMatch(/passkey/i);
    }
  });
});

describe('recoveryCodeDoneReportsProblem: words that report a problem are a warning, never a success', () => {
  it.each([
    { unenrolled: 1 },
    { unenrolled: 0 },
    { unenrolled: 2, passkeysRemoved: true, appsRemoved: 1 },
  ] as const)('everything went: not a problem: %j', (answer) => {
    expect(recoveryCodeDoneReportsProblem(answer)).toBe(false);
  });

  it.each([
    { unenrolled: 1, otherSessionsLeft: true },
    { unenrolled: 0, methodsLeft: 'app' },
    { unenrolled: 0, methodsLeft: 'passkey' },
    { unenrolled: 0, methodsLeft: 'app_and_passkey' },
    { unenrolled: 0, passkeysRemoved: true, methodsLeft: 'second_step' },
    { unenrolled: 0, methodsLeft: 'unchecked' },
  ] as const)('something was left: a problem: %j', (answer) => {
    expect(recoveryCodeDoneReportsProblem(answer)).toBe(true);
  });
});
