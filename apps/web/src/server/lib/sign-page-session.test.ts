import { createChunks, stringToBase64URL } from '@supabase/ssr';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub, servedLikePostgrest } from '@/test/supabase-mock';

/**
 * R1 (adopted for 0389): the public sign page verifies who is signed in
 * LOCALLY and never refreshes the session. It reads the access token out of
 * the auth cookie the way @supabase/ssr's cookie storage writes it (chunked,
 * base64url-encoded) and verifies only that token with getClaims(jwt), which
 * refuses an expired one. Loading the session instead (getClaims() with no
 * argument, getUser()) would refresh an expired token in a server component
 * that cannot write the rotated cookie.
 */

const cookieJar = new Map<string, string>();
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (name: string) => (cookieJar.has(name) ? { name, value: cookieJar.get(name)! } : undefined) }),
}));
vi.mock('@/lib/env', () => ({
  env: { NEXT_PUBLIC_SUPABASE_URL: 'https://xyzproject.supabase.co', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon' },
}));

const getClaims = vi.fn();
const getSession = vi.fn();
const getUser = vi.fn();
const createClient = vi.fn((_url: string, _key: string, _opts: unknown) => ({ auth: { getClaims, getSession, getUser } }));
vi.mock('@supabase/supabase-js', () => ({
  createClient: (url: string, key: string, opts: unknown) => createClient(url, key, opts),
}));

import {
  accessTokenFromAuthCookie,
  authCookieKey,
  isActiveOrgMember,
  verifiedSessionUserIdWithoutRefresh,
} from './sign-page-session';

const KEY = 'sb-xyzproject-auth-token';
const SESSION = JSON.stringify({ access_token: 'header.payload.sig', refresh_token: 'r', expires_at: 1 });

function storeSession(value: string, opts: { base64?: boolean; chunkSize?: number } = {}) {
  cookieJar.clear();
  const encoded = opts.base64 === false ? value : `base64-${stringToBase64URL(value)}`;
  for (const c of createChunks(KEY, encoded, opts.chunkSize)) cookieJar.set(c.name, c.value);
}

beforeEach(() => {
  vi.clearAllMocks();
  cookieJar.clear();
});

describe('the auth cookie', () => {
  it('is named as supabase-js names its storage key (the project ref)', () => {
    expect(authCookieKey('https://xyzproject.supabase.co')).toBe(KEY);
    expect(authCookieKey('http://127.0.0.1:54321')).toBe('sb-127-auth-token');
  });

  it('reads the access token from a base64url cookie, a chunked one, and a plain JSON one', async () => {
    const get = (n: string) => cookieJar.get(n);
    storeSession(SESSION);
    expect(await accessTokenFromAuthCookie(get, KEY)).toBe('header.payload.sig');
    storeSession(SESSION, { chunkSize: 20 });
    expect(cookieJar.size).toBeGreaterThan(1);
    expect(await accessTokenFromAuthCookie(get, KEY)).toBe('header.payload.sig');
    storeSession(SESSION, { base64: false });
    expect(await accessTokenFromAuthCookie(get, KEY)).toBe('header.payload.sig');
  });

  it('no cookie, a garbled one, or one with no access token is nobody', async () => {
    const get = (n: string) => cookieJar.get(n);
    expect(await accessTokenFromAuthCookie(get, KEY)).toBeNull();
    cookieJar.set(KEY, 'base64-%%%');
    expect(await accessTokenFromAuthCookie(get, KEY)).toBeNull();
    storeSession(JSON.stringify({ refresh_token: 'r' }));
    expect(await accessTokenFromAuthCookie(get, KEY)).toBeNull();
  });
});

describe('verifiedSessionUserIdWithoutRefresh', () => {
  it('verifies ONLY the cookie token (getClaims(jwt)), never loading or refreshing the session', async () => {
    storeSession(SESSION);
    getClaims.mockResolvedValue({ data: { claims: { sub: 'user-1', role: 'authenticated' } }, error: null });
    expect(await verifiedSessionUserIdWithoutRefresh()).toBe('user-1');
    expect(getClaims).toHaveBeenCalledWith('header.payload.sig');
    expect(getSession).not.toHaveBeenCalled();
    // A client that cannot persist or refresh anything.
    expect(createClient.mock.calls[0]![2]).toMatchObject({
      auth: { persistSession: false, autoRefreshToken: false },
    });
  });

  it('an expired (or forged) token is no session', async () => {
    storeSession(SESSION);
    getClaims.mockResolvedValue({ data: null, error: new Error('JWT has expired') });
    expect(await verifiedSessionUserIdWithoutRefresh()).toBeNull();
  });

  it('a token that is not a signed-in user (the anon key, no subject) is no session; so is a throw', async () => {
    storeSession(SESSION);
    getClaims.mockResolvedValue({ data: { claims: { role: 'anon' } }, error: null });
    expect(await verifiedSessionUserIdWithoutRefresh()).toBeNull();
    getClaims.mockRejectedValue(new Error('bad jwk'));
    expect(await verifiedSessionUserIdWithoutRefresh()).toBeNull();
  });

  it('no cookie: no session, and no client is made', async () => {
    expect(await verifiedSessionUserIdWithoutRefresh()).toBeNull();
    expect(createClient).not.toHaveBeenCalled();
  });
});

describe('isActiveOrgMember (is_org_member, read with the admin client)', () => {
  const stub = (members: Record<string, unknown>[], profiles: Record<string, unknown>[]) =>
    makeSupabaseStub({
      'organization_members.select': (call) => {
        // .not('accepted_at', 'is', null) is applied here (servedLikePostgrest does not evaluate .not).
        const eqs = call.methods
          .map((m, i) => [m, call.args[i]] as const)
          .filter(([m]) => m === 'eq')
          .map(([, a]) => a as [string, unknown]);
        const hit = members.filter(
          (r) => eqs.every(([c, v]) => r[c] === v) && r.accepted_at != null,
        );
        return { data: hit, error: null };
      },
      'user_profiles.select': servedLikePostgrest(profiles),
    }).client;

  it('an accepted member whose account is not disabled', async () => {
    const admin = stub([{ organization_id: 'o', user_id: 'u', accepted_at: 'x' }], [{ id: 'u', disabled_at: null }]);
    expect(await isActiveOrgMember(admin, 'o', 'u')).toBe(true);
  });

  it('not a member, not yet accepted, another organization, or a disabled account: no', async () => {
    expect(await isActiveOrgMember(stub([], [{ id: 'u', disabled_at: null }]), 'o', 'u')).toBe(false);
    expect(
      await isActiveOrgMember(stub([{ organization_id: 'o', user_id: 'u', accepted_at: null }], [{ id: 'u', disabled_at: null }]), 'o', 'u'),
    ).toBe(false);
    expect(
      await isActiveOrgMember(stub([{ organization_id: 'p', user_id: 'u', accepted_at: 'x' }], [{ id: 'u', disabled_at: null }]), 'o', 'u'),
    ).toBe(false);
    expect(
      await isActiveOrgMember(stub([{ organization_id: 'o', user_id: 'u', accepted_at: 'x' }], [{ id: 'u', disabled_at: 'y' }]), 'o', 'u'),
    ).toBe(false);
  });
});
