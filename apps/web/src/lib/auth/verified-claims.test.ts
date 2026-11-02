import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Security invariant: on the server, the session's assurance level, session
 * id and MFA timestamps come from an access token whose signature has been
 * checked, never from the auth cookie as stored.
 *
 * Everything below the cookie store and the network is REAL: the app's own
 * createClient() (lib/supabase/server), @supabase/ssr's server client and
 * @supabase/auth-js. The session is an ES256 token made at run time and the
 * Auth server is the fixture in src/test/auth-session-fixture.ts, which counts
 * every request it gets.
 *
 * What it pins:
 *  - the root cause of the warning in production's logs (one to four times
 *    per dashboard request of a member with an authenticator):
 *    auth.mfa.getAuthenticatorAssuranceLevel() on a server client reads the
 *    stored user object and auth-js logs "could be insecure" on every call;
 *    getClaims() does not;
 *  - a valid token's claims, verified locally: no request to the Auth server,
 *    and the key set fetched at most once;
 *  - a forged token (payload edited, or signed with another key under the
 *    project's key id or under one the key set does not list), an unsigned
 *    one and an expired one: null;
 *  - when the key set cannot be fetched, the Auth server decides instead;
 *  - how many requests each case costs: a verdict on the token is never
 *    asked for twice, and the session is loaded (and refreshed) once.
 */

let jar = new Map<string, string>();
/** cookies() throws, as it does outside a request scope. */
let cookiesUnavailable = false;
vi.mock('next/headers', async () => {
  const { cookieStoreOver } = await import('@/test/auth-session-fixture');
  return {
    cookies: async () => {
      if (cookiesUnavailable) throw new Error('cookies() was called outside a request scope');
      return cookieStoreOver(jar);
    },
  };
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

import { NextRequest } from 'next/server';

import { SESSION_HEADER_USER_ID, updateSession } from '@/lib/supabase/middleware';
import { createClient } from '@/lib/supabase/server';
import {
  FIXTURE_SESSION_ID,
  FIXTURE_USER_ID,
  INSECURE_USER_WARNING,
  fakeAuthServer,
  makeLegacySecret,
  makeSigningKey,
  refreshGrant,
  sessionClaims,
  sessionCookies,
  signAccessToken,
  signLegacyToken,
  unsignedToken,
  withEditedPayload,
  type FakeAuthServer,
  type SigningKey,
} from '@/test/auth-session-fixture';

import { verifiedSessionAuth, type StubbedCookieSession } from '@/test/verified-session-stub';

import {
  getVerifiedSessionClaimsForRequest,
  readVerifiedSessionClaims,
  readVerifiedSessionClaimsOf,
  readVerifiedSessionTokenOf,
} from './verified-claims';

let projectKey: SigningKey;
/**
 * A second project key (a rotation): the Auth server signs with it, but no
 * client has it cached, because the key set served before the rotation
 * listed only `projectKey`.
 */
let rotatedKey: SigningKey;
/** The attacker's own key, presented under the project's key id. */
let attackerKey: SigningKey;
/** The project's legacy HS256 secret, which GoTrue still accepts. */
let legacySecret: CryptoKey;
let server: FakeAuthServer;
let warn: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  projectKey = await makeSigningKey('project-kid-1');
  rotatedKey = await makeSigningKey('project-kid-2');
  attackerKey = await makeSigningKey('attacker-kid');
  legacySecret = await makeLegacySecret();
});

/** Serve the Auth server for `keys` (the project's current key set). */
function serve(keys: SigningKey[]) {
  server = fakeAuthServer(keys);
  vi.stubGlobal('fetch', server.fetch);
}

beforeEach(() => {
  serve([projectKey]);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  jar = new Map();
  cookiesUnavailable = false;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function signIn(claims: Record<string, unknown>, token?: string) {
  jar = sessionCookies(token ?? (await signAccessToken(projectKey, claims)), claims);
}

const insecureWarnings = () =>
  warn.mock.calls.filter((c: unknown[]) => INSECURE_USER_WARNING.test(String(c[0]))).length;

describe('the production warning: which call logs it', () => {
  it('getAuthenticatorAssuranceLevel() on a server client reads the stored user and warns, every call', async () => {
    await signIn(sessionClaims({ aal: 'aal2' }));
    const client = await createClient();
    const first = await client.auth.mfa.getAuthenticatorAssuranceLevel();
    expect(first.data?.currentLevel).toBe('aal2');
    expect(insecureWarnings()).toBe(1);
    await client.auth.mfa.getAuthenticatorAssuranceLevel();
    expect(insecureWarnings()).toBe(2);
    // It never asked anyone: the level is the cookie's own say-so.
    expect(server.calls).toEqual({});
  });

  it('...and the same unchecked decode accepts a token whose payload was edited to AAL2', async () => {
    const real = await signAccessToken(projectKey, sessionClaims({ aal: 'aal1' }));
    const forgedClaims = sessionClaims({ aal: 'aal2' });
    await signIn(forgedClaims, withEditedPayload(real, forgedClaims));
    const { data } = await (await createClient()).auth.mfa.getAuthenticatorAssuranceLevel();
    expect(data?.currentLevel).toBe('aal2');
  });

  it('readVerifiedSessionClaims() logs nothing', async () => {
    await signIn(sessionClaims({ aal: 'aal2' }));
    await readVerifiedSessionClaims(await createClient());
    await readVerifiedSessionClaims(await createClient());
    expect(insecureWarnings()).toBe(0);
  });

  // Vercel files most of the production warnings under the source
  // "serverless-middleware". That label is the whole invocation, not the
  // proxy's own lines: Server Action logs carry it too. The proxy itself
  // verifies the same cookie (getClaims, then getUser) and logs nothing.
  it('the proxy (updateSession) verifies the same session and logs nothing', async () => {
    await signIn(sessionClaims({ aal: 'aal2' }));
    const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
    const res = await updateSession(
      new NextRequest('https://app.example.com/dashboard/purchase-orders', { headers: { cookie } }),
    );
    expect(res.headers.get(`x-middleware-request-${SESSION_HEADER_USER_ID}`)).toBe(FIXTURE_USER_ID);
    expect(insecureWarnings()).toBe(0);
    expect(server.calls['/user']).toBeUndefined();
  });
});

describe('readVerifiedSessionClaims', () => {
  it('a valid token: its claims, verified locally with no request to the Auth server', async () => {
    await signIn(sessionClaims({ aal: 'aal2', totpAgeSeconds: 30 }));
    const claims = await readVerifiedSessionClaims(await createClient());
    expect(claims).toMatchObject({
      userId: FIXTURE_USER_ID,
      sessionId: FIXTURE_SESSION_ID,
      aal: 'aal2',
    });
    expect(Array.isArray(claims?.amr)).toBe(true);
    expect(server.calls['/user']).toBeUndefined();
    expect(server.calls['/.well-known/jwks.json'] ?? 0).toBeLessThanOrEqual(1);

    // The key set is cached for every client in the instance: the next
    // request's read makes no request at all.
    server.calls = {};
    expect((await readVerifiedSessionClaims(await createClient()))?.aal).toBe('aal2');
    expect(server.calls).toEqual({});
  });

  it('an AAL1 session reads as aal1', async () => {
    await signIn(sessionClaims({ aal: 'aal1' }));
    expect((await readVerifiedSessionClaims(await createClient()))?.aal).toBe('aal1');
  });

  it('a payload edited to AAL2 under the original signature: null, refused locally', async () => {
    const real = await signAccessToken(projectKey, sessionClaims({ aal: 'aal1' }));
    const forgedClaims = sessionClaims({ aal: 'aal2', sessionId: 'forged-session' });
    await signIn(forgedClaims, withEditedPayload(real, forgedClaims));
    expect(await readVerifiedSessionClaims(await createClient())).toBeNull();
    // The signature check is a verdict: the Auth server is not asked again.
    expect(server.calls['/user']).toBeUndefined();
  });

  it("a token signed with the attacker's own key under the project's key id: null, refused locally", async () => {
    const forgedClaims = sessionClaims({ aal: 'aal2' });
    await signIn(forgedClaims, await signAccessToken(attackerKey, forgedClaims, projectKey.kid));
    expect(await readVerifiedSessionClaims(await createClient())).toBeNull();
    expect(server.calls['/user']).toBeUndefined();
  });

  it('an unsigned token (alg none): null, after one Auth request', async () => {
    const forgedClaims = sessionClaims({ aal: 'aal2' });
    await signIn(forgedClaims, unsignedToken(forgedClaims));
    expect(await readVerifiedSessionClaims(await createClient())).toBeNull();
    // No key id, so getClaims() cannot check it locally and asks the Auth
    // server, which refuses it. That refusal is final: it is not asked again.
    expect(server.calls['/user']).toBe(1);
  });

  it('a token under a key id the key set does not list: null, after one Auth request', async () => {
    const forgedClaims = sessionClaims({ aal: 'aal2' });
    await signIn(forgedClaims, await signAccessToken(attackerKey, forgedClaims));
    expect(await readVerifiedSessionClaims(await createClient())).toBeNull();
    // getClaims() fetches the key set again for the unknown key id, finds no
    // such key, and asks the Auth server, which refuses the token.
    expect(server.calls['/user']).toBe(1);
  });

  it('a legacy HS256 token GoTrue accepts: its claims, after one Auth request', async () => {
    // A symmetric algorithm and no key id: getClaims() cannot check it
    // locally, so it asks the Auth server, which checks it with the secret.
    server.legacySecret = legacySecret;
    const claims = sessionClaims({ aal: 'aal2' });
    await signIn(claims, await signLegacyToken(legacySecret, claims));
    expect(await readVerifiedSessionClaims(await createClient())).toMatchObject({
      userId: FIXTURE_USER_ID,
      sessionId: FIXTURE_SESSION_ID,
      aal: 'aal2',
    });
    expect(server.calls['/user']).toBe(1);
    expect(server.calls['/.well-known/jwks.json']).toBeUndefined();
  });

  it('a legacy HS256 token of a revoked session: null, after one Auth request', async () => {
    // GoTrue checks the signature, then finds no such session (signed out, or
    // revoked from another device) and answers session_not_found. auth-js
    // reports that as AuthSessionMissingError (status 400), not as an
    // AuthApiError(403). It is a verdict on this token all the same, so the
    // Auth server is not asked a second time.
    server.legacySecret = legacySecret;
    server.revokedSessions.add(FIXTURE_SESSION_ID);
    const claims = sessionClaims({ aal: 'aal2' });
    await signIn(claims, await signLegacyToken(legacySecret, claims));
    expect(await readVerifiedSessionClaims(await createClient())).toBeNull();
    expect(server.calls['/user']).toBe(1);
  });

  it('an expired token whose refresh fails: null, after one refresh', async () => {
    await signIn(sessionClaims({ aal: 'aal2', expiresIn: -120 }));
    expect(await readVerifiedSessionClaims(await createClient())).toBeNull();
    // The session was offered for refresh once and the Auth server said no.
    // With no session there is no token to ask about.
    expect(server.calls['/token']).toBe(1);
    expect(server.calls['/user']).toBeUndefined();
  });

  it('a session that cannot be loaded is no session: loaded once, nothing else asked', async () => {
    // A refresh the Auth server could not answer (an outage) comes back as no
    // session with an error. auth-js retries a refresh for up to 30 s, so the
    // session is loaded once per read and never again for a second opinion.
    const getSession = vi.fn(async () => ({
      data: { session: null },
      error: { name: 'AuthRetryableFetchError', status: 503 },
    }));
    const getClaims = vi.fn();
    const getUser = vi.fn();
    const client = { auth: { getSession, getClaims, getUser } };
    expect(await readVerifiedSessionClaims(client as never)).toBeNull();
    expect(getSession).toHaveBeenCalledTimes(1);
    expect(getClaims).not.toHaveBeenCalled();
    expect(getUser).not.toHaveBeenCalled();
  });

  it('no session cookie: null, and no request', async () => {
    expect(await readVerifiedSessionClaims(await createClient())).toBeNull();
    expect(server.calls).toEqual({});
  });

  it('the key set cannot be fetched: the Auth server decides, one request, for a valid token', async () => {
    // Warm the key set cache with the pre-rotation key set.
    await signIn(sessionClaims({ aal: 'aal1' }));
    await readVerifiedSessionClaims(await createClient());
    // Rotated: signed with a key no client has cached yet, so getClaims() must
    // fetch the key set again, and that fetch fails.
    serve([projectKey, rotatedKey]);
    server.failJwks = true;
    const claims = sessionClaims({ aal: 'aal2' });
    await signIn(claims, await signAccessToken(rotatedKey, claims));
    const read = await readVerifiedSessionClaims(await createClient());
    expect(read).toMatchObject({ userId: FIXTURE_USER_ID, aal: 'aal2' });
    expect(server.calls['/.well-known/jwks.json']).toBeGreaterThanOrEqual(1);
    expect(server.calls['/user']).toBe(1);
  });

  it('the key set cannot be fetched and the token is forged: still null', async () => {
    await signIn(sessionClaims({ aal: 'aal1' }));
    await readVerifiedSessionClaims(await createClient());
    serve([projectKey, rotatedKey]);
    server.failJwks = true;
    const real = await signAccessToken(rotatedKey, sessionClaims({ aal: 'aal1' }));
    const forgedClaims = sessionClaims({ aal: 'aal2' });
    await signIn(forgedClaims, withEditedPayload(real, forgedClaims));
    expect(await readVerifiedSessionClaims(await createClient())).toBeNull();
    expect(server.calls['/user']).toBe(1);
  });

  it('never throws, whatever the client does', async () => {
    const broken = {
      auth: {
        getClaims: async () => {
          throw new Error('no WebCrypto');
        },
        getSession: async () => {
          throw new Error('storage unreadable');
        },
      },
    };
    await expect(readVerifiedSessionClaims(broken as never)).resolves.toBeNull();
    const brokenChecks = {
      auth: {
        getSession: async () => ({ data: { session: { access_token: 'a.b.c' } }, error: null }),
        getClaims: async () => {
          throw new Error('no WebCrypto');
        },
        getUser: async () => {
          throw new Error('network down');
        },
      },
    };
    await expect(readVerifiedSessionClaims(brokenChecks as never)).resolves.toBeNull();
  });
});

/**
 * The read a page render shares (React cache(); a pass-through here, as in a
 * Server Action). The dashboard layout starts it before anything else and
 * awaits it only at its enrolled-member gate, so it must never reject: a
 * rejection nobody awaits would surface as an unhandled one.
 */
describe('getVerifiedSessionClaimsForRequest', () => {
  it("reads this request's cookie session, verified like readVerifiedSessionClaims()", async () => {
    await signIn(sessionClaims({ aal: 'aal2' }));
    expect(await getVerifiedSessionClaimsForRequest()).toMatchObject({
      userId: FIXTURE_USER_ID,
      sessionId: FIXTURE_SESSION_ID,
      aal: 'aal2',
    });
    expect(server.calls['/user']).toBeUndefined();
    expect(insecureWarnings()).toBe(0);
  });

  it('a forged token: null', async () => {
    const real = await signAccessToken(projectKey, sessionClaims({ aal: 'aal1' }));
    const forgedClaims = sessionClaims({ aal: 'aal2' });
    await signIn(forgedClaims, withEditedPayload(real, forgedClaims));
    expect(await getVerifiedSessionClaimsForRequest()).toBeNull();
  });

  it('never rejects, even when no client can be made', async () => {
    cookiesUnavailable = true;
    await expect(getVerifiedSessionClaimsForRequest()).resolves.toBeNull();
  });
});

/**
 * readVerifiedSessionClaimsOf (docket S43a, review round 1): the claims count
 * only for the account the request already validated. A cookie's refresh token
 * and `expires_at` are the sender's to write, so the load behind this read can
 * refresh into ANOTHER account's session; its verified aal2 must not answer
 * for the first account.
 */
describe('readVerifiedSessionClaimsOf', () => {
  const OTHER = '33333333-3333-4333-8333-333333333333';

  /** A session whose cookie is due for a refresh now, with `refreshToken`. */
  async function dueForRefresh(refreshToken: string) {
    const claims = sessionClaims({ aal: 'aal1' });
    jar = sessionCookies(await signAccessToken(projectKey, claims), claims, {
      refreshToken,
      expiresAt: Math.floor(Date.now() / 1000) + 30,
    });
  }

  it("the validated account's own session: its claims", async () => {
    await signIn(sessionClaims({ aal: 'aal2' }));
    expect(await readVerifiedSessionClaimsOf(await createClient(), FIXTURE_USER_ID)).toMatchObject({
      userId: FIXTURE_USER_ID,
      aal: 'aal2',
    });
  });

  it("a session that refreshed into another account's aal2 session: null, with one line and no id", async () => {
    await dueForRefresh('other-refresh');
    const other = sessionClaims({ aal: 'aal2', sub: OTHER, email: 'other@example.test' });
    server.refreshGrants.set(
      'other-refresh',
      refreshGrant(await signAccessToken(projectKey, other), other, 'other-refresh-2'),
    );
    const supabase = await createClient();
    // The read itself is verified and real: it is the other account's.
    expect(await readVerifiedSessionClaimsOf(supabase, FIXTURE_USER_ID)).toBeNull();
    expect(server.calls['/token']).toBe(1);
    const lines = warn.mock.calls.filter((c: unknown[]) =>
      String(c[0]).startsWith('[verified-claims]'),
    );
    expect(lines).toHaveLength(1);
    expect(JSON.stringify(lines)).not.toContain(OTHER);
    expect(JSON.stringify(lines)).not.toContain(FIXTURE_USER_ID);
  });

  it("a refresh of the same account's session keeps its subject, so it still answers", async () => {
    await dueForRefresh('own-refresh');
    const renewed = sessionClaims({ aal: 'aal2', totpAgeSeconds: 60 });
    server.refreshGrants.set(
      'own-refresh',
      refreshGrant(await signAccessToken(projectKey, renewed), renewed, 'own-refresh-2'),
    );
    expect(await readVerifiedSessionClaimsOf(await createClient(), FIXTURE_USER_ID)).toMatchObject({
      userId: FIXTURE_USER_ID,
      aal: 'aal2',
    });
    expect(server.calls['/token']).toBe(1);
  });

  it('no verified claims at all: null, with no line', async () => {
    const real = await signAccessToken(projectKey, sessionClaims({ aal: 'aal1' }));
    const forged = sessionClaims({ aal: 'aal2' });
    await signIn(forged, withEditedPayload(real, forged));
    expect(await readVerifiedSessionClaimsOf(await createClient(), FIXTURE_USER_ID)).toBeNull();
    expect(
      warn.mock.calls.filter((c: unknown[]) => String(c[0]).startsWith('[verified-claims]')),
    ).toHaveLength(0);
  });
});

/**
 * readVerifiedSessionTokenOf (docket S50a): the same held read, with the
 * access token the claims are of, so the caller can make its database call
 * with exactly that token (lib/supabase/access-token-client). It is the same
 * one session load as readVerifiedSessionClaims: getSession() once, then the
 * check of that token.
 */
describe('readVerifiedSessionTokenOf', () => {
  const OTHER = '33333333-3333-4333-8333-333333333333';
  const verifiedClaimsLines = () =>
    warn.mock.calls.filter((c: unknown[]) => String(c[0]).startsWith('[verified-claims]'));

  it("the validated account's own session: its access token, with that token's verified claims", async () => {
    const claims = sessionClaims({ aal: 'aal2' });
    const token = await signAccessToken(projectKey, claims);
    jar = sessionCookies(token, claims);
    expect(await readVerifiedSessionTokenOf(await createClient(), FIXTURE_USER_ID)).toMatchObject({
      token,
      claims: { userId: FIXTURE_USER_ID, sessionId: FIXTURE_SESSION_ID, aal: 'aal2' },
    });
    expect(server.calls['/user']).toBeUndefined();
    expect(verifiedClaimsLines()).toHaveLength(0);
  });

  it("another account's verified session: null, with the one fixed line and no id", async () => {
    const other = sessionClaims({ aal: 'aal2', sub: OTHER, email: 'other@example.test' });
    jar = sessionCookies(await signAccessToken(projectKey, other), other);
    expect(await readVerifiedSessionTokenOf(await createClient(), FIXTURE_USER_ID)).toBeNull();
    expect(verifiedClaimsLines()).toHaveLength(1);
    expect(JSON.stringify(verifiedClaimsLines())).not.toContain(OTHER);
    expect(JSON.stringify(verifiedClaimsLines())).not.toContain(FIXTURE_USER_ID);
  });

  it('a token that does not verify: null, with no line', async () => {
    const real = await signAccessToken(projectKey, sessionClaims({ aal: 'aal1' }));
    const forged = sessionClaims({ aal: 'aal2' });
    jar = sessionCookies(withEditedPayload(real, forged), forged);
    expect(await readVerifiedSessionTokenOf(await createClient(), FIXTURE_USER_ID)).toBeNull();
    expect(verifiedClaimsLines()).toHaveLength(0);
  });

  it('no session: null, and no request', async () => {
    expect(await readVerifiedSessionTokenOf(await createClient(), FIXTURE_USER_ID)).toBeNull();
    expect(server.calls).toEqual({});
  });

  it('one session load: getSession() once, then the check of that same token, which is the token returned', async () => {
    const calls: string[] = [];
    const session: StubbedCookieSession = { sub: FIXTURE_USER_ID, aal: 'aal1' };
    const auth = verifiedSessionAuth(
      () => session,
      (call) => calls.push(call),
    );
    const checked: string[] = [];
    const client = {
      auth: {
        ...auth,
        getClaims: async (token: string) => {
          checked.push(token);
          return auth.getClaims(token);
        },
      },
    };
    const held = await readVerifiedSessionTokenOf(client as never, FIXTURE_USER_ID);
    expect(calls).toEqual(['getSession', 'getClaims']);
    expect(checked).toHaveLength(1);
    expect(held?.token).toBe(checked[0]);
    expect(held?.claims).toMatchObject({ userId: FIXTURE_USER_ID, aal: 'aal1' });
  });

  it('readVerifiedSessionClaimsOf answers with the claims of the same held read', async () => {
    const claims = sessionClaims({ aal: 'aal2' });
    jar = sessionCookies(await signAccessToken(projectKey, claims), claims);
    const held = await readVerifiedSessionTokenOf(await createClient(), FIXTURE_USER_ID);
    expect(await readVerifiedSessionClaimsOf(await createClient(), FIXTURE_USER_ID)).toEqual(
      held?.claims,
    );
  });
});
