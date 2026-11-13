import { describe, expect, it } from 'vitest';

import {
  openedFromResetLink,
  RESET_LINK_CLOCK_SKEW_S,
  RESET_LINK_METHODS,
  RESET_LINK_WINDOW_S,
} from './reset-link-session';

/**
 * The reset page sets a new password only on a session that an emailed link
 * made within the last hour: the session's verified `amr` claim holds an entry
 * for such a link, with its time.
 */
const NOW = 1_800_000_000;

describe('openedFromResetLink', () => {
  it('the accepted link methods and the window are the ones the reset page relies on', () => {
    expect([...RESET_LINK_METHODS]).toEqual(['recovery', 'invite', 'otp']);
    expect(RESET_LINK_WINDOW_S).toBe(60 * 60);
    expect(RESET_LINK_CLOCK_SKEW_S).toBe(5 * 60);
  });

  it.each(['recovery', 'invite', 'otp'])('a %s entry from a minute ago counts', (method) => {
    expect(openedFromResetLink([{ method, timestamp: NOW - 60 }], NOW)).toBe(true);
  });

  it('counts beside other entries (an authenticator code entered after the link)', () => {
    expect(
      openedFromResetLink(
        [
          { method: 'totp', timestamp: NOW - 10 },
          { method: 'recovery', timestamp: NOW - 120 },
        ],
        NOW,
      ),
    ).toBe(true);
  });

  it('counts up to the end of the hour, and not after it', () => {
    expect(openedFromResetLink([{ method: 'recovery', timestamp: NOW - 3600 }], NOW)).toBe(true);
    expect(openedFromResetLink([{ method: 'recovery', timestamp: NOW - 3601 }], NOW)).toBe(false);
  });

  it('allows the Auth server’s clock to run up to five minutes ahead, and no more', () => {
    expect(openedFromResetLink([{ method: 'recovery', timestamp: NOW + 300 }], NOW)).toBe(true);
    expect(openedFromResetLink([{ method: 'recovery', timestamp: NOW + 301 }], NOW)).toBe(false);
  });

  it.each([
    ['a password sign-in', [{ method: 'password', timestamp: NOW - 60 }]],
    ['an authenticator code alone', [{ method: 'totp', timestamp: NOW - 60 }]],
    ['a sign-in link', [{ method: 'magiclink', timestamp: NOW - 60 }]],
    ['a recovery code', [{ method: 'mfa/recovery_code', timestamp: NOW - 60 }]],
    ['methods without times', ['recovery', 'otp']],
    ['a time that is not a number', [{ method: 'recovery', timestamp: String(NOW) }]],
    ['no entries', []],
    ['no claim', undefined],
    ['a claim that is not a list', { method: 'recovery', timestamp: NOW }],
    ['empty entries', [null, 7, 'x']],
  ])('does not count %s', (_label, amr) => {
    expect(openedFromResetLink(amr, NOW)).toBe(false);
  });
});
