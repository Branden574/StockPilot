import { describe, expect, it } from 'vitest';

import { recoveryCodeDoneWords } from './recovery-code-words';

/**
 * The words after a used recovery code (stage 5, answers Q6 and Q7; the
 * review of stage 5, finding 1). They say what really happened, from the
 * action's answer: how many authenticator apps were removed (the true count
 * the old toast gave), the passkeys only for an account that had them, a
 * method that could not be removed (which kind, never which one), and whether
 * the other devices were signed out. Nothing claims a removal that did not
 * happen.
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
      "Recovery code accepted. 1 authenticator app was removed. A passkey could not be removed. Your other devices were signed out. Ask your organization's owner or StockPilot support for help.",
    ],
    [
      { unenrolled: 0, methodsLeft: 'app_and_passkey', otherSessionsLeft: true },
      "Recovery code accepted. An authenticator app and a passkey could not be removed. We could not sign out your other devices. Ask your organization's owner or StockPilot support for help.",
    ],
    [
      { unenrolled: 0, methodsLeft: 'unchecked' },
      "Recovery code accepted. We could not check that your sign-in methods were removed. Your other devices were signed out. Ask your organization's owner or StockPilot support for help.",
    ],
  ] as const)('a method left: %j', (answer, words) => {
    expect(recoveryCodeDoneWords(answer)).toBe(words);
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
