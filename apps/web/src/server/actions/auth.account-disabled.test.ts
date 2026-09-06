import { describe, expect, it } from 'vitest';

import { isBannedUserAuthError } from './auth-error-classify';

/**
 * A banned user and a wrong password must be distinguishable server-side, but
 * the "temporarily disabled" sentence must NEVER be shown for a mere bad
 * credential — that would turn the sign-in form into an account-status oracle.
 * The only accepted signal is GoTrue's own structured `user_banned` code.
 */

describe('isBannedUserAuthError', () => {
  it('recognises the structured GoTrue code', () => {
    expect(isBannedUserAuthError({ code: 'user_banned' })).toBe(true);
  });

  it('does NOT fire on invalid credentials', () => {
    expect(
      isBannedUserAuthError({ code: 'invalid_credentials', message: 'Invalid login credentials' }),
    ).toBe(false);
  });

  it('does NOT fire on a rate limit', () => {
    expect(isBannedUserAuthError({ status: 429, code: 'over_email_send_rate_limit' })).toBe(false);
  });

  it('never infers a ban from free-text alone — an attacker-influenced message is not a signal', () => {
    expect(isBannedUserAuthError({ message: 'user_banned' })).toBe(false);
    expect(isBannedUserAuthError({ message: 'your user_banned account' })).toBe(false);
  });

  it('tolerates null and empty errors', () => {
    expect(isBannedUserAuthError(null)).toBe(false);
    expect(isBannedUserAuthError({})).toBe(false);
  });
});

/**
 * The signInAction half of this file used to be a SOURCE-TEXT grep: it read
 * auth.ts and asserted that `if (isBannedUserAuthError(` appeared before
 * `'Invalid email or password'`. That is satisfied by a ban branch sitting in
 * dead or unreachable code, so it proved nothing about behaviour (SP-051).
 *
 * It was replaced by real calls in `auth.sign-in.test.ts`, which drives
 * signInAction with a `user_banned` error and asserts the returned code,
 * message and audit reason — and, in the mirror case, that a genuine
 * credential mismatch still collapses to the generic sentence so the form
 * never becomes an account-status oracle. Keep the two files together: this
 * one pins the CLASSIFIER, that one pins the ACTION that consumes it.
 */
