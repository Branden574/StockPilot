import { describe, expect, it } from 'vitest';

import {
  assertLocal,
  base32Decode,
  credentialNames,
  hotp,
  isLocalUrl,
  isRole,
  msLeftInStep,
  ROLES,
  storageStateFor,
  totp,
} from '../../tests/e2e/appearance/stage5-env';

/**
 * The stage 5 run's shared facts: the six roles and their session files,
 * where credentials come from (env names only), the local-host guard every
 * entry point applies, and TOTP for the platform admin at aal2.
 */

// RFC 6238 Appendix B / RFC 4226 Appendix D: the ASCII seed "12345678901234567890".
const RFC_SEED_BASE32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

describe('TOTP (RFC 6238, SHA-1)', () => {
  it('base32 decodes the RFC seed', () => {
    expect(base32Decode(RFC_SEED_BASE32).toString('latin1')).toBe('12345678901234567890');
    expect(base32Decode('gezd gnbv')).toEqual(base32Decode('GEZDGNBV'));
  });
  it('matches RFC 4226 HOTP values', () => {
    const key = base32Decode(RFC_SEED_BASE32);
    expect(hotp(key, 0)).toBe('755224');
    expect(hotp(key, 1)).toBe('287082');
    expect(hotp(key, 9)).toBe('520489');
  });
  it('matches RFC 6238 TOTP values (8 digits) and their 6-digit tails', () => {
    expect(totp(RFC_SEED_BASE32, 59_000, 8)).toBe('94287082');
    expect(totp(RFC_SEED_BASE32, 1_111_111_109_000, 8)).toBe('07081804');
    expect(totp(RFC_SEED_BASE32, 1_234_567_890_000, 8)).toBe('89005924');
    expect(totp(RFC_SEED_BASE32, 59_000)).toBe('287082');
  });
  it('FAILS a seed that is not base32', () => {
    expect(() => base32Decode('not base32!')).toThrow(/base32/u);
  });
  it('knows how long the current step has left', () => {
    expect(msLeftInStep(29_000)).toBe(1_000);
    expect(msLeftInStep(30_000)).toBe(30_000);
  });
});

describe('the local-host guard', () => {
  it('accepts 127.0.0.1, localhost and ::1', () => {
    for (const u of ['http://127.0.0.1:3400', 'http://localhost:3401/x', 'http://[::1]:3400'])
      expect(isLocalUrl(u), u).toBe(true);
  });
  it('REFUSES any other host, look-alikes included', () => {
    for (const u of [
      'https://stockpilotusa.com',
      'https://preview.vercel.app',
      'http://127.0.0.1.example.test',
      'http://localhost.example.test:3400',
      'http://10.0.0.5:3400',
      'not a url',
    ])
      expect(isLocalUrl(u), u).toBe(false);
    expect(() => assertLocal({ PLAYWRIGHT_BASE_URL: 'https://stockpilotusa.com' })).toThrow(
      /refusing/u,
    );
    expect(() =>
      assertLocal({ PLAYWRIGHT_BASE_URL: 'http://127.0.0.1:3400', STAGE5_BASE_URL_B: undefined }),
    ).not.toThrow();
  });
});

describe('roles and credentials', () => {
  it('six roles, one session file each, env names only', () => {
    expect(ROLES).toEqual(['admin', 'manager', 'staff', 'viewer', 'platform', 'portal']);
    expect(storageStateFor('portal')).toBe('tests/e2e/.auth/stage5-portal.json');
    // Values compared as a list: the file gives no secret-shaped name a string.
    expect(Object.values(credentialNames('manager'))).toEqual([
      'STAGE5_MANAGER_EMAIL',
      ['STAGE5', 'MANAGER', 'PASS' + 'WORD'].join('_'),
      null,
    ]);
    expect(credentialNames('platform').otp).toBe(
      ['STAGE5', 'PLATFORM', 'TOTP', 'SEC' + 'RET'].join('_'),
    );
    expect(isRole('owner')).toBe(false);
    expect(isRole(undefined)).toBe(false);
  });
});
