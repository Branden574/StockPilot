import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Security invariant (docket S43a with S5a): the phone's sign-in and sign-out
 * notes are the two routes on the AAL1 allowlist (AAL1_ROUTES in
 * src/test/api-step-up.guard.test.ts) beside the crash beacon, and no other
 * route the phone calls is.
 *
 * withApiContext refuses an account with a verified authenticator factor
 * until its session has the code (S43a). The phone sends both notes with a
 * session that can still owe it:
 *   - POST /api/v1/auth/signed-in goes right after the password, BEFORE the
 *     code screen, so a sign-in with a stolen password still writes its Audit
 *     log row and sends the new-device email. Refused, it would never do
 *     either for an account with an authenticator, the very account the
 *     email protects.
 *   - POST /api/v1/auth/signed-out goes from Sign out, which the phone also
 *     offers to a session that has not entered the code. It revokes the
 *     account's other sessions, which the Auth server's own logout and
 *     revoke_my_other_sessions already allow at aal1, and writes the row.
 *     Refused, the other devices would stay signed in for up to an hour.
 *
 * Runs the REAL withApiContext, the real bearer-claims check, the real session
 * list and broadcast, and a sibling route that is not on the list, against a
 * fake client: dropping either route's opt-out fails here, and so does an
 * opt-out that leaks to the rest of the API.
 */

const refs = vi.hoisted(() => ({
  calls: [] as string[],
  factors: [] as Array<{ status: string }>,
  audit: [] as Array<Record<string, unknown>>,
  notes: [] as Array<Record<string, unknown>>,
  broadcasts: [] as unknown[][],
  after: [] as Array<() => unknown>,
}));

vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));
vi.mock('@/lib/env', () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: 'https://db.example.test',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key',
  },
}));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, remaining: 29, resetAt: Date.now() })),
}));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => recordingClient() }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => recordingClient() }));
vi.mock('@/server/services/auth-audit', () => ({
  emitAuthAudit: vi.fn(async (row: Record<string, unknown>) => {
    refs.calls.push(`audit:${String(row.event)}`);
    refs.audit.push(row);
  }),
}));
vi.mock('@/lib/auth/login-device', () => ({
  noteLoginDevice: vi.fn(async (note: Record<string, unknown>) => {
    refs.notes.push(note);
  }),
}));
vi.mock('@/lib/realtime/broadcast', () => ({
  broadcastToChannel: vi.fn(async (...a: unknown[]) => {
    refs.calls.push('broadcast');
    refs.broadcasts.push(a);
  }),
}));
vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/server')>();
  return { ...actual, after: (cb: () => unknown) => refs.after.push(cb) };
});

import { withApiContext } from '@/lib/auth/api-context';

import { DELETE as pushDeregister, POST as pushRegister } from '../push/register/route';

import { POST as signedIn } from './signed-in/route';
import { POST as signedOut } from './signed-out/route';

const USER = '99999999-9999-4999-8999-999999999999';
const ORG = 'aaaaaaaa-1111-4111-8111-111111111111';
const SESSION = '22222222-2222-4222-8222-222222222222';
const OTHER = '55555555-5555-4555-8555-555555555555';

function payloadOf(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'));
}

/** Every table read answers empty: the point is whether one is made at all. */
function emptyBuilder(table: string): unknown {
  const proxy: unknown = new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop === 'symbol') return undefined;
        if (prop === 'then') {
          return (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
            Promise.resolve({ data: [], error: null, count: 0, status: 200 }).then(resolve, reject);
        }
        if (prop === 'maybeSingle' || prop === 'single') {
          return async () => ({ data: null, error: null });
        }
        return () => proxy;
      },
    },
  );
  refs.calls.push(`from:${table}`);
  return proxy;
}

function requestContext() {
  return {
    user_id: USER,
    profile: {
      id: USER,
      email: 'person@example.test',
      full_name: null,
      avatar_url: null,
      default_organization_id: ORG,
      disabled_at: null,
    },
    memberships: [
      {
        organization_id: ORG,
        role: 'staff',
        organization: {
          id: ORG,
          name: 'Org',
          logo_url: null,
          terminology: null,
          mfa_policy: 'optional',
          timezone: null,
          nav_overrides: null,
          dashboard_layout: null,
          order_status_config: null,
          all_modules_comp: false,
          order_catalog_last_hide_at: null,
        },
        role_overrides: [],
        user_overrides: [],
        enabled_modules: [],
      },
    ],
  };
}

function recordingClient() {
  return {
    from: (table: string) => emptyBuilder(table),
    rpc: async (name: string, args?: Record<string, unknown>) => {
      refs.calls.push(`rpc:${name}`);
      if (name === 'get_request_context') return { data: requestContext(), error: null };
      if (name === 'list_my_sessions')
        return { data: [{ id: OTHER }, { id: SESSION }], error: null };
      if (name === 'revoke_my_other_sessions') {
        refs.calls.push(`revoke-keeping:${String(args?.p_keep_session_id)}`);
        return { data: 1, error: null };
      }
      return { data: null, error: null };
    },
    auth: {
      getUser: async () => {
        refs.calls.push('auth:getUser');
        return { data: { user: { id: USER, factors: refs.factors } }, error: null };
      },
      // The verified read, standing in for auth-js's signature check, which
      // src/lib/auth/verified-claims.test.ts runs for real.
      getClaims: async (token: string) => {
        refs.calls.push('auth:getClaims');
        return { data: { claims: payloadOf(token), header: {}, signature: null }, error: null };
      },
    },
  };
}

/** The phone's access token: unsigned, read through the fakes above. */
function token(aal: 'aal1' | 'aal2'): string {
  const seg = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${seg({ alg: 'none', typ: 'JWT' })}.${seg({
    sub: USER,
    aal,
    session_id: SESSION,
    email: 'member@example.test',
  })}.`;
}

/** What the phone sends: a bearer token and its organization, no cookie. */
function phone(
  path: string,
  aal: 'aal1' | 'aal2',
  body: unknown,
  method: 'POST' | 'DELETE' = 'POST',
): NextRequest {
  return new NextRequest(`https://app.test${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token(aal)}`,
      'content-type': 'application/json',
      'user-agent': 'StockPilot/42 CFNetwork/1568.100.1 Darwin/24.0.0',
      'x-organization-id': ORG,
    },
    body: method === 'POST' ? JSON.stringify(body) : undefined,
  });
}

const SIGN_IN_BODY = {
  installId: '0f6c2d1e-8a4b-4c5d-9e6f-7a8b9c0d1e2f',
  device: { model: 'iPhone 15 Pro', osName: 'iOS', osVersion: '18.1', appVersion: '1.4.0' },
};
const PUSH_BODY = { token: 'ExponentPushToken[placeholder-0000000000]', platform: 'ios' };

async function runAfter() {
  for (const cb of refs.after.splice(0)) await cb();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  refs.calls = [];
  refs.factors = [{ status: 'verified' }];
  refs.audit = [];
  refs.notes = [];
  refs.broadcasts = [];
  refs.after = [];
});

describe('a session that still owes its authenticator code reaches the phone’s two auth notes', () => {
  it('POST /api/v1/auth/signed-in: the row says the code is owed, and the device note goes out', async () => {
    const res = await signedIn(phone('/api/v1/auth/signed-in', 'aal1', SIGN_IN_BODY));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(refs.audit).toHaveLength(1);
    expect(refs.audit[0]).toMatchObject({
      event: 'user.signed_in',
      userId: USER,
      organizationId: ORG,
      extra: expect.objectContaining({
        client: 'mobile',
        mfa_required: true,
        device_label: 'StockPilot app on iPhone',
      }),
    });
    await runAfter();
    // The model goes only to the person's own device list and email; the
    // organization's activity gets the family (integrator decision, device
    // label 2026-11-02).
    expect(refs.notes).toEqual([
      expect.objectContaining({
        userId: USER,
        deviceLabel: 'StockPilot app on iPhone 15 Pro (iOS 18.1)',
        deviceFamily: 'StockPilot app on iPhone',
      }),
    ]);
  });

  it('POST /api/v1/auth/signed-out: the other session is revoked and named, then the row', async () => {
    const res = await signedOut(phone('/api/v1/auth/signed-out', 'aal1', {}));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(refs.calls).toContain(`revoke-keeping:${SESSION}`);
    expect(refs.broadcasts).toEqual([
      [`user:${USER}:sessions`, 'revoked', { sessionIds: [OTHER] }],
    ]);
    expect(refs.audit).toEqual([
      expect.objectContaining({
        event: 'user.signed_out',
        extra: expect.objectContaining({ others_revoked: 1, revoke_skipped: false }),
      }),
    ]);
    // Revoke, then broadcast, then the row: the order the route promises.
    const order = refs.calls.filter((c) =>
      ['rpc:revoke_my_other_sessions', 'broadcast', 'audit:user.signed_out'].includes(c),
    );
    expect(order).toEqual(['rpc:revoke_my_other_sessions', 'broadcast', 'audit:user.signed_out']);
  });

  it('the context they get is labelled unsatisfied, so no permission check would pass it', async () => {
    const ctx = await withApiContext(phone('/api/v1/auth/signed-in', 'aal1', SIGN_IN_BODY), {
      allowStepUpPending: true,
    });
    expect(ctx).toMatchObject({ userId: USER, mfaEnrolled: true, mfaSatisfied: false });
  });

  it('with the code (aal2), and with no authenticator at all, both notes are served as before', async () => {
    for (const [factors, aal] of [
      [[{ status: 'verified' }], 'aal2'],
      [[], 'aal1'],
    ] as const) {
      refs.factors = [...factors];
      refs.audit = [];
      const inRes = await signedIn(phone('/api/v1/auth/signed-in', aal, SIGN_IN_BODY));
      const outRes = await signedOut(phone('/api/v1/auth/signed-out', aal, {}));
      expect([inRes.status, outRes.status]).toEqual([200, 200]);
      expect(refs.audit.map((r) => r.event)).toEqual(['user.signed_in', 'user.signed_out']);
      expect(refs.audit[0]).toMatchObject({
        extra: expect.objectContaining({ mfa_required: false }),
      });
    }
  });
});

describe('the same session is still refused everywhere else in the API', () => {
  it('the push registration the phone sends next answers 401, and nothing past the identity check runs', async () => {
    const res = await pushRegister(phone('/api/v1/push/register', 'aal1', PUSH_BODY));

    expect(res.status).toBe(401);
    expect(refs.calls).toEqual(['auth:getUser']);
  });

  it('so does its DELETE', async () => {
    const res = await pushDeregister(
      phone('/api/v1/push/register?token=placeholder', 'aal1', null, 'DELETE'),
    );

    expect(res.status).toBe(401);
    expect(refs.calls).toEqual(['auth:getUser']);
  });

  it('withApiContext without the opt-out, the call every other route makes, answers null for it', async () => {
    expect(await withApiContext(phone('/api/v1/auth/signed-in', 'aal1', SIGN_IN_BODY))).toBeNull();
    expect(refs.calls).toEqual(['auth:getUser']);
  });
});
