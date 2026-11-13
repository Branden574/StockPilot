import { createHmac, randomBytes } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  checkConfirmRecipient,
  CONFIRM_LINK_MAX_AGE_S,
  CONFIRM_RECIPIENT_FUTURE_SKEW_S,
  signConfirmRecipient,
} from './confirm-recipient';

/**
 * Security invariant (docket S25, INV-E5): an emailed confirmation link names
 * the account it is for, in a value only our server can write.
 *
 * Another site can send a browser to /auth/confirm with a link it holds for
 * its own account (a reset link for its own address is one form away), and
 * the person's press then signs the browser in to that account. The page now
 * shows whose account the link is for before anyone presses, and it learns
 * that from `r`: a reference our server signs when it builds the link, over
 * the link's type, its token hash, the account's user id and the time it was
 * issued. These pin the construction:
 *   - a round trip names the account and the issue time;
 *   - every changed part (type, token hash, user id, issue time, version,
 *     length, alphabet) is `invalid`, and nothing ever throws;
 *   - no signing value signs nothing and verifies nothing;
 *   - a correct tag issued more than CONFIRM_LINK_MAX_AGE_S ago, or more than
 *     five minutes ahead, is `stale`, and only a correct tag can be;
 *   - a known-answer vector, which the lab harness's port must also produce
 *     (scripts/perf-lab/lab/confirm-recipient.mjs).
 * The signing value here is a dull one under a neutral name
 * (src/test/secret-shaped-fixtures.guard.test.ts); every id is synthetic.
 */

const SIGNING_INPUT = 'test-only-signing-input';
const OTHER_INPUT = 'test-only-other-input';
const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
/** GoTrue's hashed token is a sha224 in hex: 56 characters. */
const LINK_HASH = 'ab'.repeat(28);
const OTHER_HASH = 'cd'.repeat(28);
/** 2026-10-31T12:00:00Z, in whole seconds. */
const ISSUED = 1_793_448_000;
const AT_ISSUE = new Date(ISSUED * 1000);

function sign(
  overrides: Partial<{ type: string; tokenHash: string; userId: string; issued: number }> = {},
) {
  return signConfirmRecipient(SIGNING_INPUT, {
    type: 'magiclink',
    tokenHash: LINK_HASH,
    userId: USER_A,
    issued: ISSUED,
    ...overrides,
  });
}

function check(
  r: string,
  overrides: Partial<{ type: string; tokenHash: string; now: Date; key: string }> = {},
) {
  return checkConfirmRecipient(overrides.key ?? SIGNING_INPUT, {
    type: overrides.type ?? 'magiclink',
    tokenHash: overrides.tokenHash ?? LINK_HASH,
    r,
    now: overrides.now ?? AT_ISSUE,
  });
}

/** The tag a value with these parts would carry, computed here the way the plan writes it down. */
function tagFor(
  key: string,
  type: string,
  tokenHash: string,
  userId: string,
  issued: string,
): string {
  const derived = createHmac('sha256', key.trim())
    .update('stockpilot:auth-confirm-recipient-key:v1')
    .digest();
  return createHmac('sha256', derived)
    .update(`auth-confirm:recipient:v1:${type}:${tokenHash}:${userId}:${issued}`)
    .digest('base64url');
}

describe('signConfirmRecipient and checkConfirmRecipient', () => {
  it('a round trip names the account and the issue time', () => {
    const r = sign();
    expect(r).toMatch(/^v1\.[0-9a-f-]{36}\.[0-9]+\.[A-Za-z0-9_-]{43}$/);
    expect(r!.length).toBeLessThanOrEqual(128);
    expect(check(r!)).toEqual({ status: 'valid', userId: USER_A, issued: ISSUED });
  });

  it('is built as written down: v1, the user id, the issue time and an HMAC of all of it under a key derived from the service key', () => {
    const r = sign({ type: 'recovery' })!;
    expect(r).toBe(
      `v1.${USER_A}.${ISSUED}.${tagFor(SIGNING_INPUT, 'recovery', LINK_HASH, USER_A, String(ISSUED))}`,
    );
    // The service key is trimmed first, as env.ts trims it.
    expect(
      signConfirmRecipient(`  ${SIGNING_INPUT}\n`, {
        type: 'recovery',
        tokenHash: LINK_HASH,
        userId: USER_A,
        issued: ISSUED,
      }),
    ).toBe(r);
  });

  it('every type the route sends signs, each to its own value', () => {
    const values = ['recovery', 'invite', 'magiclink', 'email_change'].map((type) => {
      const r = sign({ type });
      expect(check(r!, { type }), type).toMatchObject({ status: 'valid' });
      return r;
    });
    expect(new Set(values).size).toBe(4);
  });

  it('a known-answer vector pins the construction (the lab port must give the same value)', async () => {
    // Computed outside this code, with openssl: HMAC-SHA256 under the derived
    // key, base64url without padding.
    const expected =
      'v1.11111111-1111-4111-8111-111111111111.1793448000.afzqneZ9pTizZ9SLPhKCaodtchofu_BJU8dGXDfwfKI';
    expect(sign()).toBe(expected);
    // The lab's trace-nav signs with a plain-JavaScript copy of this signer.
    const port = (await import(
      pathToFileURL(path.resolve(__dirname, '../../../scripts/perf-lab/lab/confirm-recipient.mjs'))
        .href
    )) as {
      signConfirmRecipient: (key: string, claim: Record<string, unknown>) => string | null;
    };
    expect(
      port.signConfirmRecipient(SIGNING_INPUT, {
        type: 'magiclink',
        tokenHash: LINK_HASH,
        userId: USER_A,
        issued: ISSUED,
      }),
    ).toBe(expected);
  });

  it.each([
    ['a recovery link relabelled as a sign-in link', { type: 'recovery' }],
    ['an invite relabelled as a sign-in link', { type: 'invite' }],
    ['another token', { tokenHash: OTHER_HASH }],
  ])('a value signed for %s is invalid', (_label, signed) => {
    expect(check(sign(signed)!)).toEqual({ status: 'invalid' });
  });

  it('another user id, or another issue time, written into a signed value is invalid', () => {
    const r = sign()!;
    expect(check(r.replace(USER_A, USER_B))).toEqual({ status: 'invalid' });
    expect(check(r.replace(String(ISSUED), String(ISSUED + 1)))).toEqual({ status: 'invalid' });
    expect(check(r.replace(String(ISSUED), String(ISSUED - 3600)))).toEqual({ status: 'invalid' });
  });

  it('a value cut short, extended, re-versioned or with a changed tag is invalid', () => {
    const r = sign()!;
    const tag = r.split('.')[3]!;
    const flipped = tag.slice(0, -1) + (tag.endsWith('A') ? 'B' : 'A');
    for (const variant of [
      r.slice(0, -1),
      `${r}A`,
      `${r}.`,
      `.${r}`,
      r.replace(/^v1\./, 'v2.'),
      r.replace(/^v1\./, 'V1.'),
      r.replace(/^v1\./, ''),
      r.replace(tag, flipped),
      r.replace(tag, tag.toUpperCase()),
      // An id in capitals (this one has no letters, so spell another in them).
      r.replace(USER_A, 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'),
      `${r.split('.').slice(0, 3).join('.')}.${'A'.repeat(43)}`,
    ]) {
      expect(check(variant), variant).toEqual({ status: 'invalid' });
    }
  });

  it("a second spelling of a correct tag is invalid: only the signer's own spelling passes", () => {
    // 43 base64url characters carry 258 bits for the tag's 256, so the last
    // character has two spare bits: four characters decode to the same 32
    // bytes. Change only those two bits.
    const r = sign()!;
    const tag = r.split('.')[3]!;
    const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const last = ALPHABET.indexOf(tag.at(-1)!);
    const twin = r.slice(0, -1) + ALPHABET[(last & ~3) | ((last + 1) & 3)];
    expect(twin).not.toBe(r);
    expect(Buffer.from(twin.split('.')[3]!, 'base64url')).toEqual(Buffer.from(tag, 'base64url'));
    expect(check(r)).toEqual({ status: 'valid', userId: USER_A, issued: ISSUED });
    expect(check(twin)).toEqual({ status: 'invalid' });
  });

  it('a user id that is not a UUID, an oversized value and characters outside base64url are invalid', () => {
    const tag = tagFor(SIGNING_INPUT, 'magiclink', LINK_HASH, 'user-1', String(ISSUED));
    expect(check(`v1.user-1.${ISSUED}.${tag}`)).toEqual({ status: 'invalid' });
    expect(check(`${sign()!}${'A'.repeat(200)}`)).toEqual({ status: 'invalid' });
    const r = sign()!;
    expect(check(r.replace(/.$/, '+'))).toEqual({ status: 'invalid' });
    expect(check(r.replace(/.$/, '='))).toEqual({ status: 'invalid' });
    expect(check(`${r}=`)).toEqual({ status: 'invalid' });
  });

  it('a type the route does not send, or a token hash outside its shape, is invalid (and none can be signed)', () => {
    for (const type of ['signup', 'email', 'email_change_new', 'constructor', '']) {
      const forged = `v1.${USER_A}.${ISSUED}.${tagFor(SIGNING_INPUT, type, LINK_HASH, USER_A, String(ISSUED))}`;
      expect(check(forged, { type }), type).toEqual({ status: 'invalid' });
      expect(sign({ type }), type).toBeNull();
    }
    // A colon would let two different (type, token hash) pairs share one signed text.
    for (const tokenHash of [
      `${LINK_HASH}:magiclink`,
      'short',
      'x'.repeat(129),
      `${LINK_HASH} `,
      '',
    ]) {
      const forged = `v1.${USER_A}.${ISSUED}.${tagFor(SIGNING_INPUT, 'magiclink', tokenHash, USER_A, String(ISSUED))}`;
      expect(check(forged, { tokenHash }), tokenHash).toEqual({ status: 'invalid' });
      expect(sign({ tokenHash }), tokenHash).toBeNull();
    }
  });

  it('signs nothing for a user id that is not a UUID, and keeps the id lowercase', () => {
    for (const userId of ['user-1', '', `${USER_A}x`, ' 11111111-1111-4111-8111-111111111111']) {
      expect(sign({ userId }), userId).toBeNull();
    }
    expect(sign({ userId: USER_A.toUpperCase() })).toBe(sign());
  });

  it('signs nothing for an issue time that is not a whole positive number of seconds', () => {
    for (const issued of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 1e13]) {
      expect(sign({ issued }), String(issued)).toBeNull();
    }
  });

  it('with no signing value nothing is signed and nothing verifies, a value signed under the empty value included', () => {
    expect(
      signConfirmRecipient('', {
        type: 'magiclink',
        tokenHash: LINK_HASH,
        userId: USER_A,
        issued: ISSUED,
      }),
    ).toBeNull();
    expect(
      signConfirmRecipient('   ', {
        type: 'magiclink',
        tokenHash: LINK_HASH,
        userId: USER_A,
        issued: ISSUED,
      }),
    ).toBeNull();
    const underEmpty = `v1.${USER_A}.${ISSUED}.${tagFor('', 'magiclink', LINK_HASH, USER_A, String(ISSUED))}`;
    expect(check(underEmpty, { key: '' })).toEqual({ status: 'invalid' });
    expect(check(underEmpty, { key: '  ' })).toEqual({ status: 'invalid' });
    expect(check(underEmpty)).toEqual({ status: 'invalid' });
    expect(check(sign()!, { key: '' })).toEqual({ status: 'invalid' });
  });

  it('a value signed with another service key is invalid', () => {
    const r = signConfirmRecipient(OTHER_INPUT, {
      type: 'magiclink',
      tokenHash: LINK_HASH,
      userId: USER_A,
      issued: ISSUED,
    })!;
    expect(check(r)).toEqual({ status: 'invalid' });
  });

  it('the signing key is derived: the service key used as the HMAC key directly does not verify', () => {
    const direct = createHmac('sha256', SIGNING_INPUT)
      .update(`auth-confirm:recipient:v1:magiclink:${LINK_HASH}:${USER_A}:${ISSUED}`)
      .digest('base64url');
    expect(check(`v1.${USER_A}.${ISSUED}.${direct}`)).toEqual({ status: 'invalid' });
  });
});

describe('the issue time bounds a value (the link expires within the hour anyway)', () => {
  const r = () => sign()!;
  const at = (seconds: number) => new Date((ISSUED + seconds) * 1000);

  it('is valid from five minutes before its issue time to CONFIRM_LINK_MAX_AGE_S after it', () => {
    expect(CONFIRM_LINK_MAX_AGE_S).toBe(3900);
    expect(CONFIRM_RECIPIENT_FUTURE_SKEW_S).toBe(300);
    for (const s of [-300, -1, 0, 1, 3600, 3899, 3900]) {
      expect(check(r(), { now: at(s) }), String(s)).toMatchObject({ status: 'valid' });
    }
  });

  it('is stale past CONFIRM_LINK_MAX_AGE_S, or more than five minutes ahead of the clock', () => {
    for (const s of [3901, 7200, 86_400 * 365, -301, -86_400]) {
      expect(check(r(), { now: at(s) }), String(s)).toEqual({ status: 'stale' });
    }
  });

  it('only a correct tag is ever called stale: a changed one past its time is invalid', () => {
    const value = r();
    const tag = value.split('.')[3]!;
    const changed = value.replace(tag, tag.slice(0, -1) + (tag.endsWith('A') ? 'B' : 'A'));
    expect(check(changed, { now: at(7200) })).toEqual({ status: 'invalid' });
    expect(check(changed, { now: at(-86_400) })).toEqual({ status: 'invalid' });
  });

  it('an unusable clock never makes a value valid', () => {
    expect(check(r(), { now: new Date(Number.NaN) })).toEqual({ status: 'invalid' });
  });
});

describe('never throws', () => {
  it('on a few hundred random and hostile strings', () => {
    const inputs: unknown[] = [
      null,
      undefined,
      42,
      {},
      [],
      '',
      '.',
      '....',
      'v1....',
      'v1.' + '.'.repeat(130),
      '\u0000'.repeat(10),
      '%00',
      'v1.__proto__.1.constructor',
    ];
    for (let i = 0; i < 300; i++) {
      const bytes = randomBytes(1 + (i % 140));
      inputs.push(i % 2 ? bytes.toString('base64url') : bytes.toString('latin1'));
      inputs.push(`v1.${USER_A}.${i}.${bytes.toString('base64url').slice(0, 43)}`);
    }
    for (const value of inputs) {
      for (const key of [SIGNING_INPUT, '']) {
        const verdict = checkConfirmRecipient(key, {
          type: 'magiclink',
          tokenHash: LINK_HASH,
          r: value as string,
          now: AT_ISSUE,
        });
        expect(['invalid', 'stale']).toContain(verdict.status);
      }
      expect(() =>
        checkConfirmRecipient(SIGNING_INPUT, {
          type: value as string,
          tokenHash: value as string,
          r: value as string,
          now: value as Date,
        }),
      ).not.toThrow();
      expect(() =>
        signConfirmRecipient(value as string, {
          type: value as string,
          tokenHash: value as string,
          userId: value as string,
          issued: value as number,
        }),
      ).not.toThrow();
    }
  });
});
