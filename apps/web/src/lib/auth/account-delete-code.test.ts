import { describe, expect, it } from 'vitest';

import {
  ACCOUNT_DELETE_CODE_TTL_S,
  checkAccountDeleteCode,
  newAccountDeleteCode,
  signAccountDeleteChallenge,
} from './account-delete-code';

/**
 * The emailed code that confirms deleting an account with no authenticator:
 * the challenge holds for one account, one address, one code and ten minutes,
 * and only under this deployment's key.
 */

const KEY = 'example-service-key-for-tests';
const USER = '11111111-1111-4111-8111-111111111111';
const OTHER_USER = '22222222-2222-4222-8222-222222222222';
const EMAIL = 'person@example.test';
const NOW = new Date('2026-11-15T12:00:00Z');
const at = (seconds: number) => new Date(NOW.getTime() + seconds * 1000);

function signed(code = '042917') {
  const s = signAccountDeleteChallenge(KEY, { userId: USER, email: EMAIL, code, now: NOW });
  if (!s) throw new Error('not signed');
  return s;
}

describe('newAccountDeleteCode', () => {
  it('is six digits, leading zeros kept', () => {
    for (let i = 0; i < 200; i += 1) expect(newAccountDeleteCode()).toMatch(/^[0-9]{6}$/);
  });
});

describe('signAccountDeleteChallenge', () => {
  it('expires ten minutes after it was sent, and holds no code', () => {
    const s = signed('042917');
    expect(s.expiresAt).toBe(Math.floor(NOW.getTime() / 1000) + ACCOUNT_DELETE_CODE_TTL_S);
    expect(ACCOUNT_DELETE_CODE_TTL_S).toBe(600);
    expect(s.challenge).not.toContain('042917');
    expect(s.challenge.startsWith(`v1.${USER}.`)).toBe(true);
  });

  it('two challenges for the same code differ', () => {
    expect(signed().challenge).not.toBe(signed().challenge);
  });

  it('signs nothing without a key, an account id, an address or a six-digit code', () => {
    expect(
      signAccountDeleteChallenge('', { userId: USER, email: EMAIL, code: '123456', now: NOW }),
    ).toBeNull();
    expect(
      signAccountDeleteChallenge(KEY, { userId: 'user.1', email: EMAIL, code: '123456', now: NOW }),
    ).toBeNull();
    expect(
      signAccountDeleteChallenge(KEY, { userId: USER, email: ' ', code: '123456', now: NOW }),
    ).toBeNull();
    expect(
      signAccountDeleteChallenge(KEY, { userId: USER, email: EMAIL, code: '12345', now: NOW }),
    ).toBeNull();
    expect(
      signAccountDeleteChallenge(KEY, { userId: USER, email: EMAIL, code: '12345a', now: NOW }),
    ).toBeNull();
  });
});

describe('checkAccountDeleteCode', () => {
  const check = (over: Partial<Parameters<typeof checkAccountDeleteCode>[1]> = {}, key = KEY) => {
    const { challenge } = signed('042917');
    return checkAccountDeleteCode(key, {
      challenge,
      code: '042917',
      userId: USER,
      email: EMAIL,
      now: at(60),
      ...over,
    });
  };

  it('the right code, for this account and address, in time: valid', () => {
    expect(check()).toBe('valid');
  });

  it('the address is compared without case or spaces', () => {
    expect(check({ email: '  PERSON@example.TEST ' })).toBe('valid');
  });

  it('a wrong code: invalid', () => {
    expect(check({ code: '042918' })).toBe('invalid');
    expect(check({ code: '000000' })).toBe('invalid');
  });

  it('a code of another account: invalid', () => {
    expect(check({ userId: OTHER_USER })).toBe('invalid');
  });

  it("another account's challenge with its own right code: invalid for this account", () => {
    const other = signAccountDeleteChallenge(KEY, {
      userId: OTHER_USER,
      email: 'other@example.test',
      code: '111111',
      now: NOW,
    })!;
    expect(
      checkAccountDeleteCode(KEY, {
        challenge: other.challenge,
        code: '111111',
        userId: USER,
        email: EMAIL,
        now: at(60),
      }),
    ).toBe('invalid');
  });

  it('a code sent to an address the account no longer has: invalid', () => {
    expect(check({ email: 'new-address@example.test' })).toBe('invalid');
    expect(check({ email: null })).toBe('invalid');
  });

  it('ten minutes after it was sent: expired', () => {
    expect(check({ now: at(ACCOUNT_DELETE_CODE_TTL_S - 1) })).toBe('valid');
    expect(check({ now: at(ACCOUNT_DELETE_CODE_TTL_S) })).toBe('expired');
    expect(check({ now: at(3600) })).toBe('expired');
  });

  it('a wrong code after expiry says invalid, not expired', () => {
    expect(check({ code: '999999', now: at(3600) })).toBe('invalid');
  });

  it('another deployment’s key: invalid', () => {
    expect(check({}, 'another-key')).toBe('invalid');
    expect(check({}, '')).toBe('invalid');
  });

  it('a challenge changed in any part: invalid', () => {
    const { challenge } = signed('042917');
    const parts = challenge.split('.');
    const later = [...parts];
    later[2] = String(Number(parts[2]) + 3600);
    expect(check({ challenge: later.join('.') })).toBe('invalid');
    const otherNonce = [...parts];
    otherNonce[3] = 'A'.repeat(22);
    expect(check({ challenge: otherNonce.join('.') })).toBe('invalid');
    expect(check({ challenge: `${challenge}x` })).toBe('invalid');
  });

  it('anything that is not a challenge or a code: invalid, never a throw', () => {
    for (const challenge of [undefined, null, 42, '', 'v1', 'x'.repeat(500), {}]) {
      expect(check({ challenge })).toBe('invalid');
    }
    for (const code of [undefined, null, 42917, '', '42917', '0429170', ' 042917']) {
      expect(check({ code })).toBe('invalid');
    }
    expect(check({ now: new Date('not a date') })).toBe('invalid');
  });
});
