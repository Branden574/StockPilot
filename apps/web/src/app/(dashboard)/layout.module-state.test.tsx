import type { ReactElement, ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub, type SupabaseStub } from '@/test/supabase-mock';
import { MODULE_REGISTRY, type ModuleId } from '@stockpilot/core';

/**
 * The dashboard layout and an organization's module state.
 *
 * The layout hands the shell the list of modules that are on, which draws the
 * menu. When the organization's module rows could not be read, that list is
 * not known. The layout then hands over only what is known to be on (the core
 * sections draw whatever the list holds) and shows a strip that says the
 * modules could not be checked, with Try again. A state that was read draws
 * the menu exactly as before, with no strip.
 *
 * The module readers of lib/dashboard/request-cache are real here; only the
 * network is a stub.
 */

const holder = vi.hoisted(() => ({ stub: null as SupabaseStub | null }));

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers({ 'x-pathname': '/dashboard' }),
}));
vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`redirect:${url}`);
  }),
}));

vi.mock('@/components/dashboard/dashboard-shell', () => ({
  DashboardShell: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('@/components/dashboard/mfa-required-banner', () => ({ MfaRequiredBanner: () => null }));
vi.mock('@/components/platform/impersonation-banner', () => ({ ImpersonationBanner: () => null }));
vi.mock('@/components/realtime/inventory-realtime', () => ({ InventoryRealtime: () => null }));
vi.mock('@/components/activity-beacon', () => ({ ActivityBeacon: () => null }));

vi.mock('@/lib/auth/platform-admin', () => ({
  currentUserIsPlatformAdminFromRequestHeader: async () => false,
}));
vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: async () => ({
    organizationId: 'org-1',
    organizationName: 'Org One',
    userId: 'u1',
    email: 'a@b.com',
    fullName: 'Ann Example',
    avatarUrl: null,
    role: 'owner',
    permissions: new Set<string>(),
  }),
  getSessionMemberships: async () => [
    { organizationId: 'org-1', name: 'Org One', logoUrl: null, role: 'owner' },
  ],
}));
// The one-round-trip context read gave no usable answer: the readers take
// their own reads.
vi.mock('@/lib/auth/request-context-bundle', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/request-context-bundle')>()),
  loadRequestContextBundle: vi.fn(async () => null),
}));
vi.mock('@/lib/dashboard/request-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/dashboard/request-cache')>()),
  getMfaFactorsForRequest: async () => ({ userId: 'u1', factors: [] }),
  getWarehousesForRequest: async () => [{ id: 'wh-1', name: 'Main' }],
}));
vi.mock('@/lib/auth/verified-claims', () => ({
  getVerifiedSessionClaimsForRequest: async () => ({ userId: 'u1', aal: 'aal1' }),
}));
vi.mock('@/lib/auth/warehouse', () => ({
  getWarehouseAccess: async () => ({ hasAllAccess: true, readableIds: ['wh-1'] }),
}));
vi.mock('@/lib/warehouse-filter', () => ({ getActiveWarehouseFilter: async () => null }));
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => holder.stub!.client),
}));

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

const NON_CORE = (Object.keys(MODULE_REGISTRY) as ModuleId[]).filter(
  (m) => MODULE_REGISTRY[m].tier !== 'core',
);
const ORG_ROW = (comp: boolean) => ({
  terminology: null,
  mfa_policy: 'optional',
  logo_url: null,
  timezone: 'America/Los_Angeles',
  nav_overrides: null,
  dashboard_layout: null,
  order_status_config: null,
  all_modules_comp: comp,
});
const ROWS_FAILED = { data: null, error: { message: 'upstream timeout', code: '57014' } };

function reads(rows: { data: unknown; error: unknown }, comp = false) {
  holder.stub = makeSupabaseStub({
    'organization_modules.select': rows as never,
    'organizations.select': { data: [ORG_ROW(comp)], error: null } as never,
  });
}

async function shellAndStrip() {
  const tree = await DashboardLayout({ children: null });
  const shell = findByTypeName(tree, 'DashboardShell');
  expect(shell).not.toBeNull();
  return {
    modules: shell!.props.enabledModules as string[],
    strip: findByTypeName(tree, 'ModulesUnreadBanner'),
  };
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('(dashboard) layout: the module list it hands the shell', () => {
  it('rows that were read: the enabled modules, and no strip', async () => {
    reads({ data: [{ module_id: 'rentals' }, { module_id: 'orders' }], error: null });
    const { modules, strip } = await shellAndStrip();
    expect([...modules].sort()).toEqual(['orders', 'rentals']);
    expect(strip).toBeNull();
  });

  it('an organization with every module off: an empty list by an answer, and no strip', async () => {
    reads({ data: [], error: null });
    const { modules, strip } = await shellAndStrip();
    expect(modules).toEqual([]);
    expect(strip).toBeNull();
  });

  it('rows that could not be read: the strip says so, and no optional module is listed as on', async () => {
    reads(ROWS_FAILED);
    const { modules, strip } = await shellAndStrip();
    expect(strip).not.toBeNull();
    expect(modules).toEqual([]);
  });

  it('rows that could not be read under a comp that was read: every non-core module, and no strip', async () => {
    reads(ROWS_FAILED, true);
    const { modules, strip } = await shellAndStrip();
    expect([...modules].sort()).toEqual([...NON_CORE].sort());
    expect(strip).toBeNull();
  });

  it('an answer that is not a list of module rows is not "no rows": the strip', async () => {
    reads({ data: null, error: null });
    const { strip } = await shellAndStrip();
    expect(strip).not.toBeNull();
  });
});
