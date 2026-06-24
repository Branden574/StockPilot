import { describe, expect, it } from 'vitest';

import { aalFromJwt } from './api-context';

/** Build a JWT-shaped string (header.payload.sig) with the given payload. */
function fakeJwt(payload: Record<string, unknown>): string {
  const seg = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${seg({ alg: 'HS256', typ: 'JWT' })}.${seg(payload)}.signature`;
}

describe('aalFromJwt', () => {
  it('reads aal2 from a token that completed the TOTP step-up', () => {
    expect(aalFromJwt(fakeJwt({ sub: 'u1', aal: 'aal2' }))).toBe('aal2');
  });

  it('reads aal1 from a password-only session', () => {
    expect(aalFromJwt(fakeJwt({ sub: 'u1', aal: 'aal1' }))).toBe('aal1');
  });

  it('returns null when there is no aal claim (fails closed downstream)', () => {
    expect(aalFromJwt(fakeJwt({ sub: 'u1' }))).toBeNull();
  });

  it('returns null for a non-JWT / malformed token', () => {
    expect(aalFromJwt('not-a-jwt')).toBeNull();
    expect(aalFromJwt('')).toBeNull();
    expect(aalFromJwt('a.b')).toBeNull(); // missing/garbage payload
  });

  it('ignores an unexpected aal value', () => {
    expect(aalFromJwt(fakeJwt({ aal: 'aal3' }))).toBeNull();
  });
});
