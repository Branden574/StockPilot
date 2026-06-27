import { describe, it, expect } from 'vitest';

import { mfaAssertionAgeFromToken } from './platform-admin';

/** Build a JWT-shaped string whose payload carries the given `amr` claim. */
function tokenWithAmr(amr: unknown): string {
  const payload = Buffer.from(JSON.stringify({ amr }), 'utf8').toString('base64url');
  return `header.${payload}.sig`;
}

describe('mfaAssertionAgeFromToken (#8 fresh platform step-up)', () => {
  const NOW = 1_700_000_000;

  it('returns the age since the latest totp assertion (ignores password)', () => {
    const t = tokenWithAmr([
      { method: 'password', timestamp: NOW - 3600 },
      { method: 'totp', timestamp: NOW - 120 },
    ]);
    expect(mfaAssertionAgeFromToken(t, NOW)).toBe(120);
  });

  it('uses the most recent of multiple MFA assertions', () => {
    const t = tokenWithAmr([
      { method: 'totp', timestamp: NOW - 600 },
      { method: 'totp', timestamp: NOW - 60 },
    ]);
    expect(mfaAssertionAgeFromToken(t, NOW)).toBe(60);
  });

  it('returns null when there is no second-factor assertion (password only)', () => {
    const t = tokenWithAmr([{ method: 'password', timestamp: NOW - 10 }]);
    expect(mfaAssertionAgeFromToken(t, NOW)).toBeNull();
  });

  it('returns null when amr is absent', () => {
    const payload = Buffer.from(JSON.stringify({ sub: 'x' }), 'utf8').toString('base64url');
    expect(mfaAssertionAgeFromToken(`h.${payload}.s`, NOW)).toBeNull();
  });

  it('returns null on a malformed token (fail-closed)', () => {
    expect(mfaAssertionAgeFromToken('not-a-jwt', NOW)).toBeNull();
    expect(mfaAssertionAgeFromToken('', NOW)).toBeNull();
  });
});
