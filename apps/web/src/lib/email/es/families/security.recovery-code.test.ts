import { describe, expect, it } from 'vitest';

import { renderRecoveryCodeUsedEmail } from './security';

/**
 * The email of a used recovery code (stage 5, answer Q7; plan section 4):
 * "Your StockPilot sign-in methods were removed". It says what happened, in
 * the words that are true for this account (passkeys named only when the
 * account had one; the other devices said signed out only when they were),
 * and "If this was not you, reset your password now". The subject is fixed:
 * nothing a member typed reaches it. No link signs in: the one action is the
 * password reset page.
 */

const base = {
  email: 'member@example.test',
  usedAt: 'Nov 21, 2026, 9:41 AM UTC',
  appUrl: 'https://app.example.test',
};
const hrefs = (html: string) => [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]!);

describe('the recovery code email', () => {
  it('the subject and the sender, the time, and what to do if it was not you', () => {
    const m = renderRecoveryCodeUsedEmail({ ...base, passkeys: false, othersSignedOut: true });
    expect(m.subject).toBe('Your StockPilot sign-in methods were removed');
    expect(m.from).toBe('StockPilot Security <security@stockpilotusa.com>');
    expect(m.text).toContain(
      'a recovery code was used on your StockPilot account on Nov 21, 2026, 9:41 AM UTC.',
    );
    expect(m.text).toContain(
      'If this was not you, reset your password now: https://app.example.test/reset',
    );
    expect(m.html).toContain('Reset your password');
  });

  it.each([
    [false, true, 'Every authenticator app was removed, and your other devices were signed out.'],
    [
      true,
      true,
      'Every authenticator app and passkey was removed, and your other devices were signed out.',
    ],
    [
      false,
      false,
      'Every authenticator app was removed. We could not sign out your other devices.',
    ],
    [
      true,
      false,
      'Every authenticator app and passkey was removed. We could not sign out your other devices.',
    ],
  ])(
    'passkeys %s, other devices signed out %s: the true sentence',
    (passkeys, othersSignedOut, sentence) => {
      const m = renderRecoveryCodeUsedEmail({ ...base, passkeys, othersSignedOut });
      expect(m.text).toContain(sentence);
      expect(m.html).toContain(sentence.replace(/'/g, '&rsquo;'));
    },
  );

  it('an account with no passkey never reads the word passkey', () => {
    for (const othersSignedOut of [true, false]) {
      const m = renderRecoveryCodeUsedEmail({ ...base, passkeys: false, othersSignedOut });
      expect(`${m.subject}\n${m.preheader}\n${m.text}\n${m.html}`).not.toMatch(/passkey/i);
    }
  });

  it('the subject is the same whatever the address: nothing a member typed reaches it', () => {
    const odd = renderRecoveryCodeUsedEmail({
      ...base,
      email: 'sample+<b>x</b>@example.test',
      passkeys: true,
      othersSignedOut: false,
    });
    expect(odd.subject).toBe('Your StockPilot sign-in methods were removed');
    expect(odd.html).not.toContain('<b>x</b>');
  });

  it('its one action is the reset page: no link signs in, none carries a token or a code', () => {
    const m = renderRecoveryCodeUsedEmail({ ...base, passkeys: true, othersSignedOut: true });
    const own = hrefs(m.html).filter((h) => h.startsWith('https://app.example.test'));
    expect(own).toContain('https://app.example.test/reset');
    for (const href of hrefs(m.html)) {
      expect(href, href).not.toMatch(/signin|sign-in|token=|code=|verify|magic/i);
    }
  });
});
