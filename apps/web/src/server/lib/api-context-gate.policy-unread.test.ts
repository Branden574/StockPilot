import { beforeEach, describe, expect, it, vi } from 'vitest';

import { contextUnavailableBody, isRefusedBeforeAnyWrite } from '@stockpilot/core';

/**
 * The API context gate over the REAL API context, when the organization's
 * authenticator policy could not be read.
 *
 * withApiContext then holds the member to the strictest policy and marks the
 * context (lib/auth/mfa-policy.ts). A write from a member in that state with
 * no verified authenticator gets the gate's retryable answer (503
 * `check_failed`, retryable, nothing written), before the route does
 * anything.
 *
 * Every session shape (policy x role x authenticator x level), on both sign-in
 * paths and both ways the context is built (one round trip, separate
 * queries), for each organization row state (as stored; hidden; a failed
 * query; a policy read that rejects; a policy value it does not know), for
 * each method:
 *   - a session that owes its code: withApiContext's null, so the route's own
 *     401, whatever the state;
 *   - a policy that was not read, a member with no verified authenticator, a
 *     POST, PUT, PATCH or DELETE: the marker;
 *   - everything else (a GET or HEAD; a policy that was read, owed set-up or
 *     not; a verified authenticator at aal2): exactly the context
 *     withApiContext gives, so the route gives its own answer (an owed
 *     member's write meets its service gate's 403).
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

import { reportError } from '@/lib/error-reporter';
import { resetPolicyUnreadReportsForTests, withApiContext } from '@/lib/auth/api-context';
import { mfaPolicyWasUnread } from '@/lib/auth/mfa-policy';
import {
  assertPermission,
  mfaGateError,
  ServiceError,
  serviceErrorStatus,
} from '@/server/services/context';

import { apiContextGate } from './api-context-gate';

import type { Role } from '@stockpilot/core';

const USER_ID = '31313131-4141-4515-8616-717171717171';
const ORG_ID = '81818181-9191-4a1a-8b1b-c1c1c1c1c1c1';

type Policy = 'optional' | 'admins_required' | 'all_required';
type Aal = 'aal1' | 'aal2';
type Path = 'bearer' | 'cookie';
type Read = 'one round trip' | 'separate queries';
type Method = 'GET' | 'HEAD' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
type Org = 'stored' | 'hidden' | 'error' | 'rejects' | 'odd';

interface Session {
  policy: Policy;
  role: Role;
  authenticator: boolean;
  aal: Aal;
}

const state: Session & {
  rpc: boolean;
  /**
   * The organization row: as stored, hidden (no row), a failed query, a policy
   * read that rejects (throws instead of answering), or a policy value it does
   * not know.
   */
  org: Org;
  calls: string[];
  /** With no verified authenticator: an enrolment started and never confirmed. */
  unverifiedOnly: boolean;
} = {
  policy: 'optional',
  role: 'staff',
  authenticator: false,
  aal: 'aal1',
  rpc: true,
  org: 'stored',
  calls: [],
  unverifiedOnly: false,
};

const ROLES: Role[] = ['owner', 'admin', 'manager', 'staff', 'viewer'];
const POLICIES: Policy[] = ['optional', 'admins_required', 'all_required'];
const PATHS: Path[] = ['bearer', 'cookie'];
const READS: Read[] = ['one round trip', 'separate queries'];
const METHODS: Method[] = ['GET', 'HEAD', 'POST', 'PATCH', 'PUT', 'DELETE'];
const WRITES = new Set<Method>(['POST', 'PATCH', 'PUT', 'DELETE']);

const SESSIONS: Session[] = POLICIES.flatMap((policy) =>
  ROLES.flatMap((role) =>
    [false, true].flatMap((authenticator) =>
      (['aal1', 'aal2'] as Aal[]).map((aal) => ({ policy, role, authenticator, aal })),
    ),
  ),
);

const label = (s: Session) =>
  `${s.policy}, ${s.role}, ${s.authenticator ? 'authenticator' : 'no authenticator'}, ${s.aal}`;

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

/** The organization row whose policy read rejects; every other read of it answers as stored. */
function policyReadRejects(name: string) {
  const stored = { mfa_policy: state.policy, all_modules_comp: false };
  const q = row(name, stored);
  let columns = '';
  q.select = (cols: string) => {
    columns = cols;
    return q;
  };
  const answer = q.maybeSingle as () => Promise<unknown>;
  q.maybeSingle = async () => {
    if (!columns.includes('mfa_policy')) return answer();
    state.calls.push(`from:${name}`);
    throw new Error('fetch failed');
  };
  return q;
}

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
          state.org === 'stored' || state.org === 'odd'
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
        if (state.org === 'rejects') return policyReadRejects(name);
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
                : state.unverifiedOnly
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
  at = '/api/v1/items/5e5e5e5e-6f6f-4a7a-8b8b-9c9c9c9c9c9c/adjust',
): Request {
  const headers: Record<string, string> =
    path === 'bearer'
      ? { authorization: `Bearer ${fakeJwt(state.aal)}`, 'x-organization-id': ORG_ID }
      : // A write from a page of this origin, so the cookie path reads it.
        { cookie: 'sb-example-auth-token=abc', origin: 'https://app.test' };
  return new Request(`https://app.test${at}`, { method, headers });
}

function arrange(s: Session, read: Read, org: Org = 'stored', unverifiedOnly = false) {
  Object.assign(state, s, { rpc: read === 'one round trip', org, calls: [], unverifiedOnly });
  refs.client = makeClient();
}

/** Comparable: the context's own fields, the client left out. */
function shape(ctx: Awaited<ReturnType<typeof withApiContext>>) {
  if (!ctx) return null;
  const { supabase: _client, ...rest } = ctx;
  return {
    ...rest,
    permissions: rest.permissions ? [...rest.permissions].sort() : rest.permissions,
    // A module state that could not be read refuses to be listed: compare it as such.
    enabledModules: listedOrUnreadable(rest.enabledModules),
  };
}

function listedOrUnreadable(modules: Iterable<string>): string[] | 'unreadable' {
  try {
    return [...modules].sort();
  } catch {
    return 'unreadable';
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

type Expect = 'null' | 'marker' | 'ctx';

/**
 * The organization states, each with the ways of reading the context that
 * reach it as unread (a failed or rejected query is reached through the
 * separate queries).
 */
const ORG_STATES: ReadonlyArray<readonly [Org, readonly Read[]]> = [
  ['stored', READS],
  ['hidden', READS],
  ['error', ['separate queries']],
  ['rejects', ['separate queries']],
  ['odd', READS],
];

function expected(s: Session, org: Org, method: Method): Expect {
  if (s.authenticator && s.aal === 'aal1') return 'null';
  const unread = org !== 'stored';
  if (unread && !s.authenticator && WRITES.has(method)) return 'marker';
  return 'ctx';
}

async function expectMarker(gate: Awaited<ReturnType<typeof apiContextGate>>) {
  expect('response' in gate).toBe(true);
  const res = (gate as { response: Response }).response;
  expect(res.status).toBe(503);
  expect(res.headers.get('retry-after')).toBe('5');
  expect(res.headers.get('cache-control')).toBe('no-store');
  const body = (await res.json()) as { error: string; details: unknown };
  expect(body).toEqual(contextUnavailableBody());
  // What the phone reads it through: nothing was written, send it again.
  expect(isRefusedBeforeAnyWrite({ status: 503, code: body.error, details: body.details })).toBe(
    true,
  );
}

describe.each(PATHS)('apiContextGate over withApiContext (%s)', (path) => {
  describe.each(ORG_STATES.flatMap(([org, reads]) => reads.map((r) => [org, r] as const)))(
    'organization row %s, through the %s',
    (org, read) => {
      describe.each(METHODS)('%s', (method) => {
        it.each(SESSIONS.map((s) => [label(s), s] as const))('%s', async (_name, s) => {
          arrange(s, read, org);
          const plain = await withApiContext(request(path, method));
          arrange(s, read, org);
          const gate = await apiContextGate(request(path, method));

          const want = expected(s, org, method);
          if (want === 'null') {
            expect(plain).toBeNull();
            expect(gate).toEqual({ ctx: null });
            return;
          }
          expect(plain?.userId).toBe(USER_ID);
          // The state this row is about: the mark is there exactly when the row was not read.
          expect(mfaPolicyWasUnread(plain!)).toBe(org !== 'stored');
          if (want === 'marker') {
            expect([plain?.mfaRequired, plain?.mfaSatisfied, plain?.mfaEnrolled]).toEqual([
              true,
              false,
              false,
            ]);
            await expectMarker(gate);
            return;
          }
          expect(Object.keys(gate)).toEqual(['ctx']);
          expect(shape((gate as { ctx: typeof plain }).ctx)).toEqual(shape(plain));
        });
      });
    },
  );
});

describe("which requests get the marker, and which get the route's answer", () => {
  const owed: Session = {
    policy: 'all_required',
    role: 'staff',
    authenticator: false,
    aal: 'aal2',
  };

  it('a member whose policy was read and who owes set-up: the context, labelled, so the route keeps its 403', async () => {
    for (const path of PATHS) {
      for (const read of READS) {
        arrange(owed, read);
        const gate = await apiContextGate(request(path, 'POST'));
        expect('ctx' in gate && gate.ctx?.mfaRequired, `${path} ${read}`).toBe(true);
        expect('ctx' in gate && gate.ctx?.mfaEnrolled).toBe(false);
        expect('ctx' in gate && mfaPolicyWasUnread(gate.ctx!)).toBe(false);
      }
    }
  });

  it('the same member when the policy was not read: the marker, and one log line naming the state only', async () => {
    arrange({ ...owed, policy: 'optional' }, 'separate queries', 'error');
    await expectMarker(await apiContextGate(request('bearer', 'POST')));
    const warn = vi.mocked(console.warn);
    const line = warn.mock.calls.find((c) => String(c[0]).includes('[api-context-gate]'));
    expect(line).toEqual([
      '[api-context-gate] access could not be checked, refused before any work:',
      'MfaPolicyUnread',
    ]);
  });

  it('a policy that came back hidden or not a policy leaves one line where the context is marked: a fixed message and a cause code', async () => {
    const cases = [
      ['hidden', 'hidden_row'],
      ['odd', 'not_a_policy'],
    ] as const;
    for (const [org, cause] of cases) {
      for (const read of READS) {
        vi.mocked(console.warn).mockClear();
        arrange({ ...owed, policy: 'optional' }, read, org);
        await withApiContext(request('bearer', 'POST'));
        const lines = vi
          .mocked(console.warn)
          .mock.calls.filter((c) => String(c[0]).startsWith('[api-context] authenticator policy'));
        // The one-round-trip read hands a hidden row to the separate queries, which log it there.
        expect(lines, `${org} ${read}`).toEqual([
          ['[api-context] authenticator policy not read:', cause],
        ]);
      }
    }
  });

  describe('the report an operator gets: one per cause per ten minutes per server, the cause code only', () => {
    const CAUSES = [
      ['hidden', 'hidden_row'],
      ['odd', 'not_a_policy'],
      ['error', 'read_failed'],
      ['rejects', 'read_failed'],
    ] as const;
    const reports = () =>
      vi.mocked(reportError).mock.calls.filter((c) => c[1].tag === 'auth.mfa_policy.unread');

    beforeEach(() => {
      resetPolicyUnreadReportsForTests();
    });

    it.each(CAUSES)(
      'organization row %s: the first request reports %s once at warning level; the next ones log their line and do not report',
      async (org, cause) => {
        arrange({ ...owed, policy: 'optional' }, 'separate queries', org);
        for (let i = 0; i < 3; i += 1) await apiContextGate(request('bearer', 'POST'));
        expect(reports()).toHaveLength(1);
        const [err, context] = reports()[0]!;
        expect(context).toEqual({
          tag: 'auth.mfa_policy.unread',
          level: 'warning',
          extra: { cause },
        });
        // Nothing from the request or the row: no id, address or value.
        const sent = JSON.stringify([String(err), context]);
        for (const value of [ORG_ID, USER_ID, 'member@example.com', 'something_else']) {
          expect(sent).not.toContain(value);
        }
        // Every request still logs (the gate's line, and the cause's own line).
        const gateLines = vi
          .mocked(console.warn)
          .mock.calls.filter((c) => String(c[0]).startsWith('[api-context-gate]'));
        expect(gateLines).toHaveLength(3);
      },
    );

    it('each cause is reported on its own, and again once the ten minutes are over', async () => {
      const clock = vi.spyOn(Date, 'now');
      try {
        clock.mockReturnValue(1_800_000_000_000);
        for (const org of ['hidden', 'odd', 'error'] as const) {
          arrange({ ...owed, policy: 'optional' }, 'separate queries', org);
          await withApiContext(request('bearer', 'POST'));
          await withApiContext(request('bearer', 'POST'));
        }
        expect(reports().map((c) => c[1].extra?.cause)).toEqual([
          'hidden_row',
          'not_a_policy',
          'read_failed',
        ]);
        clock.mockReturnValue(1_800_000_000_000 + 10 * 60_000 - 1);
        arrange({ ...owed, policy: 'optional' }, 'separate queries', 'hidden');
        await withApiContext(request('bearer', 'POST'));
        expect(reports()).toHaveLength(3);
        clock.mockReturnValue(1_800_000_000_000 + 10 * 60_000);
        await withApiContext(request('bearer', 'POST'));
        expect(reports().map((c) => c[1].extra?.cause)).toEqual([
          'hidden_row',
          'not_a_policy',
          'read_failed',
          'hidden_row',
        ]);
      } finally {
        clock.mockRestore();
      }
    });

    it('a policy that was read reports nothing', async () => {
      for (const read of READS) {
        arrange({ ...owed, policy: 'optional' }, read, 'stored');
        await apiContextGate(request('bearer', 'POST'));
      }
      expect(reports()).toEqual([]);
    });
  });

  it('a verified authenticator at aal2 passes in every state', async () => {
    for (const [org, reads] of ORG_STATES) {
      for (const read of reads) {
        arrange({ ...owed, authenticator: true }, read, org);
        const gate = await apiContextGate(request('bearer', 'POST'));
        expect('ctx' in gate && gate.ctx?.userId, `${org} ${read}`).toBe(USER_ID);
      }
    }
  });

  it('a copy of the context carries no mark, so only the object withApiContext returned is answered', async () => {
    arrange({ ...owed, policy: 'optional' }, 'separate queries', 'hidden');
    const ctx = await withApiContext(request('bearer', 'POST'));
    expect(mfaPolicyWasUnread(ctx!)).toBe(true);
    expect(mfaPolicyWasUnread({ ...ctx! })).toBe(false);
  });
});

describe('a member whose only factor is unverified (enrolment never confirmed) is answered as one with none', () => {
  const NONE = SESSIONS.filter((s) => !s.authenticator);
  describe.each(ORG_STATES.flatMap(([org, reads]) => reads.map((r) => [org, r] as const)))(
    'organization row %s, through the %s',
    (org, read) => {
      it.each(NONE.map((s) => [label(s), s] as const))('%s', async (_name, s) => {
        for (const path of PATHS) {
          for (const method of METHODS) {
            arrange(s, read, org, true);
            const unverified = await apiContextGate(request(path, method));
            arrange(s, read, org, false);
            const none = await apiContextGate(request(path, method));
            const want = expected(s, org, method);
            if (want === 'marker') {
              await expectMarker(unverified);
              await expectMarker(none);
            } else {
              expect('ctx' in unverified && shape(unverified.ctx), `${path} ${method}`).toEqual(
                'ctx' in none && shape(none.ctx),
              );
            }
          }
        }
      });
    },
  );
});

/**
 * THE SERVICE GATE OVER AN API CONTEXT. A page or Server Action context built
 * from a policy that was not read gets the could-not-check error from the
 * service gate (server/services/context.ts). An API context does not: each
 * route handler maps a service error to its own answer, and the retryable
 * answer the phone reads as "nothing was written" has one sender, the API
 * context gate above. So on a route the gate does not stand in front of, the
 * service gate keeps its 403 `mfa_required` for a member with no verified
 * authenticator, whatever the organization row's state, and lets a verified
 * authenticator at aal2 through.
 */
describe('the service gate over the same API context keeps its own answer', () => {
  const STATES = ORG_STATES.flatMap(([org, reads]) => reads.map((r) => [org, r] as const));

  it.each(STATES)(
    'organization row %s, through the %s: no verified authenticator gets the 403 mfa_required, never the could-not-check error',
    async (org, read) => {
      for (const path of PATHS) {
        for (const unverifiedOnly of [false, true]) {
          for (const role of ROLES) {
            arrange(
              { policy: 'all_required', role, authenticator: false, aal: 'aal1' },
              read,
              org,
              unverifiedOnly,
            );
            const ctx = await withApiContext(request(path, 'POST'));
            const at = `${path} ${role} ${unverifiedOnly ? 'unverified only' : 'none'}`;
            expect(ctx, at).not.toBeNull();
            expect(mfaPolicyWasUnread(ctx!), at).toBe(org !== 'stored');
            let thrown: unknown;
            try {
              assertPermission(ctx!, 'items:read');
            } catch (e) {
              thrown = e;
            }
            expect(thrown, at).toBeInstanceOf(ServiceError);
            expect(thrown, at).toMatchObject({
              code: 'forbidden',
              details: { reason: 'mfa_required' },
            });
            expect(serviceErrorStatus((thrown as ServiceError).code), at).toBe(403);
            expect(mfaGateError(ctx!), at).toBeInstanceOf(ServiceError);
          }
        }
      }
    },
  );

  it.each(STATES)(
    'organization row %s, through the %s: a verified authenticator at aal2 passes',
    async (org, read) => {
      for (const path of PATHS) {
        arrange(
          { policy: 'all_required', role: 'staff', authenticator: true, aal: 'aal2' },
          read,
          org,
        );
        const ctx = await withApiContext(request(path, 'POST'));
        expect(() => assertPermission(ctx!, 'items:read'), path).not.toThrow();
      }
    },
  );
});
