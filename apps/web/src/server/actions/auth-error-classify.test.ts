import { describe, expect, it } from 'vitest';

import { classifyPasswordUpdateError, isBannedUserAuthError } from './auth-error-classify';

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

/**
 * Docket B50: how GoTrue refused `updateUser({ password })` on a reset link's
 * session. The same rule as above: GoTrue's structured `code`, never the
 * message. The one exception is the SDK's own session-missing error, which has
 * no code (auth-js also turns GoTrue's session_not_found into it), so it is
 * matched by `name`, as the phone does (account-disabled-probe.ts).
 */
describe('classifyPasswordUpdateError', () => {
  it.each([
    [{ code: 'insufficient_aal', status: 403 }, { kind: 'aal' }],
    [{ code: 'same_password', status: 422 }, { kind: 'same' }],
    [
      { code: 'weak_password', status: 422, reasons: ['pwned'] },
      { kind: 'weak', breached: true },
    ],
    [
      { code: 'weak_password', status: 422, reasons: ['length', 'pwned'] },
      { kind: 'weak', breached: true },
    ],
    [
      { code: 'weak_password', status: 422, reasons: ['length', 'characters'] },
      { kind: 'weak', breached: false },
    ],
    [
      { code: 'weak_password', status: 422 },
      { kind: 'weak', breached: false },
    ],
    [
      { code: 'weak_password', reasons: 'pwned' },
      { kind: 'weak', breached: false },
    ],
    [
      { name: 'AuthSessionMissingError', message: 'Auth session missing!', status: 400 },
      { kind: 'session_gone' },
    ],
    [{ code: 'session_not_found', status: 403 }, { kind: 'session_gone' }],
    [{ code: 'session_expired', status: 403 }, { kind: 'session_gone' }],
    [{ code: 'refresh_token_not_found', status: 400 }, { kind: 'session_gone' }],
  ])('reads %j as %j', (error, expected) => {
    expect(classifyPasswordUpdateError(error)).toEqual(expected);
  });

  it('leaves every other refusal to the caller', () => {
    expect(classifyPasswordUpdateError({ code: 'invalid_credentials', status: 400 })).toBeNull();
    expect(
      classifyPasswordUpdateError({ code: 'over_request_rate_limit', status: 429 }),
    ).toBeNull();
    expect(classifyPasswordUpdateError({ name: 'AuthApiError', status: 500 })).toBeNull();
  });

  it('ignores the message entirely, even when it names the refusal', () => {
    expect(
      classifyPasswordUpdateError({
        message: 'AAL2 session is required to update email or password when MFA is enabled.',
      }),
    ).toBeNull();
    expect(
      classifyPasswordUpdateError({
        message: 'New password should be different from the old password.',
      }),
    ).toBeNull();
    expect(classifyPasswordUpdateError({ message: 'Auth session missing!' })).toBeNull();
    expect(
      classifyPasswordUpdateError({ code: 'unexpected_failure', message: 'insufficient_aal' }),
    ).toBeNull();
  });

  it('is null for a missing, null or undefined error', () => {
    expect(classifyPasswordUpdateError(null)).toBeNull();
    expect(classifyPasswordUpdateError(undefined)).toBeNull();
    expect(classifyPasswordUpdateError({})).toBeNull();
  });

  it('does not accept a code or name that merely stringifies to a known one', () => {
    expect(
      classifyPasswordUpdateError({ code: { toString: () => 'insufficient_aal' } }),
    ).toBeNull();
    expect(
      classifyPasswordUpdateError({ name: { toString: () => 'AuthSessionMissingError' } }),
    ).toBeNull();
  });
});
