import { describe, expect, it, vi } from 'vitest';

import { sessionAccountNow } from '@/lib/auth/session-account';
import { verifiedSessionAuth, type StubbedCookieSession } from '@/test/verified-session-stub';

/**
 * sessionAccountNow reads the cookie session (the real readVerifiedSessionClaims
 * over a faked client) against the account a request checked, and answers one
 * of three outcomes.
 */
function clientFor(session: StubbedCookieSession) {
  return { auth: verifiedSessionAuth(() => session) } as unknown as Parameters<
    typeof sessionAccountNow
  >[0];
}

describe('sessionAccountNow', () => {
  it('the same account: same, with its claims', async () => {
    const now = await sessionAccountNow(clientFor({ sub: 'user-1', aal: 'aal2' }), 'user-1');

    expect(now.kind).toBe('same');
    expect(now.kind === 'same' ? now.claims : null).toMatchObject({ userId: 'user-1', aal: 'aal2' });
  });

  it('another account: other, with one fixed log line naming no account', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const now = await sessionAccountNow(clientFor({ sub: 'user-2', aal: 'aal1' }), 'user-1');

    expect(now).toEqual({ kind: 'other' });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('user-1');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('user-2');
    warn.mockRestore();
  });

  it('no session that can be verified: unverified', async () => {
    const now = await sessionAccountNow(
      clientFor({ sub: 'user-1', aal: 'aal1', read: 'error' }),
      'user-1',
    );

    expect(now).toEqual({ kind: 'unverified' });
  });

  it('a session read that throws: unverified, and nothing is thrown', async () => {
    const now = await sessionAccountNow(
      clientFor({ sub: 'user-1', aal: 'aal1', read: 'throw' }),
      'user-1',
    );

    expect(now).toEqual({ kind: 'unverified' });
  });
});
