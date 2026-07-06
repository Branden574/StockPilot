import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The unsubscribe token is the ONLY thing standing between the public
 * /unsubscribe endpoint and "anyone can unsubscribe any address". This
 * suite pins the signer/verifier contract:
 *   - mint → verify roundtrip, case/whitespace-insensitive on the email,
 *   - any tampering (token or email) fails verification,
 *   - no secret configured → mint yields nothing and verify FAILS CLOSED.
 */

// vi.hoisted: the factory runs during hoisted imports, before top-level consts.
const envState = vi.hoisted(() => ({ UNSUBSCRIBE_SECRET: 'test-unsubscribe-secret-0123456789' }));
vi.mock('@/lib/env', () => ({ env: envState }));

import {
  buildPublicUnsubscribeUrl,
  mintUnsubscribeToken,
  verifyUnsubscribeToken,
} from './unsubscribe';

const EMAIL = 'requester@school.edu';

describe('unsubscribe token HMAC', () => {
  beforeEach(() => {
    envState.UNSUBSCRIBE_SECRET = 'test-unsubscribe-secret-0123456789';
  });

  it('verifies a token it minted', () => {
    const token = mintUnsubscribeToken(EMAIL);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyUnsubscribeToken(EMAIL, token!)).toBe(true);
  });

  it('normalizes case + whitespace, so the emailed link survives client mangling', () => {
    const token = mintUnsubscribeToken('  Requester@School.EDU ');
    expect(verifyUnsubscribeToken(EMAIL, token!)).toBe(true);
    expect(verifyUnsubscribeToken(' REQUESTER@school.edu', mintUnsubscribeToken(EMAIL)!)).toBe(true);
  });

  it('rejects a tampered token', () => {
    const token = mintUnsubscribeToken(EMAIL)!;
    const flipped = token.slice(0, -1) + (token.endsWith('0') ? '1' : '0');
    expect(verifyUnsubscribeToken(EMAIL, flipped)).toBe(false);
  });

  it("rejects one address's token presented for another (no cross-victim unsubscribes)", () => {
    const token = mintUnsubscribeToken(EMAIL)!;
    expect(verifyUnsubscribeToken('victim@school.edu', token)).toBe(false);
  });

  it('rejects malformed tokens without throwing', () => {
    expect(verifyUnsubscribeToken(EMAIL, '')).toBe(false);
    expect(verifyUnsubscribeToken(EMAIL, 'not-hex-at-all')).toBe(false);
    expect(verifyUnsubscribeToken(EMAIL, 'ab'.repeat(16))).toBe(false); // right charset, wrong length
  });

  it('fails closed when UNSUBSCRIBE_SECRET is unset', () => {
    const minted = mintUnsubscribeToken(EMAIL)!; // minted while keyed
    envState.UNSUBSCRIBE_SECRET = '';

    expect(mintUnsubscribeToken(EMAIL)).toBeNull();
    expect(buildPublicUnsubscribeUrl('https://app.test', EMAIL)).toBeNull();
    // Even a previously-valid token verifies FALSE against an unkeyed HMAC.
    expect(verifyUnsubscribeToken(EMAIL, minted)).toBe(false);
  });

  it('builds a signed URL with the normalized address', () => {
    const url = buildPublicUnsubscribeUrl('https://app.test', ' Requester@School.EDU ');
    expect(url).toBe(
      `https://app.test/unsubscribe?e=${encodeURIComponent(EMAIL)}&t=${mintUnsubscribeToken(EMAIL)}`,
    );
  });
});
