import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Security invariant: "Sign out other devices" keeps exactly the caller's own
 * session, named by the `session_id` claim of an access token whose signature
 * has been checked, and puts only the sessions it ended on the public
 * channel, never the one it kept.
 *
 * It decoded the id from getSession()'s token unchecked. Here the session is
 * read by the REAL server client and auth-js against the fixture's ES256 keys
 * and Auth server (src/test/auth-session-fixture.ts); the database calls are
 * recorded instead of sent.
 *
 * S5 (integrator decision 2026-11-01): the broadcast was `{ keepId: <the kept
 * session> }`, a LIVE session id on a channel anyone with the anon key and the
 * user's id can read. It is now `{ sessionIds: <the sessions it ended> }`,
 * listed before the revoke. Both listeners already sign a device out when its
 * own session is named and leave the kept one alone
 * (session-revocation-listener.test.tsx, use-session-revocation.test.ts).
 */

let jar = new Map<string, string>();
vi.mock('next/headers', async () => {
  const { cookieStoreOver } = await import('@/test/auth-session-fixture');
  return { cookies: async () => cookieStoreOver(jar) };
});
vi.mock('@/lib/env', async () => {
  const f = await import('@/test/auth-session-fixture');
  return {
    env: {
      NEXT_PUBLIC_SUPABASE_URL: f.FIXTURE_SUPABASE_URL,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: f.FIXTURE_ANON_KEY,
    },
  };
});
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));
const broadcastToChannel = vi.fn(async () => undefined);
vi.mock('@/lib/realtime/broadcast', () => ({
  broadcastToChannel: (...args: unknown[]) => broadcastToChannel(...(args as [])),
}));
const OTHER_A = '55555555-5555-4555-8555-555555555555';
const OTHER_B = '66666666-6666-4666-8666-666666666666';
/** The caller's sessions as list_my_sessions answers (the kept one included). */
let listed: Array<{ id: string }> = [];
let listError: { code: string; message: string } | null = null;
const rpc = vi.fn(async (name: string, _args?: unknown) => {
  if (name === 'list_my_sessions') return { data: listError ? null : listed, error: listError };
  return { data: 1, error: null };
});
vi.mock('@/server/services/context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/services/context')>();
  const { createClient } = await import('@/lib/supabase/server');
  return {
    ...actual,
    // The cookie client of the request, with its database calls recorded.
    withContext: async () => {
      const supabase = await createClient();
      return {
        organizationId: 'org-1',
        userId: '11111111-1111-4111-8111-111111111111',
        role: 'staff',
        supabase: Object.assign(supabase, { rpc }),
        mfaRequired: false,
        mfaSatisfied: true,
        enabledModules: new Set(),
      };
    },
  };
});

import {
  FIXTURE_SESSION_ID,
  INSECURE_USER_WARNING,
  fakeAuthServer,
  makeSigningKey,
  sessionClaims,
  sessionCookies,
  signAccessToken,
  withEditedPayload,
  type FakeAuthServer,
  type SigningKey,
} from '@/test/auth-session-fixture';

import { revokeOtherSessionsAction } from './sessions';

let projectKey: SigningKey;
let server: FakeAuthServer;
let warn: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  projectKey = await makeSigningKey('project-kid-1');
});

beforeEach(() => {
  rpc.mockClear();
  broadcastToChannel.mockClear();
  listed = [];
  listError = null;
  server = fakeAuthServer(projectKey);
  vi.stubGlobal('fetch', server.fetch);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  jar = new Map();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function signIn(claims: Record<string, unknown>, token?: string) {
  jar = sessionCookies(token ?? (await signAccessToken(projectKey, claims)), claims);
}

const REFUSAL = 'Could not identify your current session — please reload and try again.';

describe('revokeOtherSessionsAction — which session it keeps', () => {
  it('keeps the verified session and signs out the rest, naming only the sessions it ended', async () => {
    await signIn(sessionClaims());
    listed = [{ id: OTHER_A }, { id: FIXTURE_SESSION_ID }, { id: OTHER_B }];
    const res = await revokeOtherSessionsAction();
    expect(res).toEqual({ ok: true, data: { revoked: 'others' } });
    // Listed BEFORE the revoke: afterwards they are gone and cannot be named.
    expect(rpc.mock.calls.map((c) => c[0])).toEqual([
      'list_my_sessions',
      'revoke_my_other_sessions',
    ]);
    expect(rpc).toHaveBeenCalledWith('revoke_my_other_sessions', {
      p_keep_session_id: FIXTURE_SESSION_ID,
    });
    expect(broadcastToChannel).toHaveBeenCalledTimes(1);
    expect(broadcastToChannel).toHaveBeenCalledWith(
      'user:11111111-1111-4111-8111-111111111111:sessions',
      'revoked',
      { sessionIds: [OTHER_A, OTHER_B] },
    );
    // The kept session is live: it never goes out on the public channel.
    expect(JSON.stringify(broadcastToChannel.mock.calls)).not.toContain(FIXTURE_SESSION_ID);
    expect(warn.mock.calls.some((c: unknown[]) => INSECURE_USER_WARNING.test(String(c[0])))).toBe(
      false,
    );
  });

  it('no other device: nothing to name, nothing broadcast', async () => {
    await signIn(sessionClaims());
    listed = [{ id: FIXTURE_SESSION_ID }];
    expect((await revokeOtherSessionsAction()).ok).toBe(true);
    expect(rpc).toHaveBeenCalledWith('revoke_my_other_sessions', {
      p_keep_session_id: FIXTURE_SESSION_ID,
    });
    expect(broadcastToChannel).not.toHaveBeenCalled();
  });

  it('a list that cannot be read still signs the other devices out; they are just not told at once', async () => {
    await signIn(sessionClaims());
    listError = { code: 'PGRST000', message: 'connection refused' };
    expect((await revokeOtherSessionsAction()).ok).toBe(true);
    expect(rpc).toHaveBeenCalledWith('revoke_my_other_sessions', {
      p_keep_session_id: FIXTURE_SESSION_ID,
    });
    expect(broadcastToChannel).not.toHaveBeenCalled();
  });

  it('a token edited to name another session is refused: nothing is revoked or broadcast', async () => {
    const real = await signAccessToken(projectKey, sessionClaims());
    const forged = sessionClaims({ sessionId: '33333333-3333-4333-8333-333333333333' });
    await signIn(forged, withEditedPayload(real, forged));
    const res = await revokeOtherSessionsAction();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toBe(REFUSAL);
    expect(rpc).not.toHaveBeenCalled();
    expect(broadcastToChannel).not.toHaveBeenCalled();
  });

  it('an expired token that cannot be refreshed is refused the same way', async () => {
    await signIn(sessionClaims({ expiresIn: -120 }));
    const res = await revokeOtherSessionsAction();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toBe(REFUSAL);
    expect(rpc).not.toHaveBeenCalled();
  });
});
