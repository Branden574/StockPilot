import { describe, expect, it } from 'vitest';

import { isBannedUserAuthError } from './auth-error-classify';

/**
 * Pins the contract this module exists to hold: the decision is made on the
 * structured `code` and on nothing else.
 *
 * The message cases are the load-bearing ones. GoTrue's copy for a ban is
 * literally "User is banned", so a well-meaning substring check would look
 * correct in review — and would then let any error whose text an attacker can
 * influence steer an authentication branch. These assertions are what stop that
 * refactor from passing.
 */
describe('isBannedUserAuthError', () => {
  it('recognises the structured ban code', () => {
    expect(isBannedUserAuthError({ code: 'user_banned', status: 400 })).toBe(true);
  });

  it('does not treat a credential mismatch as a ban', () => {
    expect(isBannedUserAuthError({ code: 'invalid_credentials', status: 400 })).toBe(false);
  });

  it('does not treat a rate limit as a ban', () => {
    expect(isBannedUserAuthError({ code: 'over_request_rate_limit', status: 429 })).toBe(false);
  });

  it('ignores the message entirely, even when it says the account is banned', () => {
    expect(
      isBannedUserAuthError({ code: 'invalid_credentials', message: 'User is banned' }),
    ).toBe(false);
    expect(isBannedUserAuthError({ message: 'User is banned' })).toBe(false);
  });

  it('is false for a missing, null or undefined error', () => {
    expect(isBannedUserAuthError(null)).toBe(false);
    expect(isBannedUserAuthError(undefined)).toBe(false);
    expect(isBannedUserAuthError({})).toBe(false);
  });

  it('does not accept a non-string code that merely stringifies to the ban code', () => {
    expect(isBannedUserAuthError({ code: { toString: () => 'user_banned' } })).toBe(false);
  });
});
