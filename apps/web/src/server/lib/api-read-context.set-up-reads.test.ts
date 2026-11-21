import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AUTHENTICATOR_SET_UP_OWED_COPY, CONTEXT_UNAVAILABLE_COPY } from '@stockpilot/core';

/**
 * The API read wrapper over the REAL API context: a read by a member who must
 * set up an authenticator first.
 *
 * withApiContext builds the context on every path and labels a
 * member who owes set-up (core authenticatorSetUpOwed: the organization's
 * policy requires an authenticator of the member's role and the account has
 * no verified one; a policy that could not be read is held to the strictest,
 * and the context marked). apiReadContext (server/lib/api-read-context.ts)
 * answers such a GET or HEAD, or a POST its caller hands 'read', 403 with
 * core's sentence and reason `mfa_required`; when the policy was not read,
 * the retryable 503 `check_failed` instead.
 *
 * Every session shape (policy x role x authenticator x level) on both sign-in
 * paths (bearer and cookie) and both ways the context is read (one round trip
 * and the separate reads), for a GET, a HEAD and a POST:
 *   - a session that owes its code: withApiContext's null, before anything is
 *     read, whatever the method;
 *   - a member who owes set-up: the 403 for a GET, a HEAD and a POST handed
 *     'read'; for any other POST, the context withApiContext gives, with its
 *     set-up labels;
 *   - everyone else: exactly the context withApiContext gives.
 */

const refs = vi.hoisted(() => ({ client: null as unknown }));

vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));
vi.mock('@/lib/env', () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key',
  },
}));
vi.mock('@/lib/auth/effective-permissions', () => ({
  loadEffectivePermissions: async () => new Set<string>(['items:read']),
}));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => refs.client }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => refs.client }));

import { verifiedSessionAuth } from '@/test/verified-session-stub';

import { withApiContext } from '@/lib/auth/api-context';
import { mfaPolicyWasUnread } from '@/lib/auth/mfa-policy';

import { apiReadContext } from './api-read-context';

import type { Role } from '@stockpilot/core';

const USER_ID = '31313131-4141-4515-8616-717171717171';
const ORG_ID = '81818181-9191-4a1a-8b1b-c1c1c1c1c1c1';

type Policy = 'optional' | 'admins_required' | 'all_required';
type Aal = 'aal1' | 'aal2';
type Path = 'bearer' | 'cookie';
type Read = 'one round trip' | 'separate reads';
type Method = 'GET' | 'HEAD' | 'POST';
type Org = 'read' | 'hidden' | 'error' | 'odd';

interface Session {
  policy: Policy;
  role: Role;
  authenticator: boolean;
  aal: Aal;
}

const state: Session & {
  /** With no verified authenticator: a factor whose enrolment was never confirmed. */
  unverified: boolean;
  rpc: boolean;
  /** The organization row: as read, hidden (no row), a failed read, or a policy value it does not know. */
  org: Org;
  calls: string[];
} = {
  policy: 'optional',
  role: 'staff',
  authenticator: false,
  aal: 'aal1',
  unverified: false,
  rpc: true,
  org: 'read',
  calls: [],
};

const ROLES: Role[] = ['owner', 'admin', 'manager', 'staff', 'viewer'];
const POLICIES: Policy[] = ['optional', 'admins_required', 'all_required'];
const PATHS: Path[] = ['bearer', 'cookie'];
const READS: Read[] = ['one round trip', 'separate reads'];
const METHODS: Method[] = ['GET', 'HEAD', 'POST'];

const SESSIONS: Session[] = POLICIES.flatMap((policy) =>
  ROLES.flatMap((role) =>
    [false, true].flatMap((authenticator) =>
      (['aal1', 'aal2'] as Aal[]).map((aal) => ({ policy, role, authenticator, aal })),
    ),
  ),
);

const label = (s: Session) =>
  `${s.policy}, ${s.role}, ${s.authenticator ? 'authenticator' : 'no authenticator'}, ${s.aal}`;

/** The rule, written out for the test: required of this role, and no authenticator. */
function owesSetUp(s: Session): boolean {
  const required =
    s.policy === 'all_required' ||
    (s.policy === 'admins_required' && (s.role === 'owner' || s.role === 'admin'));
  return required && !s.authenticator;
}

function table(name: string, single: unknown, list: unknown[] = [], error: unknown = null) {
  const q: Record<string, unknown> = {};
  const self = () => q;
  for (const k of ['select', 'eq', 'is', 'not', 'in', 'limit', 'order']) q[k] = self;
  q.maybeSingle = async () => {
    state.calls.push(`from:${name}`);
    return { data: single, error, status: error ? 500 : 200 };
  };
  q.then = (resolve: (v: unknown) => unknown) => {
    state.calls.push(`from:${name}`);
    return Promise.resolve({ data: list, error: null, status: 200 }).then(resolve);
  };
  return q;
}

const row = (name: string, r: unknown) => table(name, r, r ? [r] : []);

function bundle() {
  return {
    user_id: USER_ID,
    profile: {
      id: USER_ID,
      email: 'member@example.com',
      full_name: null,
      avatar_url: null,
      default_organization_id: ORG_ID,
      disabled_at: null,
    },
    memberships: [
      {
        organization_id: ORG_ID,
        role: state.role,
        organization:
          state.org === 'read' || state.org === 'odd'
            ? {
                id: ORG_ID,
                name: 'Example Goods',
                logo_url: null,
                terminology: null,
                mfa_policy: state.org === 'odd' ? 'something_else' : state.policy,
                timezone: null,
                nav_overrides: null,
                dashboard_layout: null,
                order_status_config: null,
                all_modules_comp: false,
                order_catalog_last_hide_at: null,
              }
            : null,
        role_overrides: [],
        user_overrides: [],
        enabled_modules: [],
      },
    ],
  };
}

function makeClient() {
  return {
    rpc: async () => {
      state.calls.push('rpc');
      return state.rpc
        ? { data: bundle(), error: null }
        : { data: null, error: { code: 'PGRST301' } };
    },
    from: (name: string) => {
      if (name === 'organizations') {
        if (state.org === 'error') return table(name, null, [], { code: '57014' });
        if (state.org === 'hidden') return row(name, null);
        return row(name, {
          mfa_policy: state.org === 'odd' ? 'something_else' : state.policy,
          all_modules_comp: false,
        });
      }
      if (name === 'organization_members')
        return row(name, { organization_id: ORG_ID, role: state.role });
      if (name === 'user_profiles')
        return row(name, {
          id: USER_ID,
          email: 'member@example.com',
          default_organization_id: ORG_ID,
          disabled_at: null,
        });
      return table(name, null, []);
    },
    auth: {
      getUser: async () => {
        state.calls.push('auth:getUser');
        return {
          data: {
            user: {
              id: USER_ID,
              email: 'member@example.com',
              factors: state.authenticator
                ? [{ status: 'verified' }]
                : state.unverified
                  ? [{ status: 'unverified' }]
                  : [],
            },
          },
          error: null,
        };
      },
      ...verifiedSessionAuth(() => ({ sub: USER_ID, aal: state.aal })),
    },
  };
}

function fakeJwt(aal: Aal): string {
  const seg = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${seg({ alg: 'HS256', typ: 'JWT' })}.${seg({ sub: USER_ID, aal })}.sig`;
}

function request(
  path: Path,
  method: Method,
  at = '/api/v1/mobile/snapshot?since=2026-01-01',
): Request {
  const headers: Record<string, string> =
    path === 'bearer'
      ? { authorization: `Bearer ${fakeJwt(state.aal)}`, 'x-organization-id': ORG_ID }
      : // A write from a page of this origin, so the cookie path reads it.
        { cookie: 'sb-example-auth-token=abc', origin: 'https://app.test' };
  return new Request(`https://app.test${at}`, { method, headers });
}

function arrange(s: Session, read: Read, org: Org = 'read', unverified = false) {
  Object.assign(state, s, { unverified, rpc: read === 'one round trip', org, calls: [] });
  refs.client = makeClient();
}

/** Comparable: the context's own fields, the client left out. */
function shape(ctx: Awaited<ReturnType<typeof withApiContext>>) {
  if (!ctx) return null;
  const { supabase: _client, ...rest } = ctx;
  return {
    ...rest,
    permissions: rest.permissions ? [...rest.permissions].sort() : rest.permissions,
    enabledModules: [...rest.enabledModules].sort(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

/** A 403 that holds the read, with core's sentence. */
async function expectHeld(read: Awaited<ReturnType<typeof apiReadContext>>, method: Method) {
  expect('response' in read).toBe(true);
  const res = (read as { response: Response }).response;
  expect(res.status).toBe(403);
  expect(res.headers.get('cache-control')).toBe('private, no-store');
  if (method !== 'HEAD') {
    expect(await res.json()).toEqual({
      error: 'forbidden',
      message: AUTHENTICATOR_SET_UP_OWED_COPY,
      details: { reason: 'mfa_required' },
    });
  }
}

describe.each(PATHS)('apiReadContext over withApiContext (%s)', (path) => {
  describe.each(READS)('through the %s', (read) => {
    describe.each(METHODS)('%s', (method) => {
      it.each(SESSIONS.map((s) => [label(s), s] as const))('%s', async (_name, s) => {
        arrange(s, read);
        const plain = await withApiContext(request(path, method));
        arrange(s, read);
        const wrapped = await apiReadContext(request(path, method));

        // Owes the code: refused before anything is read, whatever the method.
        if (s.authenticator && s.aal === 'aal1') {
          expect(plain).toBeNull();
          expect(wrapped).toEqual({ ctx: null });
          expect(state.calls.filter((c) => c !== 'auth:getUser')).toEqual([]);
          return;
        }
        expect(plain?.userId).toBe(USER_ID);

        if (owesSetUp(s)) {
          // The labels withApiContext gives a member who owes set-up.
          expect({
            required: plain?.mfaRequired,
            satisfied: plain?.mfaSatisfied,
            enrolled: plain?.mfaEnrolled,
          }).toEqual({ required: true, satisfied: false, enrolled: false });
          expect(mfaPolicyWasUnread(plain!)).toBe(false);
          if (method === 'POST') {
            expect('ctx' in wrapped && shape(wrapped.ctx)).toEqual(shape(plain));
            // The same POST from a caller that says it reads: held.
            arrange(s, read);
            await expectHeld(await apiReadContext(request(path, method), 'read'), method);
          } else {
            await expectHeld(wrapped, method);
          }
          return;
        }
        // Owes nothing: exactly the context withApiContext gives.
        expect(Object.keys(wrapped)).toEqual(['ctx']);
        expect(shape((wrapped as { ctx: typeof plain }).ctx)).toEqual(shape(plain));
      });
    });
  });
});

/** The retryable answer for a policy that was not read. */
async function expectCouldNotCheck(read: Awaited<ReturnType<typeof apiReadContext>>) {
  expect('response' in read).toBe(true);
  const res = (read as { response: Response }).response;
  expect(res.status).toBe(503);
  expect(res.headers.get('retry-after')).toBe('5');
  expect(res.headers.get('cache-control')).toBe('private, no-store');
  expect(await res.json()).toEqual({
    error: 'check_failed',
    message: CONTEXT_UNAVAILABLE_COPY,
    details: { reason: 'context_unavailable', retryable: true },
  });
}

describe('an organization policy that could not be read: held to the strictest, told to try again', () => {
  const staff: Session = { policy: 'optional', role: 'staff', authenticator: false, aal: 'aal2' };
  const CASES = [
    ['the row is hidden, through the one round trip', 'one round trip', 'hidden'],
    ['the row is hidden, through the separate reads', 'separate reads', 'hidden'],
    ['the read failed, through the separate reads', 'separate reads', 'error'],
    [
      'the row has a policy value it does not know, through the one round trip',
      'one round trip',
      'odd',
    ],
    [
      'the row has a policy value it does not know, through the separate reads',
      'separate reads',
      'odd',
    ],
  ] as const;

  it.each(CASES)(
    '%s: a read by a staff member with no authenticator is the 503 check_failed, never the set-up sentence',
    async (_n, read, org) => {
      for (const path of PATHS) {
        arrange(staff, read, org);
        await expectCouldNotCheck(await apiReadContext(request(path, 'GET')));
        arrange(staff, read, org);
        await expectCouldNotCheck(await apiReadContext(request(path, 'POST'), 'read'));
        arrange(staff, read, org);
        const write = await apiReadContext(request(path, 'POST'));
        expect('ctx' in write && write.ctx?.mfaEnrolled, path).toBe(false);
      }
    },
  );

  it.each(CASES)(
    '%s: withApiContext gives the context labelled as set-up owed, marked as not read',
    async (_n, read, org) => {
      for (const path of PATHS) {
        arrange(staff, read, org);
        const ctx = await withApiContext(request(path, 'GET'));
        expect(ctx?.userId, path).toBe(USER_ID);
        expect([ctx?.mfaRequired, ctx?.mfaSatisfied, ctx?.mfaEnrolled]).toEqual([
          true,
          false,
          false,
        ]);
        expect(mfaPolicyWasUnread(ctx!)).toBe(true);
        // A copy carries no mark: only the object withApiContext returned does.
        expect(mfaPolicyWasUnread({ ...ctx! })).toBe(false);
      }
    },
  );

  it('the same member with an authenticator at aal2 still reads', async () => {
    for (const [, read, org] of CASES) {
      arrange({ ...staff, authenticator: true }, read, org);
      const got = await apiReadContext(request('bearer', 'GET'));
      expect('ctx' in got && got.ctx?.userId).toBe(USER_ID);
    }
  });
});

/** The wrapper's answer, comparable: the response's status and body, or the context's fields. */
async function answerOf(read: Awaited<ReturnType<typeof apiReadContext>>) {
  if ('response' in read) {
    return { status: read.response.status, body: await read.response.text() };
  }
  return { ctx: shape(read.ctx) };
}

describe('a factor whose enrolment was never confirmed counts as none', () => {
  const NO_AUTHENTICATOR = SESSIONS.filter((s) => !s.authenticator);

  describe.each(PATHS)('%s', (path) => {
    it.each(READS)(
      'through the %s: every policy, role, level and method answers as for no factor',
      async (read) => {
        for (const s of NO_AUTHENTICATOR) {
          for (const method of METHODS) {
            for (const kind of [undefined, 'read'] as const) {
              arrange(s, read);
              const none = await answerOf(await apiReadContext(request(path, method), kind));
              arrange(s, read, 'read', true);
              const unverified = await answerOf(await apiReadContext(request(path, method), kind));
              expect(unverified, `${label(s)}, ${method}, ${kind ?? 'no kind'}`).toEqual(none);
              const held = owesSetUp(s) && (method !== 'POST' || kind === 'read');
              expect(
                'status' in unverified && unverified.status,
                `${label(s)}, ${method}, ${kind ?? 'no kind'}`,
              ).toBe(held ? 403 : false);
            }
          }
        }
      },
    );
  });

  it('a policy that could not be read: the 503 check_failed for a read, as for no factor', async () => {
    const staff: Session = { policy: 'optional', role: 'staff', authenticator: false, aal: 'aal2' };
    const cases: [Read, Org][] = [
      ['one round trip', 'hidden'],
      ['separate reads', 'hidden'],
      ['separate reads', 'error'],
      ['one round trip', 'odd'],
      ['separate reads', 'odd'],
    ];
    for (const path of PATHS) {
      for (const [read, org] of cases) {
        arrange(staff, read, org, true);
        await expectCouldNotCheck(await apiReadContext(request(path, 'GET')));
        arrange(staff, read, org, true);
        await expectCouldNotCheck(await apiReadContext(request(path, 'POST'), 'read'));
      }
    }
  });
});

describe('a token at aal2 whose account has no authenticator left', () => {
  it('owes set-up under all_required: a read is held on both paths', async () => {
    for (const path of PATHS) {
      for (const read of READS) {
        arrange(
          { policy: 'all_required', role: 'viewer', authenticator: false, aal: 'aal2' },
          read,
        );
        await expectHeld(await apiReadContext(request(path, 'GET')), 'GET');
      }
    }
  });
});

describe('withApiContext itself is unchanged for a member who owes set-up', () => {
  it('a GET still gets the labelled context there; only the wrapper holds it', async () => {
    for (const path of PATHS) {
      arrange(
        { policy: 'all_required', role: 'owner', authenticator: false, aal: 'aal1' },
        'one round trip',
      );
      const ctx = await withApiContext(request(path, 'GET'));
      expect(ctx?.userId, path).toBe(USER_ID);
      expect(ctx?.mfaRequired).toBe(true);
      expect(ctx?.mfaSatisfied).toBe(false);
      expect(ctx?.mfaEnrolled).toBe(false);
    }
  });
});
