import type { ReactElement, ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The dashboard layout sends a member whose organization requires an
 * authenticator FOR THEM, and who has no verified one, to set-up first.
 *
 * Who must have one is the member's own requirement: everyone under
 * all_required, owners and admins under admins_required, no one under
 * optional. An organization row that came back empty is held to the strictest
 * policy (lib/auth/mfa-policy.ts).
 *
 * This is the full-page-load half of the rule; requireOrgContext() applies it
 * to each page by itself and to Server Actions
 * (lib/auth/session.authenticator-set-up.test.ts).
 *
 * The security page and the profile page are open before set-up (exactly, or
 * below them after a slash), so the redirect lands on a page the layout lets
 * through: one redirect, never a second one from the page it sends to. That is
 * what keeps the browser out of a redirect loop (Chrome stops a page that
 * navigates in a loop with "Throttling navigation to prevent the browser from
 * hanging"). The proxy sets the path header on every request it handles; with
 * no header the layout sends the member to set-up on every request.
 */

type Role = 'owner' | 'admin' | 'manager' | 'staff' | 'viewer';
type Policy = 'optional' | 'admins_required' | 'all_required';

const MEMBER = 'u-1';
const SET_UP = '/dashboard/settings/security?enroll=1';

const state = vi.hoisted(() => ({
  pathname: '/dashboard' as string | null,
  role: 'owner' as string,
  // null: the organization row came back empty (row level security hid it).
  orgRow: { mfa_policy: 'admins_required' } as { mfa_policy: string } | null,
  factors: [] as Array<{ status: string }>,
}));

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers(state.pathname === null ? {} : { 'x-pathname': state.pathname }),
}));
vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`redirect:${url}`);
  }),
}));

vi.mock('@/components/dashboard/dashboard-shell', () => ({
  DashboardShell: function DashboardShell({ children }: { children: ReactNode }) {
    return children;
  },
}));
vi.mock('@/components/dashboard/mfa-required-banner', () => ({
  MfaRequiredBanner: function MfaRequiredBanner() {
    return null;
  },
}));
vi.mock('@/components/dashboard/modules-unread-banner', () => ({
  ModulesUnreadBanner: () => null,
}));
vi.mock('@/components/platform/impersonation-banner', () => ({ ImpersonationBanner: () => null }));
vi.mock('@/components/realtime/inventory-realtime', () => ({ InventoryRealtime: () => null }));
vi.mock('@/components/activity-beacon', () => ({ ActivityBeacon: () => null }));

vi.mock('@/lib/auth/platform-admin', () => ({
  currentUserIsPlatformAdminFromRequestHeader: async () => false,
}));
vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: async () => ({
    organizationId: 'org-1',
    organizationName: 'Example Org',
    userId: MEMBER,
    email: 'member@example.com',
    fullName: 'Pat Example',
    avatarUrl: null,
    role: state.role,
    permissions: new Set<string>(),
  }),
  getSessionMemberships: async () => [
    { organizationId: 'org-1', name: 'Example Org', logoUrl: null, role: state.role },
  ],
}));
vi.mock('@/lib/dashboard/request-cache', () => ({
  getOrgRowForRequest: async () =>
    state.orgRow === null
      ? null
      : {
          ...state.orgRow,
          logo_url: null,
          terminology: null,
          nav_overrides: null,
          order_status_config: null,
        },
  getMfaFactorsForRequest: async () => ({ userId: MEMBER, factors: state.factors }),
  getWarehousesForRequest: async () => [{ id: 'wh-1', name: 'Main' }],
  getModulesForRequest: async () => new Set<string>(),
}));
// A member with a verified factor has shown their code in this session.
vi.mock('@/lib/auth/verified-claims', () => ({
  getVerifiedSessionClaimsForRequest: async () => ({ userId: MEMBER, aal: 'aal2' }),
}));
vi.mock('@/lib/auth/warehouse', () => ({
  getWarehouseAccess: async () => ({ hasAllAccess: true, readableIds: ['wh-1'] }),
}));
vi.mock('@/lib/warehouse-filter', () => ({ getActiveWarehouseFilter: async () => null }));

import DashboardLayout from './layout';

type AnyElement = ReactElement<Record<string, unknown>>;

function findByTypeName(node: unknown, name: string): AnyElement | null {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findByTypeName(child, name);
      if (hit) return hit;
    }
    return null;
  }
  const el = node as AnyElement;
  const type = el.type as { name?: string } | string | undefined;
  if (typeof type === 'function' && (type as { name?: string }).name === name) return el;
  return findByTypeName(el.props?.children, name);
}

function as(
  role: Role,
  policy: Policy | 'unreadable',
  opts: { factors?: Array<{ status: string }>; path?: string | null } = {},
) {
  state.role = role;
  state.orgRow = policy === 'unreadable' ? null : { mfa_policy: policy };
  state.factors = opts.factors ?? [];
  state.pathname = opts.path === undefined ? '/dashboard' : opts.path;
}

type Outcome = { kind: 'redirect'; to: string } | { kind: 'page'; banner: boolean };

async function load(): Promise<Outcome> {
  try {
    const tree = await DashboardLayout({ children: null });
    expect(findByTypeName(tree, 'DashboardShell')).not.toBeNull();
    return { kind: 'page', banner: findByTypeName(tree, 'MfaRequiredBanner') !== null };
  } catch (e) {
    const m = /^redirect:(.*)$/.exec(String((e as Error).message));
    if (!m) throw e;
    return { kind: 'redirect', to: m[1]! };
  }
}

/** Load the page, then follow where it sends the member, as a browser does. */
async function loadAndFollow(): Promise<string[]> {
  const hops: string[] = [];
  for (let i = 0; i < 5; i++) {
    const out = await load();
    if (out.kind === 'page') return hops;
    hops.push(out.to);
    state.pathname = new URL(out.to, 'https://example.test').pathname;
  }
  return hops;
}

const DEEP_PAGES = ['/dashboard/team', '/dashboard/settings/integrations', '/dashboard/inventory'];
const SET_UP_PAGES = ['/dashboard/settings/security', '/dashboard/settings/profile'];
const NOT_OPEN = ['/dashboard/settings/security-keys', '/dashboard/settings/profile-old'];
const ALL_ROLES: Role[] = ['owner', 'admin', 'manager', 'staff', 'viewer'];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('admins_required: an owner or admin with no verified authenticator', () => {
  it.each(['owner', 'admin'] as const)('%s: sent to set-up from /dashboard', async (role) => {
    as(role, 'admins_required');
    expect(await load()).toEqual({ kind: 'redirect', to: SET_UP });
    expect(redirect).toHaveBeenCalledTimes(1);
  });

  it.each((['owner', 'admin'] as const).flatMap((r) => DEEP_PAGES.map((p) => [r, p] as const)))(
    '%s: sent to set-up from %s',
    async (role, path) => {
      as(role, 'admins_required', { path });
      expect(await load()).toEqual({ kind: 'redirect', to: SET_UP });
      expect(redirect).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['owner', 'admin'] as const)(
    '%s whose only factor is not verified: sent to set-up',
    async (role) => {
      as(role, 'admins_required', { factors: [{ status: 'unverified' }] });
      expect(await load()).toEqual({ kind: 'redirect', to: SET_UP });
    },
  );

  it.each((['owner', 'admin'] as const).flatMap((r) => SET_UP_PAGES.map((p) => [r, p] as const)))(
    '%s already on %s: gets the page with the banner and is not sent anywhere',
    async (role, path) => {
      as(role, 'admins_required', { path });
      expect(await load()).toEqual({ kind: 'page', banner: true });
      expect(redirect).not.toHaveBeenCalled();
    },
  );

  it.each(['owner', 'admin'] as const)(
    '%s: sent exactly once, the set-up page does not send them on again',
    async (role) => {
      as(role, 'admins_required', { path: '/dashboard/team' });
      expect(await loadAndFollow()).toEqual([SET_UP]);
      expect(redirect).toHaveBeenCalledTimes(1);
    },
  );

  it.each(NOT_OPEN)('%s is not open before set-up: an admin is sent to set-up', async (path) => {
    as('admin', 'admins_required', { path });
    expect(await load()).toEqual({ kind: 'redirect', to: SET_UP });
  });

  it('with no path header on any request, the admin is sent to set-up every time: it fails closed', async () => {
    for (let i = 0; i < 3; i++) {
      as('admin', 'admins_required', { path: null });
      expect(await load()).toEqual({ kind: 'redirect', to: SET_UP });
    }
    expect(redirect).toHaveBeenCalledTimes(3);
  });
});

describe('admins_required: everyone else is not affected', () => {
  it.each(
    (['manager', 'staff', 'viewer'] as const).flatMap((r) =>
      ['/dashboard', ...DEEP_PAGES].map((p) => [r, p] as const),
    ),
  )('%s with no authenticator: gets %s as before, with no banner', async (role, path) => {
    as(role, 'admins_required', { path });
    expect(await load()).toEqual({ kind: 'page', banner: false });
    expect(redirect).not.toHaveBeenCalled();
  });

  it.each(ALL_ROLES)('%s with a verified authenticator: gets the page', async (role) => {
    as(role, 'admins_required', { factors: [{ status: 'verified' }], path: '/dashboard/team' });
    expect(await load()).toEqual({ kind: 'page', banner: false });
    expect(redirect).not.toHaveBeenCalled();
  });
});

describe('all_required: unchanged for every role', () => {
  it.each(ALL_ROLES.flatMap((r) => ['/dashboard', ...DEEP_PAGES].map((p) => [r, p] as const)))(
    '%s with no authenticator: sent to set-up from %s, once',
    async (role, path) => {
      as(role, 'all_required', { path });
      expect(await loadAndFollow()).toEqual([SET_UP]);
      expect(redirect).toHaveBeenCalledTimes(1);
    },
  );

  it.each(ALL_ROLES)(
    '%s with no authenticator: gets the set-up page with the banner',
    async (role) => {
      as(role, 'all_required', { path: '/dashboard/settings/security' });
      expect(await load()).toEqual({ kind: 'page', banner: true });
      expect(redirect).not.toHaveBeenCalled();
    },
  );

  it.each(ALL_ROLES)('%s with a verified authenticator: gets the page', async (role) => {
    as(role, 'all_required', { factors: [{ status: 'verified' }], path: '/dashboard/team' });
    expect(await load()).toEqual({ kind: 'page', banner: false });
  });
});

describe('optional: unchanged', () => {
  it.each(ALL_ROLES)('%s with no authenticator: gets the page, with no banner', async (role) => {
    as(role, 'optional', { path: '/dashboard/team' });
    expect(await load()).toEqual({ kind: 'page', banner: false });
    expect(redirect).not.toHaveBeenCalled();
  });
});

describe('an organization row that came back empty: unchanged, held to the strictest policy', () => {
  it.each(ALL_ROLES)('%s with no authenticator: sent to set-up, once', async (role) => {
    as(role, 'unreadable', { path: '/dashboard/team' });
    expect(await loadAndFollow()).toEqual([SET_UP]);
    expect(redirect).toHaveBeenCalledTimes(1);
  });

  it.each(ALL_ROLES)('%s with no authenticator: gets the set-up page itself', async (role) => {
    as(role, 'unreadable', { path: '/dashboard/settings/security' });
    expect(await load()).toEqual({ kind: 'page', banner: true });
  });
});
