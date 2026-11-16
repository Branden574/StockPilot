import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AUTHENTICATOR_SET_UP_OWED_COPY } from '@stockpilot/core';

/**
 * The /api/v1 read wrapper over the REAL API context: a read by a member who
 * must set up an authenticator first.
 *
 * withApiContext builds the context as before on every path and labels a
 * member who owes set-up (core authenticatorSetUpOwed: the organization's
 * policy requires an authenticator of the member's role and the account has
 * no verified one; a policy that could not be read is held to the strictest).
 * apiReadContext (server/lib/api-read-context.ts) answers such a GET or HEAD
 * 403 with core's sentence and reason `mfa_required`.
 *
 * Every session shape (policy x role x authenticator x level) on both sign-in
 * paths (bearer and cookie) and both ways the context is read (one round trip
 * and the separate reads), for a GET, a HEAD and a POST:
 *   - a session that owes its code: withApiContext's null, before anything is
 *     read, as before, whatever the method;
 *   - a member who owes set-up: the 403 for a GET and a HEAD; for a POST, the
 *     context withApiContext gives, labelled as before;
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

import { apiReadContext } from './api-read-context';

import type { Role } from '@stockpilot/core';

const USER_ID = '31313131-4141-4515-8616-717171717171';
const ORG_ID = '81818181-9191-4a1a-8b1b-c1c1c1c1c1c1';

type Policy = 'optional' | 'admins_required' | 'all_required';
type Aal = 'aal1' | 'aal2';
type Path = 'bearer' | 'cookie';
type Read = 'one round trip' | 'separate reads';
type Method = 'GET' | 'HEAD' | 'POST';

interface Session {
  policy: Policy;
  role: Role;
  authenticator: boolean;
  aal: Aal;
}

const state: Session & {
  rpc: boolean;
  /** The organization row: as read, hidden (no row), or a failed read. */
  org: 'read' | 'hidden' | 'error';
  calls: string[];
} = {
  policy: 'optional',
  role: 'staff',
  authenticator: false,
  aal: 'aal1',
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
          state.org === 'read'
            ? {
                id: ORG_ID,
                name: 'Example Goods',
                logo_url: null,
                terminology: null,
                mfa_policy: state.policy,
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
        return row(name, { mfa_policy: state.policy, all_modules_comp: false });
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
              factors: state.authenticator ? [{ status: 'verified' }] : [],
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

function arrange(s: Session, read: Read, org: 'read' | 'hidden' | 'error' = 'read') {
  Object.assign(state, s, { rpc: read === 'one round trip', org, calls: [] });
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
          // The labels the context carries for set-up owed, as before.
          expect({
            required: plain?.mfaRequired,
            satisfied: plain?.mfaSatisfied,
            enrolled: plain?.mfaEnrolled,
          }).toEqual({ required: true, satisfied: false, enrolled: false });
          if (method === 'POST') {
            expect('ctx' in wrapped && shape(wrapped.ctx)).toEqual(shape(plain));
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

describe('an organization policy that could not be read is held to the strictest', () => {
  const staff: Session = { policy: 'optional', role: 'staff', authenticator: false, aal: 'aal2' };

  it.each([
    ['the row is hidden, through the one round trip', 'one round trip', 'hidden'],
    ['the row is hidden, through the separate reads', 'separate reads', 'hidden'],
    ['the read failed, through the separate reads', 'separate reads', 'error'],
  ] as const)(
    '%s: a read by a staff member with no authenticator is held',
    async (_n, read, org) => {
      for (const path of PATHS) {
        arrange(staff, read, org);
        await expectHeld(await apiReadContext(request(path, 'GET')), 'GET');
        arrange(staff, read, org);
        const write = await apiReadContext(request(path, 'POST'));
        expect('ctx' in write && write.ctx?.mfaEnrolled, path).toBe(false);
      }
    },
  );

  it('the same member with an authenticator at aal2 still reads', async () => {
    arrange({ ...staff, authenticator: true }, 'separate reads', 'error');
    const read = await apiReadContext(request('bearer', 'GET'));
    expect('ctx' in read && read.ctx?.userId).toBe(USER_ID);
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
