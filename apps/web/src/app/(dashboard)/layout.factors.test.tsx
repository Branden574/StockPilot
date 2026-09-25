import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The dashboard layout starts the GoTrue factor read BEFORE it waits for the
 * org context (2026-09-22): the two used to run in series ahead of every
 * dashboard render. Starting it early must keep both of its gates (the
 * enrolled-user AAL2 redirect and the fail-closed error on an unreadable list,
 * #229), and must never leave a rejection nobody observes when the context
 * redirects instead of resolving.
 */

const state = vi.hoisted(() => ({
  releaseContext: null as null | (() => void),
  failContext: null as null | ((e: Error) => void),
  factors: null as null | (() => Promise<Array<{ status: string }>>),
  factorReads: 0,
  aal: 'aal1' as 'aal1' | 'aal2',
}));

vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({ get: () => undefined })),
  headers: vi.fn(async () => new Headers({ 'x-pathname': '/dashboard/inventory' })),
}));
vi.mock('next/navigation', () => ({
  redirect: vi.fn((to: string) => {
    throw new Error(`REDIRECT:${to}`);
  }),
}));
vi.mock('@/components/dashboard/dashboard-shell', () => ({ DashboardShell: () => null }));
vi.mock('@/components/dashboard/mfa-required-banner', () => ({ MfaRequiredBanner: () => null }));
vi.mock('@/components/dashboard/sidebar-pref', () => ({
  SIDEBAR_HIDDEN_COOKIE: 'sidebar-hidden',
  parseSidebarHidden: () => false,
}));
vi.mock('@/components/platform/impersonation-banner', () => ({ ImpersonationBanner: () => null }));
vi.mock('@/components/realtime/inventory-realtime', () => ({ InventoryRealtime: () => null }));
vi.mock('@/components/activity-beacon', () => ({ ActivityBeacon: () => null }));
vi.mock('@/lib/auth/platform-admin', () => ({
  currentUserIsPlatformAdminFromRequestHeader: vi.fn(async () => false),
}));
vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(
    () =>
      new Promise((resolve, reject) => {
        state.releaseContext = () =>
          resolve({
            userId: 'u-1',
            email: 'u@example.com',
            fullName: null,
            avatarUrl: null,
            defaultOrganizationId: 'org-1',
            organizationId: 'org-1',
            organizationName: 'Acme',
            role: 'staff',
            permissions: new Set(),
          });
        state.failContext = reject;
      }),
  ),
  getSessionMemberships: vi.fn(async () => []),
}));
vi.mock('@/lib/dashboard/request-cache', () => ({
  // A plain function, NOT vi.fn: tinyspy attaches its own handlers to every
  // Promise a vi.fn returns (mock.settledResults), which would hide exactly the
  // unobserved rejection the tests below look for.
  getMfaFactorsForRequest: () => {
    state.factorReads += 1;
    return state.factors!();
  },
  getModulesForRequest: vi.fn(async () => new Set()),
  getOrgRowForRequest: vi.fn(async () => ({
    terminology: null,
    mfa_policy: 'optional',
    logo_url: null,
    timezone: null,
    nav_overrides: null,
    dashboard_layout: null,
    order_status_config: null,
  })),
  getWarehousesForRequest: vi.fn(async () => []),
}));
vi.mock('@/lib/auth/warehouse', () => ({
  getWarehouseAccess: vi.fn(async () => ({
    readableIds: [],
    writableIds: [],
    hasAllAccess: false,
    primaryWarehouseId: null,
  })),
}));
vi.mock('@/lib/warehouse-filter', () => ({ getActiveWarehouseFilter: vi.fn(async () => null) }));
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => {
    const q: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'is']) q[m] = () => q;
    q.then = (ok: (v: unknown) => unknown) => ok({ count: 0, error: null });
    return {
      from: () => q,
      auth: {
        mfa: {
          getAuthenticatorAssuranceLevel: async () => ({
            data: { currentLevel: state.aal },
            error: null,
          }),
        },
      },
    };
  }),
}));

import { requireOrgContext } from '@/lib/auth/session';
import { SessionEndedError } from '@/lib/auth/session-ended';

import DashboardLayout from './layout';

/** Collects rejections Node reports as unhandled while `run` executes. */
async function unhandledDuring(run: () => Promise<void>): Promise<unknown[]> {
  const seen: unknown[] = [];
  const onUnhandled = (reason: unknown) => seen.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    await run();
    await new Promise((r) => setTimeout(r, 10));
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  return seen;
}

beforeEach(() => {
  vi.clearAllMocks();
  state.releaseContext = null;
  state.failContext = null;
  state.factors = async () => [];
  state.factorReads = 0;
  state.aal = 'aal1';
});

describe('DashboardLayout — the factor read overlaps the context read', () => {
  it('the factor read is in flight while requireOrgContext() is still pending, and runs once', async () => {
    const render = DashboardLayout({ children: null });
    await Promise.resolve();
    expect(requireOrgContext).toHaveBeenCalledTimes(1);
    expect(state.factorReads).toBe(1);
    state.releaseContext!();
    await render;
    expect(state.factorReads).toBe(1);
  });

  it('an enrolled user at AAL1 is still sent to the MFA challenge', async () => {
    state.factors = async () => [{ status: 'verified' }];
    const render = DashboardLayout({ children: null });
    state.releaseContext!();
    await expect(render).rejects.toThrow(
      'REDIRECT:/signin/mfa?redirect=%2Fdashboard%2Finventory',
    );
  });

  it('an UNREADABLE factor list still fails the layout closed, with nothing unhandled', async () => {
    state.factors = () => Promise.reject(new Error('getMfaFactorsForRequest: AuthRetryableFetchError'));
    let thrown: unknown = null;
    const unhandled = await unhandledDuring(async () => {
      const render = DashboardLayout({ children: null });
      // The rejection settles while the context is still pending.
      await new Promise((r) => setTimeout(r, 10));
      state.releaseContext!();
      await render.catch((e) => {
        thrown = e;
      });
    });
    expect(unhandled).toEqual([]);
    expect((thrown as Error | null)?.message).toBe(
      'getMfaFactorsForRequest: AuthRetryableFetchError',
    );
  });

  it('an ENDED session is sent to the cookie-clearing route, not the error screen, with nothing unhandled', async () => {
    state.factors = () => Promise.reject(new SessionEndedError());
    let thrown: unknown = null;
    const unhandled = await unhandledDuring(async () => {
      const render = DashboardLayout({ children: null });
      await new Promise((r) => setTimeout(r, 10));
      state.releaseContext!();
      await render.catch((e) => {
        thrown = e;
      });
    });
    expect(unhandled).toEqual([]);
    expect((thrown as Error | null)?.message).toBe('REDIRECT:/auth/session-ended');
  });

  it('a context that REDIRECTS leaves the abandoned factor read observed, not unhandled', async () => {
    state.factors = () => Promise.reject(new Error('getMfaFactorsForRequest: AuthSessionMissingError'));
    let thrown: unknown = null;
    const unhandled = await unhandledDuring(async () => {
      const render = DashboardLayout({ children: null });
      await Promise.resolve();
      state.failContext!(new Error('REDIRECT:/signin'));
      await render.catch((e) => {
        thrown = e;
      });
    });
    expect((thrown as Error | null)?.message).toBe('REDIRECT:/signin');
    expect(unhandled).toEqual([]);
  });
});
