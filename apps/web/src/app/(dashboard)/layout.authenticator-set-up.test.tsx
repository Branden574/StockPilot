import type { ReactElement, ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The dashboard layout and a member who must set up an authenticator first
 * (their organization's policy requires one of their role and they have none
 * verified: everyone under all_required, owners and admins under
 * admins_required).
 *
 * THE LAYOUT NEVER REDIRECTS FOR IT. A layout that redirects to a page under
 * itself is kept by the browser after a client-side navigation and replayed
 * on the way to that page (a blank page, the address replaced again and
 * again). The page below sends the member to set-up (requireOrgContext(),
 * lib/auth/session.authenticator-set-up.test.ts). The layout shows the banner
 * on every page for such a member, and renders the page itself, except for the
 * one session the pages cannot see: a token that still says aal2 although the
 * member's own factor list has no verified factor. On a page that is not open
 * before set-up, that session gets the set-up panel in place of the page.
 *
 * A POLICY THAT WAS NOT READ (the organization row came back empty, or with a
 * value that is not a policy) is held to the strictest policy, but whether
 * set-up is owed is not known. A member with no verified authenticator then
 * gets the "couldn't check your access" strip instead of the set-up banner,
 * and never the set-up panel; the pages give their own could-not-check card
 * (requireOrgContext(), lib/auth/session.authenticator-set-up.test.ts).
 */

type Role = 'owner' | 'admin' | 'manager' | 'staff' | 'viewer';
type Policy = 'optional' | 'admins_required' | 'all_required';

const MEMBER = 'u-1';

const state = vi.hoisted(() => ({
  pathname: '/dashboard' as string | null,
  role: 'owner' as string,
  // null: the organization row came back empty (row level security hid it).
  orgRow: { mfa_policy: 'admins_required' } as { mfa_policy: string } | null,
  factors: [] as Array<{ status: string }>,
  aal: 'aal1' as 'aal1' | 'aal2',
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
vi.mock('@/components/dashboard/access-unchecked-banner', () => ({
  AccessUncheckedBanner: function AccessUncheckedBanner() {
    return null;
  },
}));
vi.mock('@/components/dashboard/authenticator-set-up-panel', () => ({
  AuthenticatorSetUpPanel: function AuthenticatorSetUpPanel() {
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
  requireOrgContextForLayout: async () => ({
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
vi.mock('@/lib/auth/verified-claims', () => ({
  getVerifiedSessionClaimsForRequest: async () => ({ userId: MEMBER, aal: state.aal }),
}));
vi.mock('@/lib/auth/warehouse', () => ({
  getWarehouseAccessFor: async () => ({ hasAllAccess: true, readableIds: ['wh-1'] }),
}));
vi.mock('@/lib/warehouse-filter', () => ({ getActiveWarehouseFilterFor: async () => null }));

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

type RowState = Policy | 'unreadable' | 'not a policy';

function as(
  role: Role,
  policy: RowState,
  opts: { factors?: Array<{ status: string }>; path?: string | null; aal?: 'aal1' | 'aal2' } = {},
) {
  state.role = role;
  state.orgRow =
    policy === 'unreadable'
      ? null
      : { mfa_policy: policy === 'not a policy' ? 'not_a_policy' : policy };
  state.factors = opts.factors ?? [];
  state.pathname = opts.path === undefined ? '/dashboard' : opts.path;
  // A verified factor: the code was entered. None: an ordinary aal1 session.
  state.aal = opts.aal ?? (state.factors.some((f) => f.status === 'verified') ? 'aal2' : 'aal1');
}

type Outcome =
  | { kind: 'redirect'; to: string }
  | { kind: 'page'; banner: boolean; unchecked: boolean; shows: 'page' | 'set-up panel' };

function PageBelow() {
  return null;
}

async function load(): Promise<Outcome> {
  try {
    const tree = await DashboardLayout({ children: <PageBelow /> });
    expect(findByTypeName(tree, 'DashboardShell')).not.toBeNull();
    const page = findByTypeName(tree, 'PageBelow') !== null;
    const panel = findByTypeName(tree, 'AuthenticatorSetUpPanel') !== null;
    expect(page !== panel, 'the page or the panel, never both').toBe(true);
    return {
      kind: 'page',
      banner: findByTypeName(tree, 'MfaRequiredBanner') !== null,
      unchecked: findByTypeName(tree, 'AccessUncheckedBanner') !== null,
      shows: panel ? 'set-up panel' : 'page',
    };
  } catch (e) {
    const m = /^redirect:(.*)$/.exec(String((e as Error).message));
    if (!m) throw e;
    return { kind: 'redirect', to: m[1]! };
  }
}

const PAGE = { kind: 'page', banner: false, unchecked: false, shows: 'page' } as const;
const PAGE_WITH_BANNER = { kind: 'page', banner: true, unchecked: false, shows: 'page' } as const;
const PANEL = { kind: 'page', banner: true, unchecked: false, shows: 'set-up panel' } as const;
/** A policy that was not read, no verified authenticator: the could-not-check strip, the page. */
const PAGE_UNCHECKED = { kind: 'page', banner: false, unchecked: true, shows: 'page' } as const;

const CLOSED = [
  '/dashboard',
  '/dashboard/team',
  '/dashboard/settings/integrations',
  '/dashboard/inventory',
];
const CLOSED_LOOKALIKES = ['/dashboard/settings/security-keys', '/dashboard/settings/profile-old'];
const OPEN = ['/dashboard/settings/security', '/dashboard/settings/profile'];
const ALL_ROLES: Role[] = ['owner', 'admin', 'manager', 'staff', 'viewer'];
const POLICIES: RowState[] = [
  'optional',
  'admins_required',
  'all_required',
  'unreadable',
  'not a policy',
];
const unread = (policy: RowState) => policy === 'unreadable' || policy === 'not a policy';
const owes = (policy: RowState, role: Role) =>
  policy === 'all_required' ||
  (policy === 'admins_required' && (role === 'owner' || role === 'admin'));
/** A member with no verified authenticator: what the layout shows above (or in place of) the page. */
const noAuthenticator = (policy: RowState, role: Role) =>
  unread(policy) ? PAGE_UNCHECKED : owes(policy, role) ? PAGE_WITH_BANNER : PAGE;
const MATRIX = POLICIES.flatMap((p) => ALL_ROLES.map((r) => [p, r] as const));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the layout never redirects for set-up', () => {
  it.each(MATRIX)(
    '%s, %s with no authenticator: the page, on every path, never a redirect',
    async (policy, role) => {
      for (const path of [...CLOSED, ...CLOSED_LOOKALIKES, ...OPEN, null]) {
        as(role, policy, { path });
        expect(await load(), String(path)).toEqual(noAuthenticator(policy, role));
      }
      expect(redirect).not.toHaveBeenCalled();
    },
  );

  it.each(MATRIX)(
    '%s, %s whose only factor is not verified: the same as none',
    async (policy, role) => {
      as(role, policy, { factors: [{ status: 'unverified' }], path: '/dashboard/team' });
      expect(await load()).toEqual(noAuthenticator(policy, role));
      expect(redirect).not.toHaveBeenCalled();
    },
  );

  it.each(MATRIX)(
    '%s, %s with a verified authenticator at aal2: the page, no banner',
    async (policy, role) => {
      as(role, policy, { factors: [{ status: 'verified' }], path: '/dashboard/team' });
      expect(await load()).toEqual(PAGE);
    },
  );
});

describe('a token that says aal2 while the member has no verified factor', () => {
  it.each(MATRIX)(
    '%s, %s on a page not open before set-up: the set-up panel when set-up is owed, never for a policy that was not read',
    async (policy, role) => {
      for (const path of [...CLOSED, ...CLOSED_LOOKALIKES]) {
        as(role, policy, { path, aal: 'aal2' });
        expect(await load(), path).toEqual(
          unread(policy) ? PAGE_UNCHECKED : owes(policy, role) ? PANEL : PAGE,
        );
      }
      expect(redirect).not.toHaveBeenCalled();
    },
  );

  it.each(MATRIX)('%s, %s on an open page: the page', async (policy, role) => {
    for (const path of OPEN) {
      as(role, policy, { path, aal: 'aal2' });
      expect(await load(), path).toEqual(noAuthenticator(policy, role));
    }
  });

  it('with no path header: the panel (fails closed), never a redirect', async () => {
    as('admin', 'admins_required', { path: null, aal: 'aal2' });
    expect(await load()).toEqual(PANEL);
    expect(redirect).not.toHaveBeenCalled();
  });
});
