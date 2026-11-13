// @vitest-environment node
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { NextRequest } from 'next/server';

/**
 * Security invariant (docket S25, INV-E5): a press that GoTrue answers with a
 * session for another account than the one the link's `r` names leaves this
 * browser with NO session, in the same answer.
 *
 * route.test.ts pins that the route then calls signOut({ scope: 'local' }).
 * This runs the REAL @supabase/ssr server client and auth-js against a fake
 * Auth server that answers only /verify and /logout, so it proves what
 * production does with that call: verifyOtp writes the session cookie, and
 * the local sign-out removes it again before the answer leaves. A press for
 * the account `r` names keeps its session (the control).
 *
 * Placeholder values only: the keys and tokens are made per run
 * (src/test/auth-session-fixture.ts), and the signing value is a dull one
 * under a neutral name (src/test/secret-shaped-fixtures.guard.test.ts).
 */

const SIGNING_INPUT = vi.hoisted(() => 'test-only-signing-input');

let jar = new Map<string, string>();
/** Every cookie write, in order, as `name=value` ('' when it removes one). */
const writes: string[] = [];
vi.mock('next/headers', async () => {
  const { cookieStoreOver } = await import('@/test/auth-session-fixture');
  return {
    cookies: async () => {
      const store = cookieStoreOver(jar);
      return {
        ...store,
        set: (name: string, value: string) => {
          writes.push(`${name}=${value}`);
          store.set(name, value);
        },
      };
    },
  };
});
vi.mock('@/lib/env', async () => {
  const f = await import('@/test/auth-session-fixture');
  return {
    env: {
      NEXT_PUBLIC_SUPABASE_URL: f.FIXTURE_SUPABASE_URL,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: f.FIXTURE_ANON_KEY,
      NEXT_PUBLIC_APP_URL: 'https://app.example.com',
      SUPABASE_SERVICE_ROLE_KEY: SIGNING_INPUT,
    },
  };
});
const completeEmailChange = vi.fn(async (_args: { userId: string }) => ({}));
vi.mock('@/server/services/email-change', () => ({
  completeEmailChange: (args: { userId: string }) => completeEmailChange(args),
  EMAIL_CHANGE_RETURN_PATH: '/dashboard/settings/profile',
}));
const reportError = vi.fn(async (..._args: unknown[]) => {});
vi.mock('@/lib/error-reporter', () => ({
  reportError: (...args: unknown[]) => reportError(...args),
}));

import { signConfirmRecipient } from '@/lib/auth/confirm-recipient';
import {
  FIXTURE_AUTH_COOKIE,
  FIXTURE_SUPABASE_URL,
  makeSigningKey,
  sessionClaims,
  signAccessToken,
  type SigningKey,
} from '@/test/auth-session-fixture';

import { PRESS_GATE_PASSED_FIELD, PRESS_GATE_PASSED_VALUE } from './press-gate';
import { POST } from './route';

const BASE = 'https://app.example.com';
/** The account the link names, and the one a wrong session would be for. */
const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '33333333-3333-4333-8333-333333333333';
/** GoTrue's hashed tokens are sha224 in hex: 56 characters. */
const HASH_A = 'ab'.repeat(28);
/** A dull stand-in for the refresh credential; nothing here refreshes. */
const REFRESH_REF = 'refresh-ref-2';

let projectKey: SigningKey;
/** The account GoTrue's /verify makes a session for. */
let sessionUser = USER_A;
/** Requests that reached the fake Auth server, as `METHOD /path?query`. */
let requests: string[] = [];

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function authServer(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
  );
  const base = `${FIXTURE_SUPABASE_URL}/auth/v1`;
  if (!url.href.startsWith(base)) throw new Error(`unexpected request: ${url.pathname}`);
  const path = url.pathname.slice(new URL(base).pathname.length);
  requests.push(`${init?.method ?? 'GET'} ${path}${url.search}`);
  if (path === '/verify') {
    const claims = sessionClaims({ sub: sessionUser });
    const jwt = await signAccessToken(projectKey, claims);
    return json(200, {
      access_token: jwt,
      expires_in: 3600,
      expires_at: claims.exp,
      refresh_token: REFRESH_REF,
      user: {
        id: sessionUser,
        aud: 'authenticated',
        role: 'authenticated',
        email: 'person@example.com',
        app_metadata: { provider: 'email' },
        user_metadata: {},
      },
    });
  }
  if (path === '/logout') return new Response(null, { status: 204 });
  return json(404, { msg: `no route ${path}` });
}

/** The session cookie's chunks still holding a value. */
function liveSessionCookies(): string[] {
  return [...jar]
    .filter(([name, value]) => name.startsWith(FIXTURE_AUTH_COOKIE) && value !== '')
    .map(([name]) => name);
}

function pressFor(type: 'recovery' | 'email_change'): NextRequest {
  const r = signConfirmRecipient(SIGNING_INPUT, {
    type,
    tokenHash: HASH_A,
    userId: USER_A,
    issued: Math.floor(Date.now() / 1000),
  });
  const body = new URLSearchParams({
    token_hash: HASH_A,
    type,
    next: '/reset/complete',
    r: r!,
    // The press gate let the press through (press-gate.ts).
    [PRESS_GATE_PASSED_FIELD]: PRESS_GATE_PASSED_VALUE,
  });
  return new NextRequest(`${BASE}/auth/confirm`, {
    method: 'POST',
    body,
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'sec-fetch-site': 'same-origin',
      origin: 'null',
    },
  });
}

beforeAll(async () => {
  projectKey = await makeSigningKey('fixture-key-1');
});

beforeEach(() => {
  jar = new Map();
  writes.length = 0;
  requests = [];
  sessionUser = USER_A;
  vi.clearAllMocks();
  vi.stubGlobal('fetch', authServer);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('POST /auth/confirm with the real session libraries (S25)', () => {
  it('control: a press for the account r names keeps the session verifyOtp made', async () => {
    const res = await POST(pressFor('recovery'));
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`${BASE}/reset/complete`);
    expect(liveSessionCookies().length).toBeGreaterThan(0);
    expect(requests).toEqual(['POST /verify']);
  });

  it('a session for another account is written, then removed again in the same answer', async () => {
    sessionUser = USER_B;
    const res = await POST(pressFor('recovery'));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Sign in to continue');
    // verifyOtp did write the session cookie...
    expect(writes.some((w) => w.startsWith(FIXTURE_AUTH_COOKIE) && !w.endsWith('='))).toBe(true);
    // ...and the browser leaves with none: every chunk was written empty.
    expect(liveSessionCookies()).toEqual([]);
    // Only this session was ended at GoTrue, never the account's others.
    expect(requests).toEqual(['POST /verify', 'POST /logout?scope=local']);
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tag: 'auth.confirm_recipient_mismatch' }),
    );
  });

  it('the same for an email change, after the change is completed for the account GoTrue changed', async () => {
    sessionUser = USER_B;
    const res = await POST(pressFor('email_change'));
    expect(res.status).toBe(200);
    expect(completeEmailChange).toHaveBeenCalledWith({ userId: USER_B });
    expect(liveSessionCookies()).toEqual([]);
    expect(requests).toEqual(['POST /verify', 'POST /logout?scope=local']);
  });
});
