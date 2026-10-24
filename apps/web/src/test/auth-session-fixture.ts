/**
 * A signed-in cookie session that the REAL auth libraries read, and a fake
 * Supabase Auth server for them to talk to.
 *
 * The tests that use this run the real `@supabase/ssr` server client and the
 * real `@supabase/auth-js` code against it, so what they prove is what
 * production does: which call reads the stored user object (and logs the
 * "could be insecure" warning), which call verifies the access token's
 * signature, and how many requests reach the Auth server.
 *
 * - Keys: an ES256 key pair made with WebCrypto at run time, served as the
 *   project's JWKS, the way a project with asymmetric signing keys serves it
 *   (`/auth/v1/.well-known/jwks.json`). Nothing here is a real credential:
 *   every key and token is generated per test run and never leaves it.
 * - The cookie: the session JSON written the way `@supabase/ssr` writes it
 *   (`base64-` + base64url, chunked), under `sb-<project ref>-auth-token`.
 * - The Auth server: `GET /user` accepts a token only when its signature is
 *   the project key's (or the legacy HS256 secret's, when a test sets one) and
 *   it has not expired (GoTrue's own check), then answers session_not_found
 *   for a session a test revoked; a refresh always fails, so an expired
 *   session cannot be revived.
 *
 * A forged token is modelled the two ways an attacker can make one: a real
 * token whose payload was edited (its signature no longer matches), and a
 * token signed with the attacker's own key under the project's key id.
 */

import { createChunks, stringToBase64URL } from '@supabase/ssr';

export const FIXTURE_SUPABASE_URL = 'https://fixtureproject.supabase.co';
export const FIXTURE_ANON_KEY = 'anon-fixture';
/** The cookie supabase-js names after the project ref. */
export const FIXTURE_AUTH_COOKIE = 'sb-fixtureproject-auth-token';
/** A dull stand-in for the refresh credential; the fake server never accepts it. */
const REFRESH_REF = 'refresh-ref-1';

export const FIXTURE_USER_ID = '11111111-1111-4111-8111-111111111111';
export const FIXTURE_SESSION_ID = '22222222-2222-4222-8222-222222222222';
export const FIXTURE_EMAIL = 'member@example.com';

const AUTH_BASE = `${FIXTURE_SUPABASE_URL}/auth/v1`;

export interface SigningKey {
  kid: string;
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  publicJwk: JsonWebKey & { kid: string; alg: string; use: string };
}

export async function makeSigningKey(kid: string): Promise<SigningKey> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  return {
    kid,
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
    publicJwk: { ...jwk, kid, alg: 'ES256', use: 'sig', key_ops: ['verify'] },
  };
}

const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

export interface SessionClaimsInput {
  aal?: 'aal1' | 'aal2';
  /** Seconds from now; negative is already expired. */
  expiresIn?: number;
  /** Seconds before now that the second factor was asserted (adds a totp amr entry). */
  totpAgeSeconds?: number;
  sessionId?: string;
  sub?: string;
}

export function sessionClaims(input: SessionClaimsInput = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  const amr: Array<{ method: string; timestamp: number }> = [
    { method: 'password', timestamp: now - 3600 },
  ];
  if (input.totpAgeSeconds !== undefined) {
    amr.push({ method: 'totp', timestamp: now - input.totpAgeSeconds });
  }
  return {
    aud: 'authenticated',
    exp: now + (input.expiresIn ?? 3600),
    iat: now - 60,
    iss: AUTH_BASE,
    sub: input.sub ?? FIXTURE_USER_ID,
    email: FIXTURE_EMAIL,
    role: 'authenticated',
    aal: input.aal ?? 'aal1',
    amr,
    session_id: input.sessionId ?? FIXTURE_SESSION_ID,
    is_anonymous: false,
  };
}

/** A compact ES256 JWS over `claims`, signed with `key` (header kid = `kid` or the key's own). */
export async function signAccessToken(
  key: SigningKey,
  claims: Record<string, unknown>,
  kid: string = key.kid,
): Promise<string> {
  const signingInput = `${b64url({ alg: 'ES256', typ: 'JWT', kid })}.${b64url(claims)}`;
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key.privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${Buffer.from(signature).toString('base64url')}`;
}

/** The same token with its payload swapped for `claims` and the ORIGINAL signature kept. */
export function withEditedPayload(jwt: string, claims: Record<string, unknown>): string {
  const [header, , signature] = jwt.split('.');
  return `${header}.${b64url(claims)}.${signature}`;
}

/** A token with no signature at all (`alg: none`). */
export function unsignedToken(claims: Record<string, unknown>): string {
  return `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url(claims)}.`;
}

/**
 * The project's LEGACY symmetric secret (HS256), made at run time like the
 * keys above. The key set never lists a symmetric key, so getClaims() cannot
 * check a token signed with it and asks the Auth server (GET /user) instead:
 * the path of a project still on the legacy secret, and of a session issued
 * before a project moved to asymmetric keys.
 */
export async function makeLegacySecret(): Promise<CryptoKey> {
  return (await crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ])) as CryptoKey;
}

/** A compact HS256 JWS over `claims`, signed with the legacy secret (no key id, as legacy tokens have none). */
export async function signLegacyToken(
  secret: CryptoKey,
  claims: Record<string, unknown>,
): Promise<string> {
  const signingInput = `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(claims)}`;
  const signature = await crypto.subtle.sign(
    'HMAC',
    secret,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${Buffer.from(signature).toString('base64url')}`;
}

/**
 * The cookies `@supabase/ssr` would hold for a session carrying `jwt`. The
 * stored user object lists a VERIFIED TOTP factor: what the session cookie of
 * an enrolled member holds, and the field the warning proxy guards.
 */
export function sessionCookies(jwt: string, claims: Record<string, unknown>): Map<string, string> {
  const session = {
    access_token: jwt,
    refresh_token: REFRESH_REF,
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: claims.exp,
    user: {
      id: claims.sub,
      aud: 'authenticated',
      role: 'authenticated',
      email: FIXTURE_EMAIL,
      app_metadata: { provider: 'email' },
      user_metadata: {},
      factors: [{ id: 'factor-1', factor_type: 'totp', status: 'verified' }],
    },
  };
  const jar = new Map<string, string>();
  const encoded = `base64-${stringToBase64URL(JSON.stringify(session))}`;
  for (const chunk of createChunks(FIXTURE_AUTH_COOKIE, encoded)) jar.set(chunk.name, chunk.value);
  return jar;
}

/** A `next/headers` cookie store over `jar` (getAll/get/set/delete). */
export function cookieStoreOver(jar: Map<string, string>) {
  return {
    getAll: () => [...jar].map(([name, value]) => ({ name, value })),
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => {
      jar.set(name, value);
    },
    delete: (name: string) => {
      jar.delete(name);
    },
  };
}

export interface FakeAuthServer {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  /** Requests per path (`/user`, `/.well-known/jwks.json`, `/token`). */
  calls: Record<string, number>;
  /** Make the JWKS endpoint fail (a transient Auth outage for key discovery only). */
  failJwks: boolean;
  /** The legacy HS256 secret GoTrue still accepts tokens under, if any. */
  legacySecret: CryptoKey | null;
  /**
   * Session ids GoTrue no longer has (signed out, or revoked from another
   * device): `/user` answers session_not_found for a token of one of them,
   * after its signature and expiry check out, as GoTrue does.
   */
  revokedSessions: Set<string>;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/**
 * The claims of `jwt` if GoTrue accepts it, else null: signed by the project
 * key its header names (or, for HS256, by the legacy secret) and unexpired.
 */
async function accepted(
  keys: SigningKey[],
  legacySecret: CryptoKey | null,
  jwt: string,
): Promise<Record<string, unknown> | null> {
  const [header, payload, signature] = jwt.split('.');
  if (!header || !payload || !signature) return null;
  try {
    const { alg, kid } = JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as {
      alg?: string;
      kid?: string;
    };
    const signed = new TextEncoder().encode(`${header}.${payload}`);
    const sig = Buffer.from(signature, 'base64url');
    let ok = false;
    if (alg === 'HS256') {
      ok = legacySecret !== null && (await crypto.subtle.verify('HMAC', legacySecret, sig, signed));
    } else {
      const key = keys.find((k) => k.kid === kid);
      if (!key) return null;
      ok = await crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        key.publicKey,
        sig,
        signed,
      );
    }
    if (!ok) return null;
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    return typeof claims.exp === 'number' && claims.exp * 1000 > Date.now() ? claims : null;
  } catch {
    return null;
  }
}

/** The project's Auth server, signing with `projectKeys` (served together as its JWKS). */
export function fakeAuthServer(projectKeys: SigningKey | SigningKey[]): FakeAuthServer {
  const keys = Array.isArray(projectKeys) ? projectKeys : [projectKeys];
  const server: FakeAuthServer = {
    calls: {},
    failJwks: false,
    legacySecret: null,
    revokedSessions: new Set(),
    fetch: async (input, init) => {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      );
      if (!url.href.startsWith(AUTH_BASE)) {
        throw new Error(`unexpected request in an auth test: ${url.href}`);
      }
      const path = url.pathname.slice(new URL(AUTH_BASE).pathname.length);
      server.calls[path] = (server.calls[path] ?? 0) + 1;
      if (path === '/.well-known/jwks.json') {
        if (server.failJwks) return json(503, { code: 'unavailable', msg: 'try again' });
        return json(200, { keys: keys.map((k) => k.publicJwk) });
      }
      if (path === '/user') {
        const headers = new Headers(init?.headers);
        const bearer = headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
        const claims = await accepted(keys, server.legacySecret, bearer);
        if (!claims) {
          return json(403, { code: 'bad_jwt', error_code: 'bad_jwt', msg: 'invalid JWT' });
        }
        if (server.revokedSessions.has(String(claims.session_id))) {
          // GoTrue's answer in the 2024-01-01 API version that auth-js asks
          // for: auth-js turns this code into AuthSessionMissingError (status
          // 400), not an AuthApiError(403).
          return json(
            403,
            {
              code: 'session_not_found',
              message: 'Session from session_id claim in JWT does not exist',
            },
            { 'x-supabase-api-version': '2024-01-01' },
          );
        }
        return json(200, {
          id: claims.sub,
          aud: 'authenticated',
          role: 'authenticated',
          email: FIXTURE_EMAIL,
          app_metadata: { provider: 'email' },
          user_metadata: {},
          factors: [{ id: 'factor-1', factor_type: 'totp', status: 'verified' }],
        });
      }
      if (path === '/token') {
        return json(400, {
          code: 'refresh_token_not_found',
          error_code: 'refresh_token_not_found',
          msg: 'Invalid Refresh Token: Refresh Token Not Found',
        });
      }
      return json(404, { msg: `no route ${path}` });
    },
  };
  return server;
}

/** The warning auth-js logs when the stored (unverified) user object is read on a server. */
export const INSECURE_USER_WARNING = /could be insecure/;
