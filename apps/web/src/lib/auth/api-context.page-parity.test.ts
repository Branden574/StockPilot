import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The API and the pages give one authenticator answer.
 *
 * Every session shape (policy x role x authenticator x level) is resolved twice
 * from the same rows: once by withApiContext (bearer and cookie, through the
 * one-round-trip read and through the separate reads) and once by withContext,
 * the context pages and Server Actions use. The answer is what assertPermission
 * makes of the context: it passes, or it asks for `mfa_required` (set up an
 * authenticator) or `aal2_required` (enter the code).
 *
 * A session with an authenticator at aal1 is refused by the API before any read
 * (the route's own 401) and sent to the code page by the page path; the gate's
 * answer for it is compared through the reviewed allowlist, which builds the
 * context at aal1.
 *
 * The routes a member uses to finish signing in, and the web screens that set
 * up an authenticator, do not ask this gate: they are pinned at the end.
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
// The page path's own inputs: who the member is, the organization row and the
// member's authenticator list.
vi.mock('@/lib/auth/session', () => ({ requireOrgContext: vi.fn() }));
vi.mock('@/lib/dashboard/request-cache', () => ({
  getOrgRowForRequest: vi.fn(),
  getMfaFactorsForRequest: vi.fn(),
  getModulesForRequest: vi.fn(),
}));

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { requireOrgContext } from '@/lib/auth/session';
import {
  getMfaFactorsForRequest,
  getModulesForRequest,
  getOrgRowForRequest,
} from '@/lib/dashboard/request-cache';
import {
  assertPermission,
  ServiceError,
  withContext,
  type ServiceContext,
} from '@/server/services/context';
import { verifiedSessionAuth } from '@/test/verified-session-stub';

import { cookieSessionMfaState, withApiContext } from './api-context';

import type { Permission, Role } from '@stockpilot/core';

const USER_ID = '12121212-3434-5656-7878-909090909090';
const ORG_ID = '45454545-6767-8989-0101-232323232323';

type Policy = 'optional' | 'admins_required' | 'all_required';
type Aal = 'aal1' | 'aal2';
type Path = 'bearer' | 'cookie';
type Read = 'one round trip' | 'separate reads';
type Answer = '401' | 'passes' | 'aal2_required' | 'mfa_required';

interface Session {
  policy: Policy;
  role: Role;
  authenticator: boolean;
  aal: Aal;
}

const state: Session & { rpc: boolean } = {
  policy: 'optional',
  role: 'staff',
  authenticator: false,
  aal: 'aal1',
  rpc: true,
};

const ROLES: Role[] = ['owner', 'admin', 'manager', 'staff', 'viewer'];
const POLICIES: Policy[] = ['optional', 'admins_required', 'all_required'];
const PATHS: Path[] = ['bearer', 'cookie'];
const READS: Read[] = ['one round trip', 'separate reads'];

const SESSIONS: Session[] = POLICIES.flatMap((policy) =>
  ROLES.flatMap((role) =>
    [false, true].flatMap((authenticator) =>
      (['aal1', 'aal2'] as Aal[]).map((aal) => ({ policy, role, authenticator, aal })),
    ),
  ),
);

const label = (s: Session) =>
  `${s.policy}, ${s.role}, ${s.authenticator ? 'authenticator' : 'no authenticator'}, ${s.aal}`;

function table(single: unknown, list: unknown[] = []) {
  const q: Record<string, unknown> = {};
  const self = () => q;
  for (const k of ['select', 'eq', 'is', 'not', 'in', 'limit', 'order']) q[k] = self;
  q.maybeSingle = async () => ({ data: single, error: null, status: 200 });
  q.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve({ data: list, error: null, status: 200 }).then(resolve);
  return q;
}

const row = (r: unknown) => table(r, r ? [r] : []);

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
        organization: {
          id: ORG_ID,
          name: 'Example Supply',
          logo_url: null,
          terminology: null,
          mfa_policy: state.policy,
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

function makeClient() {
  return {
    rpc: async () =>
      state.rpc ? { data: bundle(), error: null } : { data: null, error: { code: 'PGRST301' } },
    from: (name: string) => {
      if (name === 'organizations')
        return row({ mfa_policy: state.policy, all_modules_comp: false });
      if (name === 'organization_members') return row({ organization_id: ORG_ID, role: state.role });
      if (name === 'user_profiles')
        return row({
          id: USER_ID,
          email: 'member@example.com',
          default_organization_id: ORG_ID,
          disabled_at: null,
        });
      return table(null, []);
    },
    auth: {
      getUser: async () => ({
        data: {
          user: {
            id: USER_ID,
            email: 'member@example.com',
            factors: state.authenticator ? [{ status: 'verified' }] : [],
          },
        },
        error: null,
      }),
      ...verifiedSessionAuth(() => ({ sub: USER_ID, aal: state.aal })),
    },
  };
}

function fakeJwt(aal: Aal): string {
  const seg = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${seg({ alg: 'HS256', typ: 'JWT' })}.${seg({ sub: USER_ID, aal })}.sig`;
}

function request(path: Path): Request {
  return path === 'bearer'
    ? new Request('https://app.test/api/v1/items', {
        headers: { authorization: `Bearer ${fakeJwt(state.aal)}`, 'x-organization-id': ORG_ID },
      })
    : new Request('https://app.test/api/v1/items', {
        headers: { cookie: 'sb-example-auth-token=abc' },
      });
}

function arrange(s: Session, read: Read = 'one round trip') {
  Object.assign(state, s, { rpc: read === 'one round trip' });
  refs.client = makeClient();
  vi.mocked(requireOrgContext).mockResolvedValue({
    userId: USER_ID,
    email: 'member@example.com',
    fullName: null,
    avatarUrl: null,
    defaultOrganizationId: ORG_ID,
    organizationId: ORG_ID,
    organizationName: 'Example Supply',
    role: s.role,
    permissions: new Set<Permission>(['items:read']),
  } as Awaited<ReturnType<typeof requireOrgContext>>);
  vi.mocked(getOrgRowForRequest).mockResolvedValue({
    terminology: null,
    mfa_policy: s.policy,
    logo_url: null,
    timezone: null,
    nav_overrides: null,
    dashboard_layout: null,
    order_status_config: null,
  });
  vi.mocked(getMfaFactorsForRequest).mockResolvedValue({
    userId: USER_ID,
    factors: s.authenticator ? [{ status: 'verified' }] : [],
  } as Awaited<ReturnType<typeof getMfaFactorsForRequest>>);
  vi.mocked(getModulesForRequest).mockResolvedValue(new Set());
}

function gate(ctx: ServiceContext | null): Answer {
  if (!ctx) return '401';
  try {
    assertPermission(ctx, 'items:read');
    return 'passes';
  } catch (e) {
    expect(e).toBeInstanceOf(ServiceError);
    return (e as ServiceError).details?.reason as Answer;
  }
}

async function apiAnswer(path: Path, read: Read, s: Session, allowlisted = false) {
  arrange(s, read);
  const ctx = await withApiContext(
    request(path),
    allowlisted ? { allowStepUpPending: true } : undefined,
  );
  return { answer: gate(ctx), ctx };
}

async function pageAnswer(s: Session) {
  arrange(s);
  const ctx = await withContext();
  return { answer: gate(ctx), ctx };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

describe.each(PATHS)('withApiContext (%s) answers as the pages do', (path) => {
  describe.each(READS)('through the %s', (read) => {
    it.each(SESSIONS.map((s) => [label(s), s] as const))('%s', async (_name, s) => {
      const page = await pageAnswer(s);
      // An authenticator at aal1: the API refuses before any read; its gate
      // answer is the allowlisted one.
      const owesCode = s.authenticator && s.aal === 'aal1';
      if (owesCode) {
        expect((await apiAnswer(path, read, s)).answer).toBe('401');
      }
      const api = await apiAnswer(path, read, s, owesCode);
      expect(api.answer).toBe(page.answer);
      expect({
        required: api.ctx?.mfaRequired,
        satisfied: api.ctx?.mfaSatisfied,
        enrolled: api.ctx?.mfaEnrolled,
      }).toEqual({
        required: page.ctx.mfaRequired,
        satisfied: page.ctx.mfaSatisfied,
        enrolled: page.ctx.mfaEnrolled,
      });
    });
  });
});

/**
 * The answers themselves, for the sessions at aal2: a policy that requires an
 * authenticator for this member is met by an authenticator and its code, on
 * both surfaces.
 */
const AAL2_ROWS: Array<[Policy, Role, boolean, Answer]> = [
  ['optional', 'staff', false, 'passes'],
  ['optional', 'admin', false, 'passes'],
  ['optional', 'admin', true, 'passes'],
  ['admins_required', 'owner', false, 'mfa_required'],
  ['admins_required', 'admin', false, 'mfa_required'],
  ['admins_required', 'admin', true, 'passes'],
  ['admins_required', 'manager', false, 'passes'],
  ['admins_required', 'staff', false, 'passes'],
  ['admins_required', 'viewer', false, 'passes'],
  ['all_required', 'owner', false, 'mfa_required'],
  ['all_required', 'admin', false, 'mfa_required'],
  ['all_required', 'manager', false, 'mfa_required'],
  ['all_required', 'staff', false, 'mfa_required'],
  ['all_required', 'viewer', false, 'mfa_required'],
  ['all_required', 'owner', true, 'passes'],
  ['all_required', 'staff', true, 'passes'],
  ['all_required', 'viewer', true, 'passes'],
];

describe.each(PATHS)('withApiContext (%s): sessions at aal2', (path) => {
  it.each(AAL2_ROWS)('%s, %s, authenticator %s -> %s', async (policy, role, authenticator, expected) => {
    const s: Session = { policy, role, authenticator, aal: 'aal2' };
    for (const read of READS) {
      expect((await apiAnswer(path, read, s)).answer, read).toBe(expected);
    }
    expect((await pageAnswer(s)).answer).toBe(expected);
  });
});

/**
 * The routes that build their own principal from the cookie session (the
 * accounting connection returns) take the authenticator state from
 * cookieSessionMfaState. For every session shape it is the state the pages
 * resolve from the same rows, so the gate gives them the same answer.
 */
describe('cookieSessionMfaState answers as the pages do', () => {
  it.each(SESSIONS.map((s) => [label(s), s] as const))('%s', async (_name, s) => {
    const page = await pageAnswer(s);
    arrange(s, 'separate reads');
    const client = makeClient();
    const {
      data: { user },
    } = await client.auth.getUser();
    const own = await cookieSessionMfaState(client, user, ORG_ID, s.role);
    expect(own).toEqual({
      mfaRequired: page.ctx.mfaRequired,
      mfaSatisfied: page.ctx.mfaSatisfied,
      mfaEnrolled: page.ctx.mfaEnrolled,
    });
    expect(gate({ ...page.ctx, ...own })).toBe(page.answer);
  });
});

/**
 * Setting up a first authenticator stays reachable. On the web it is the
 * security settings page and its Server Actions, which ask for a signed-in
 * session and not for this gate; the phone sets none up. The API routes a member
 * uses before the code (the reviewed allowlist) ask no permission, so the gate's
 * answer never reaches them.
 */
describe('setting up an authenticator does not pass through the gate', () => {
  const APP = join(__dirname, '..', '..');
  const source = (p: string) => readFileSync(join(APP, p), 'utf8');

  it('the enrolment Server Actions ask for a session, not a permission', () => {
    const actions = source('server/actions/mfa.ts');
    for (const name of ['enrollFactorAction', 'verifyEnrollmentAction']) {
      const start = actions.indexOf(`export async function ${name}(`);
      expect(start, name).toBeGreaterThan(-1);
      const next = actions.indexOf('\nexport async function ', start + 1);
      const body = actions.slice(start, next === -1 ? undefined : next);
      expect(body, name).toContain('requireSession()');
      expect(body, name).not.toMatch(/withContext\(|withApiContext\(|assertPermission\(|assertAnyPermission\(/);
    }
  });

  it('the routes allowed before the code ask no permission', () => {
    for (const route of [
      'app/api/client-error/route.ts',
      'app/api/v1/auth/signed-in/route.ts',
      'app/api/v1/auth/signed-out/route.ts',
    ]) {
      const body = source(route);
      expect(body, route).toContain('allowStepUpPending');
      expect(body, route).not.toMatch(/assertPermission\(|assertAnyPermission\(|mfaSatisfied|mfaRequired/);
    }
  });

  it('a member who must set one up is still served by the routes allowed before the code', async () => {
    for (const path of PATHS) {
      for (const read of READS) {
        const s: Session = { policy: 'all_required', role: 'staff', authenticator: false, aal: 'aal2' };
        const { ctx } = await apiAnswer(path, read, s, true);
        expect(ctx?.userId, `${path}, ${read}`).toBe(USER_ID);
      }
    }
  });
});
