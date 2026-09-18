import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Which modules does an API request get?
 *
 * The dashboard has always honoured `organizations.all_modules_comp` (the
 * platform console's "Comped: all modules", which writes NO organization_modules
 * rows). The API context read the rows alone, so a comped organization with no
 * rows had every module on the web and none through /api/v1: module-gated routes
 * refused it and the mobile snapshot, which drives the app's navigation, listed
 * nothing. Both contexts now resolve through lib/modules/effective-modules. This
 * pins the API side on BOTH auth paths.
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
  loadEffectivePermissions: async () => new Set<string>(),
}));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => refs.client }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => refs.client }));

import { NON_CORE_MODULE_IDS } from '@/lib/modules/effective-modules';

import { withApiContext } from './api-context';

const USER_ID = '99999999-9999-9999-9999-999999999999';
const ORG_ID = '88888888-8888-8888-8888-888888888888';

const state = {
  comped: false as boolean | null,
  moduleRows: [] as Array<{ module_id: string }>,
  orgError: null as { message: string } | null,
  modulesError: null as { message: string } | null,
};

function table(single: unknown, list: unknown[] = [], error: unknown = null) {
  const q: Record<string, unknown> = {};
  const self = () => q;
  for (const k of ['select', 'eq', 'is', 'not', 'in', 'limit', 'order']) q[k] = self;
  q.maybeSingle = async () => ({ data: error ? null : single, error });
  q.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve({ data: error ? null : list, error }).then(resolve);
  return q;
}

function makeClient() {
  return {
    from: (name: string) => {
      if (name === 'organizations')
        return table(
          { mfa_policy: 'optional', all_modules_comp: state.comped },
          [],
          state.orgError,
        );
      if (name === 'organization_members') return table({ organization_id: ORG_ID, role: 'staff' });
      if (name === 'user_profiles')
        return table({
          id: USER_ID,
          email: 'user@example.com',
          default_organization_id: ORG_ID,
          disabled_at: null,
        });
      if (name === 'organization_modules') return table(null, state.moduleRows, state.modulesError);
      return table(null, []);
    },
    auth: {
      getUser: async () => ({
        data: { user: { id: USER_ID, email: 'user@example.com', factors: [] } },
        error: null,
      }),
      mfa: {
        getAuthenticatorAssuranceLevel: async () => ({
          data: { currentLevel: 'aal1', nextLevel: 'aal1' },
          error: null,
        }),
      },
    },
  };
}

const seg = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
const bearer = () =>
  new Request('https://app.test/api/v1/mobile/snapshot', {
    headers: {
      authorization: `Bearer ${seg({ alg: 'HS256', typ: 'JWT' })}.${seg({ sub: USER_ID })}.sig`,
      'x-organization-id': ORG_ID,
    },
  });
const cookie = () =>
  new Request('https://app.test/api/v1/me/releases', {
    headers: { cookie: 'sb-example-auth-token=abc' },
  });

beforeEach(() => {
  state.comped = false;
  state.moduleRows = [];
  state.orgError = null;
  state.modulesError = null;
  refs.client = makeClient();
});

describe.each([
  ['BEARER (the mobile app)', bearer],
  ['COOKIE (the web app calling /api/v1)', cookie],
])('withApiContext modules: %s', (_label, request) => {
  it('a COMPED organization with no rows gets every non-core module', async () => {
    state.comped = true;
    const ctx = await withApiContext(request());
    expect(ctx).not.toBeNull();
    for (const id of NON_CORE_MODULE_IDS) expect(ctx!.enabledModules!.has(id)).toBe(true);
  });

  it('an organization that is not comped gets its explicit rows and nothing else', async () => {
    state.moduleRows = [{ module_id: 'orders' }];
    const ctx = await withApiContext(request());
    expect([...ctx!.enabledModules!]).toEqual(['orders']);
  });

  it('a NULL comp flag grants nothing: only an explicit true is a comp', async () => {
    state.comped = null;
    state.moduleRows = [{ module_id: 'orders' }];
    const ctx = await withApiContext(request());
    expect([...ctx!.enabledModules!]).toEqual(['orders']);
  });

  it('an UNREADABLE comp flag grants nothing: it falls back to the rows', async () => {
    state.comped = true;
    state.orgError = { message: 'upstream timeout' };
    state.moduleRows = [{ module_id: 'orders' }];
    const ctx = await withApiContext(request());
    expect(ctx).not.toBeNull();
    expect([...ctx!.enabledModules!]).toEqual(['orders']);
  });

  it('a failed rows read is not a reason to withhold the comp', async () => {
    state.comped = true;
    state.modulesError = { message: 'upstream timeout' };
    const ctx = await withApiContext(request());
    expect(ctx!.enabledModules!.size).toBe(NON_CORE_MODULE_IDS.length);
  });
});
