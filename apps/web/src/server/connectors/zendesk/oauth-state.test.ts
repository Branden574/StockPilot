import { createHmac, randomBytes } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

// Must mock server-only and env BEFORE importing the module under test.
vi.mock('server-only', () => ({}));
vi.mock('@/lib/env', () => ({
  env: { OAUTH_STATE_SECRET: 'test-secret-32-bytes-for-testing!' },
}));

import { signState, verifyState } from './oauth-state';

describe('zendesk oauth-state', () => {
  it('round-trips a valid payload', () => {
    const token = signState({ orgId: 'org-1', userId: 'user-1', platform: 'web' });
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(0);

    const result = verifyState(token);
    expect(result).toEqual({ orgId: 'org-1', userId: 'user-1', platform: 'web' });
  });

  it('round-trips with platform=mobile', () => {
    const token = signState({ orgId: 'org-2', userId: 'user-2', platform: 'mobile' });
    const result = verifyState(token);
    expect(result).toEqual({ orgId: 'org-2', userId: 'user-2', platform: 'mobile' });
  });

  it('returns null for a tampered payload', () => {
    const token = signState({ orgId: 'org-1', userId: 'user-1', platform: 'web' });
    // Swap last two chars to corrupt the signature portion
    const parts = token.split('.');
    const sig = parts[1] ?? '';
    const tampered = parts[0] + '.' + sig.slice(0, -2) + 'XX';
    expect(verifyState(tampered)).toBeNull();
  });

  it('returns null for a token with a tampered payload (valid sig format but wrong content)', () => {
    const token = signState({ orgId: 'org-1', userId: 'user-1', platform: 'web' });
    const parts = token.split('.');
    // Replace the payload with a different one (keeping the original signature)
    const fakePayload = Buffer.from(
      JSON.stringify({ orgId: 'org-evil', userId: 'user-1', platform: 'web', exp: Date.now() + 999999, nonce: 'x' }),
    ).toString('base64url');
    const tamperedToken = fakePayload + '.' + parts[1];
    expect(verifyState(tamperedToken)).toBeNull();
  });

  it('returns null for an expired token', () => {
    // signState with exp already in the past by mocking Date.now
    // First sign with a past exp by faking time 11 minutes ago
    const elevenMinutesAgo = Date.now() - 11 * 60 * 1000;
    vi.spyOn(Date, 'now').mockReturnValueOnce(elevenMinutesAgo); // for signState's exp calculation
    const token = signState({ orgId: 'org-1', userId: 'user-1', platform: 'web' });
    vi.restoreAllMocks();

    // verifyState now uses real Date.now which is ~11 min later → exp is in the past
    expect(verifyState(token)).toBeNull();
  });

  it('returns null for a token signed with a different secret', () => {
    // Manually craft a token signed with a different secret
    const differentSecret = 'totally-different-secret-value!!';
    const payload = {
      orgId: 'org-1',
      userId: 'user-1',
      platform: 'web' as const,
      exp: Date.now() + 10 * 60 * 1000,
      nonce: randomBytes(16).toString('base64url'),
    };
    const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig = createHmac('sha256', differentSecret).update(encodedPayload).digest('base64url');
    const token = encodedPayload + '.' + sig;
    expect(verifyState(token)).toBeNull();
  });

  it('returns null for a malformed token (no dot separator)', () => {
    expect(verifyState('notavalidtoken')).toBeNull();
  });

  it('returns null for a malformed token (invalid base64url payload)', () => {
    expect(verifyState('!!!.abc')).toBeNull();
  });

  it('each call to signState produces a unique token (nonce)', () => {
    const t1 = signState({ orgId: 'org-1', userId: 'user-1', platform: 'web' });
    const t2 = signState({ orgId: 'org-1', userId: 'user-1', platform: 'web' });
    expect(t1).not.toBe(t2);
  });
});
