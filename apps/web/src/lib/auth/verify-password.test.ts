import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Guard for the GHOST SESSION bug (SP-058).
 *
 * verifyPasswordSideChannel proves a password by running GoTrue's password
 * grant on an ISOLATED client. `persistSession: false` only suppresses
 * CLIENT-side storage — GoTrue still mints a real session server-side
 * (`auth.sessions` row + live refresh token) for every successful check.
 * Nothing ever revoked it, so each email-change request, ownership transfer,
 * MFA enroll-verify and recovery-code consume left an orphan session behind.
 * `list_my_sessions` (mig 0213/0214) returns EVERY auth.sessions row for
 * auth.uid() with no filter, so those ghosts show up in Settings → Security
 * alongside the user's real devices and mislead "sign out other devices".
 *
 * These tests pin the cleanup: on success the helper MUST revoke the session
 * it just minted, and it must do so with scope 'local' (which POSTs
 * /logout?scope=local with the ghost's own JWT — it revokes ONLY that
 * session, never the caller's SSR cookie session or the user's real devices).
 */

const refs = vi.hoisted(() => ({
  signInWithPassword: vi.fn(),
  signOut: vi.fn(),
  createClient: vi.fn(),
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: (...args: unknown[]) => {
    refs.createClient(...args);
    return {
      auth: {
        signInWithPassword: (...a: unknown[]) => refs.signInWithPassword(...a),
        signOut: (...a: unknown[]) => refs.signOut(...a),
      },
    };
  },
}));

vi.mock('@/lib/env', () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key',
  },
}));

import { verifyPasswordSideChannel } from './verify-password';

describe('verifyPasswordSideChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    refs.signInWithPassword.mockResolvedValue({
      data: { session: { access_token: 'jwt', user: { id: 'u1' } } },
      error: null,
    });
    refs.signOut.mockResolvedValue({ error: null });
  });

  it('builds an isolated, non-persisting client', async () => {
    await verifyPasswordSideChannel('u@e.com', 'pw');
    expect(refs.createClient).toHaveBeenCalledWith(
      'https://example.supabase.co',
      'anon-key',
      expect.objectContaining({
        auth: expect.objectContaining({ persistSession: false }),
      }),
    );
  });

  it('revokes the session the password grant just minted (no ghost row)', async () => {
    const res = await verifyPasswordSideChannel('u@e.com', 'pw');

    expect(res).toEqual({ ok: true });
    // scope 'local' — revoke ONLY the ghost. 'global'/'others' would evict the
    // user's real devices mid-flow, which is exactly the harm we are fixing.
    expect(refs.signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(refs.signOut).toHaveBeenCalledTimes(1);
  });

  it('does not attempt a sign-out when the password was wrong', async () => {
    refs.signInWithPassword.mockResolvedValue({
      data: { session: null },
      error: { message: 'Invalid login credentials' },
    });

    const res = await verifyPasswordSideChannel('u@e.com', 'bad');

    expect(res).toEqual({
      ok: false,
      reason: 'invalid_password',
      message: 'Password is incorrect.',
    });
    expect(refs.signOut).not.toHaveBeenCalled();
  });

  it('still reports ok when the cleanup sign-out fails (best-effort)', async () => {
    refs.signOut.mockRejectedValue(new Error('gotrue 503'));

    // A failed cleanup must never turn a VERIFIED password into a failure —
    // a leaked ghost is the pre-fix status quo, a false "password incorrect"
    // would block the user out of email change / MFA enroll entirely.
    await expect(verifyPasswordSideChannel('u@e.com', 'pw')).resolves.toEqual({ ok: true });
  });

  it('reports internal_error (not invalid_password) when the client throws', async () => {
    refs.signInWithPassword.mockRejectedValue(new Error('network down'));

    const res = await verifyPasswordSideChannel('u@e.com', 'pw');

    expect(res).toEqual({
      ok: false,
      reason: 'internal_error',
      message: 'network down',
    });
  });
});
