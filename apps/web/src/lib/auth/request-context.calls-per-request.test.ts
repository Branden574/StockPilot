import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * get_request_context() is asked ONCE per page load, and AGAIN on every new
 * request.
 *
 * Every signed-in page load and Server Action resolves the request context
 * through this one call (migration 0355). Within one page load the dashboard
 * layout and the page below it ask for the context, the organization row, the
 * module set, the membership list and the session from a dozen places; React
 * `cache()` shares one answer between them. Across requests nothing is
 * shared: a role change, a removal or a permission override must take effect
 * on the very next request.
 *
 * Inside a real render `cache()` shares one answer per request. Outside one
 * (as here) it does not memoize at all, which is also what a Server Action
 * gets. Both are modelled below: `newPageLoad()` starts a render pass whose
 * cache()d functions keep one answer per argument list, and `serverAction()`
 * runs with no render pass, so nothing is kept. Everything from session.ts
 * down (the bundle parser, request-cache, the code gate, withContext) is the
 * real code; only the network is faked, and it counts.
 */

const pass = vi.hoisted(() => ({
  render: false,
  memo: new Map<unknown, Map<string, unknown>>(),
}));
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    cache:
      <A extends unknown[], R>(fn: (...args: A) => R) =>
      (...args: A): R => {
        if (!pass.render) return fn(...args);
        let byArgs = pass.memo.get(fn);
        if (!byArgs) pass.memo.set(fn, (byArgs = new Map()));
        const key = JSON.stringify(args);
        if (!byArgs.has(key)) byArgs.set(key, fn(...args));
        return byArgs.get(key) as R;
      },
  };
});
const newPageLoad = () => {
  pass.render = true;
  pass.memo.clear();
};
const serverAction = () => {
  pass.render = false;
  pass.memo.clear();
};

vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
}));
vi.mock('next/headers', () => ({
  headers: vi.fn(
    async () =>
      new Headers({
        'x-stockpilot-user-id': 'u1',
        'x-stockpilot-user-email': 'u1@example.com',
        'x-pathname': '/dashboard/inventory',
      }),
  ),
  cookies: vi.fn(async () => ({ get: () => undefined, getAll: () => [], set: () => {} })),
}));

type Role = 'owner' | 'admin' | 'manager' | 'staff' | 'viewer';

/** What the database holds for u1 right now. Changed between requests by the tests. */
const db = {
  memberships: [] as Array<{
    organization_id: string;
    role: Role;
    user_overrides: Array<{ permission: string; granted: boolean }>;
  }>,
};
const calls = { rpc: 0, from: [] as string[] };

const orgRow = (id: string) => ({
  id,
  name: `Org ${id}`,
  logo_url: null,
  terminology: null,
  mfa_policy: 'optional' as const,
  timezone: 'UTC',
  nav_overrides: null,
  dashboard_layout: null,
  order_status_config: null,
  all_modules_comp: false,
  order_catalog_last_hide_at: null,
});

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    rpc: async (fn: string) => {
      if (fn !== 'get_request_context') {
        return { data: null, error: { code: 'PGRST202', message: 'not found' } };
      }
      calls.rpc += 1;
      // Read from `db` at call time: the answer is never older than the call.
      return {
        error: null,
        data: {
          user_id: 'u1',
          profile: {
            id: 'u1',
            email: 'u1@example.com',
            full_name: 'Una One',
            avatar_url: null,
            default_organization_id: 'A',
            disabled_at: null,
          },
          memberships: db.memberships.map((m) => ({
            organization_id: m.organization_id,
            role: m.role,
            organization: orgRow(m.organization_id),
            role_overrides: [],
            user_overrides: m.user_overrides,
            enabled_modules: ['orders'],
          })),
        },
      };
    },
    // Any table read means a reader went around the bundle.
    from: (table: string) => {
      calls.from.push(table);
      throw new Error(`unexpected table read: ${table}`);
    },
    auth: {
      getClaims: async () => ({ data: { claims: { sub: 'u1', aal: 'aal1' } }, error: null }),
      getSession: async () => ({
        data: { session: { access_token: 'stored.token' } },
        error: null,
      }),
      getUser: async () => ({ data: { user: { id: 'u1', factors: [] } }, error: null }),
    },
  }),
}));

import { getModulesForRequest, getOrgRowForRequest } from '@/lib/dashboard/request-cache';
import {
  authenticatorSetUpOwedForLayout,
  getServerSession,
  getSessionMemberships,
  readSessionMemberships,
  readSessionOrganization,
  requireOrgContext,
  requireOrgContextForLayout,
  requireSession,
} from '@/lib/auth/session';
import { loadRequestContextBundle } from '@/lib/auth/request-context-bundle';
import { withContext } from '@/server/services/context';

/**
 * What one dashboard page load asks for: the layout's reads
 * (app/(dashboard)/layout.tsx) alongside the page's, started together as the
 * framework renders them.
 */
async function renderDashboardPage() {
  const layout = (async () => {
    const ctx = await requireOrgContextForLayout();
    await Promise.all([
      getOrgRowForRequest(ctx.organizationId),
      getSessionMemberships(),
      getModulesForRequest(ctx.organizationId),
      authenticatorSetUpOwedForLayout(),
    ]);
    return ctx;
  })();
  const page = (async () => {
    const ctx = await requireOrgContext();
    const [svc] = await Promise.all([
      withContext(),
      getServerSession(),
      requireSession(),
      readSessionOrganization(),
      readSessionMemberships(),
      loadRequestContextBundle(),
      getOrgRowForRequest(ctx.organizationId),
      getModulesForRequest(ctx.organizationId),
    ]);
    return { ctx, svc };
  })();
  const [layoutCtx, { ctx, svc }] = await Promise.all([layout, page]);
  return { layoutCtx, ctx, svc };
}

beforeEach(() => {
  db.memberships = [{ organization_id: 'A', role: 'manager', user_overrides: [] }];
  calls.rpc = 0;
  calls.from = [];
  pass.render = false;
  pass.memo.clear();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('one page load', () => {
  it('asks get_request_context() once for the layout and the page together, and reads no table', async () => {
    newPageLoad();
    const { layoutCtx, ctx, svc } = await renderDashboardPage();
    expect(calls.rpc).toBe(1);
    expect(calls.from).toEqual([]);
    expect(layoutCtx.organizationId).toBe('A');
    expect(ctx.role).toBe('manager');
    expect(svc.role).toBe('manager');
    expect([...svc.enabledModules]).toEqual(['orders']);
  });

  it('asks again on the next page load: one call per load, never shared between loads', async () => {
    newPageLoad();
    await renderDashboardPage();
    newPageLoad();
    await renderDashboardPage();
    newPageLoad();
    await renderDashboardPage();
    expect(calls.rpc).toBe(3);
  });
});

describe('a change takes effect on the very next request', () => {
  it('a role change', async () => {
    newPageLoad();
    expect((await renderDashboardPage()).ctx.role).toBe('manager');
    db.memberships[0]!.role = 'viewer';
    newPageLoad();
    const next = await renderDashboardPage();
    expect(next.ctx.role).toBe('viewer');
    expect(next.svc.role).toBe('viewer');
    expect(next.ctx.permissions?.has('items:create' as never)).toBe(false);
  });

  it('a permission override', async () => {
    newPageLoad();
    expect((await renderDashboardPage()).ctx.permissions?.has('items:create' as never)).toBe(true);
    db.memberships[0]!.user_overrides = [{ permission: 'items:create', granted: false }];
    newPageLoad();
    expect((await renderDashboardPage()).ctx.permissions?.has('items:create' as never)).toBe(false);
  });

  it('a removal from the organization', async () => {
    newPageLoad();
    await renderDashboardPage();
    db.memberships = [];
    newPageLoad();
    await expect(requireOrgContext()).rejects.toThrow('REDIRECT:/onboarding');
    expect(calls.rpc).toBe(2);
  });

  it('in Server Actions too: each action asks afresh', async () => {
    serverAction();
    expect((await withContext()).role).toBe('manager');
    expect(calls.rpc).toBe(1);
    db.memberships[0]!.role = 'staff';
    serverAction();
    expect((await withContext()).role).toBe('staff');
    expect(calls.rpc).toBe(2);
    expect(calls.from).toEqual([]);
  });
});
