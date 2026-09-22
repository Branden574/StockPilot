import type { ReactElement, ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 2026-09-22 (cold start): the dashboard layout's blocking fan-out waits for
 * its slowest member before the first byte of ANY dashboard page, and 3-5% of
 * our server's Supabase calls stall 1-8 s on weekday daytimes. The bell's
 * unread head count was one of those members although the bell re-reads the
 * exact total itself on mount. It is gone from the layout; these tests prove
 * the layout neither reads notifications nor hands the shell a seed.
 */

const fromTables: string[] = [];

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
vi.mock('@/lib/dashboard/request-cache', () => ({
  getOrgRowForRequest: async () => ({
    mfa_policy: 'optional',
    logo_url: null,
    terminology: null,
    nav_overrides: null,
    order_status_config: null,
  }),
  getMfaFactorsForRequest: async () => [],
  getWarehousesForRequest: async () => [{ id: 'wh-1', name: 'Main' }],
  getModulesForRequest: async () => new Set<string>(),
}));
vi.mock('@/lib/auth/warehouse', () => ({
  getWarehouseAccess: async () => ({ hasAllAccess: true, readableIds: ['wh-1'] }),
}));
vi.mock('@/lib/warehouse-filter', () => ({ getActiveWarehouseFilter: async () => null }));

// Every table read the layout issues hangs forever: if one of them is in the
// blocking wave, the layout never resolves.
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => {
    const hang = () => {
      const builder: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'is', 'in', 'not', 'order', 'limit']) {
        builder[m] = () => builder;
      }
      builder.then = () => undefined;
      return builder;
    };
    return {
      from: (table: string) => {
        fromTables.push(table);
        return hang();
      },
      auth: {
        mfa: {
          getAuthenticatorAssuranceLevel: async () => ({
            data: { currentLevel: 'aal2' },
            error: null,
          }),
        },
      },
    };
  },
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

beforeEach(() => {
  fromTables.length = 0;
});

describe('(dashboard) layout blocking wave', () => {
  it('resolves without waiting on any notifications read', async () => {
    const timedOut = Symbol('timed out');
    const result = await Promise.race([
      DashboardLayout({ children: null }),
      new Promise<typeof timedOut>((resolve) => setTimeout(() => resolve(timedOut), 2000)),
    ]);
    expect(result).not.toBe(timedOut);
    expect(fromTables).not.toContain('notifications');
  });

  it('hands the shell no unread seed: the bell reads its own count after mount', async () => {
    const tree = await DashboardLayout({ children: null });
    const shell = findByTypeName(tree, 'DashboardShell');
    expect(shell).not.toBeNull();
    expect(shell!.props).not.toHaveProperty('initialUnreadNotifications');
    // The rest of what the shell is handed is still there.
    expect(shell!.props).toMatchObject({
      userId: 'u1',
      organizationId: 'org-1',
      warehouseFilter: { warehouses: [{ id: 'wh-1', name: 'Main' }], activeId: null },
    });
  });
});
