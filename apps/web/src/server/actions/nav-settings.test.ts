import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub } from '@/test/supabase-mock';

import type { NavOverrides } from '@stockpilot/core';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

// Mutable session/MFA state so per-test role + AAL overrides work (mirrors
// module-settings.test.ts).
const sessionState = {
  role: 'owner' as 'owner' | 'admin' | 'manager' | 'staff' | 'viewer',
  mfaRequired: false,
  mfaSatisfied: true,
};

const stubHolder: { stub: ReturnType<typeof makeSupabaseStub> | null } = {
  stub: null,
};

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => stubHolder.stub!.client),
}));

vi.mock('@/server/services/audit', () => ({
  audit: vi.fn(async () => undefined),
}));

vi.mock('@/server/services/context', async () => {
  const actual = await vi.importActual<typeof import('@/server/services/context')>(
    '@/server/services/context',
  );
  return {
    ...actual,
    withContext: vi.fn(async () => ({
      organizationId: 'org-1',
      userId: 'user-1',
      role: sessionState.role,
      supabase: stubHolder.stub!.client,
      mfaRequired: sessionState.mfaRequired,
      mfaSatisfied: sessionState.mfaSatisfied,
      enabledModules: new Set(),
    })),
  };
});

import { audit } from '@/server/services/audit';

import { setNavOverridesAction } from './nav-settings';

/** Build a stub that records the organizations.update payload. */
function stubWithUpdateSpy() {
  // The action appends `.select('id').maybeSingle()` and fails closed on a
  // 0-row update, so the spy chain must terminate in a maybeSingle() resolving
  // a row (the persisted-OK path).
  const updateSpy = vi.fn((..._args: unknown[]) => ({
    eq: vi.fn(() => ({
      select: vi.fn(() => ({
        maybeSingle: vi.fn(() => Promise.resolve({ data: { id: 'org-1' }, error: null })),
      })),
    })),
  }));
  const stub = makeSupabaseStub();
  const originalFrom = stub.client.from.bind(stub.client);
  stub.client.from = vi.fn((table: string) => {
    const chain = originalFrom(table);
    if (table === 'organizations') {
      return new Proxy(chain as object, {
        get(target, prop: string) {
          if (prop === 'update') return updateSpy;
          return (target as Record<string, unknown>)[prop];
        },
      });
    }
    return chain;
  });
  return { stub, updateSpy };
}

describe('setNavOverridesAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionState.role = 'owner';
    sessionState.mfaRequired = false;
    sessionState.mfaSatisfied = true;
    stubHolder.stub = null;
  });

  it('rejects a custom link with an unsafe javascript: href (validation_error, no write)', async () => {
    const { stub, updateSpy } = stubWithUpdateSpy();
    stubHolder.stub = stub;

    const overrides = {
      v: 1,
      custom: [
        {
          id: 'evil',
          label: 'Evil',
          href: 'javascript:alert(1)',
          section: 'tools',
          iconName: 'BookOpen',
        },
      ],
    } as unknown as NavOverrides;

    const result = await setNavOverridesAction(overrides);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('validation_error');
    expect(updateSpy).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it('returns forbidden for a non-admin (staff) role, no write', async () => {
    sessionState.role = 'staff';
    const { stub, updateSpy } = stubWithUpdateSpy();
    stubHolder.stub = stub;

    const result = await setNavOverridesAction({ v: 1, hidden: ['/dashboard/inventory'] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('forbidden');
    expect(updateSpy).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it('rejects an AAL1 session when the org requires MFA (forbidden, no write)', async () => {
    sessionState.role = 'owner';
    sessionState.mfaRequired = true;
    sessionState.mfaSatisfied = false;
    const { stub, updateSpy } = stubWithUpdateSpy();
    stubHolder.stub = stub;

    const result = await setNavOverridesAction({ v: 1, hidden: ['/dashboard/inventory'] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('forbidden');
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('rejects an oversized custom-links list (> 50) as validation_error', async () => {
    const { stub, updateSpy } = stubWithUpdateSpy();
    stubHolder.stub = stub;

    const custom = Array.from({ length: 51 }, (_, i) => ({
      id: `c${i}`,
      label: `Link ${i}`,
      href: `/dashboard/x${i}`,
      section: 'tools',
      iconName: 'BookOpen',
    }));

    const result = await setNavOverridesAction({ v: 1, custom } as unknown as NavOverrides);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('validation_error');
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('rejects an over-long label (> 60 chars) as validation_error', async () => {
    const { stub, updateSpy } = stubWithUpdateSpy();
    stubHolder.stub = stub;

    const result = await setNavOverridesAction({
      v: 1,
      labels: { '/dashboard/inventory': 'x'.repeat(61) },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('validation_error');
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('persists a valid override + audits nav_overrides.updated', async () => {
    const { stub, updateSpy } = stubWithUpdateSpy();
    stubHolder.stub = stub;

    const overrides: NavOverrides = {
      v: 1,
      hidden: ['/dashboard/inventory'],
      labels: { '/dashboard/orders': 'Sales orders' },
      custom: [
        {
          id: 'help',
          label: 'Help',
          href: '/dashboard/help',
          section: 'tools',
          iconName: 'BookOpen',
        },
      ],
    };

    const result = await setNavOverridesAction(overrides);
    expect(result.ok).toBe(true);
    expect(updateSpy).toHaveBeenCalledTimes(1);
    const payload = updateSpy.mock.calls[0]?.[0] as { nav_overrides: NavOverrides };
    expect(payload.nav_overrides.v).toBe(1);
    expect(audit).toHaveBeenCalledTimes(1);
    expect(vi.mocked(audit).mock.calls[0]?.[0].event).toBe('nav_overrides.updated');
  });

  // OWNER DECISION 2026-10-19: the sections the regroup added are valid keys
  // for an order list and for a custom link; a save shaped before the regroup
  // (from a tab opened before the deploy) is still accepted as it is.
  it('accepts order lists and custom links under Fulfillment, Purchasing and Insights', async () => {
    const { stub, updateSpy } = stubWithUpdateSpy();
    stubHolder.stub = stub;

    const overrides: NavOverrides = {
      v: 1,
      order: {
        inventory: ['/dashboard/inventory', '/dashboard/books'],
        fulfillment: ['/dashboard/orders', '/dashboard/rentals'],
        purchasing: ['/dashboard/suppliers'],
        insights: ['/dashboard/insights', '/dashboard/reports'],
      },
      custom: [
        {
          id: 'bi',
          label: 'Board pack',
          href: 'https://bi.example.com',
          section: 'insights',
          iconName: 'BarChart3',
        },
        {
          id: 'carrier',
          label: 'Carrier',
          href: '/dashboard/orders?carrier=1',
          section: 'fulfillment',
          iconName: 'Truck',
        },
      ],
    };

    const result = await setNavOverridesAction(overrides);
    expect(result.ok).toBe(true);
    const payload = updateSpy.mock.calls[0]?.[0] as { nav_overrides: NavOverrides };
    expect(payload.nav_overrides.order).toEqual(overrides.order);
    expect(payload.nav_overrides.custom?.map((c) => c.section)).toEqual([
      'insights',
      'fulfillment',
    ]);
  });

  it('still accepts a save shaped before the regroup (moved links in order.inventory)', async () => {
    const { stub, updateSpy } = stubWithUpdateSpy();
    stubHolder.stub = stub;

    const result = await setNavOverridesAction({
      v: 1,
      order: {
        inventory: ['/dashboard/orders', '/dashboard/inventory', '/dashboard/purchase-orders'],
        workspace: ['/dashboard/insights', '/dashboard/ai'],
      },
    });
    expect(result.ok).toBe(true);
    expect(updateSpy).toHaveBeenCalledTimes(1);
  });

  it('rejects a section key no sidebar has (the design-only Devices group)', async () => {
    const { stub, updateSpy } = stubWithUpdateSpy();
    stubHolder.stub = stub;

    for (const overrides of [
      { v: 1, order: { devices: ['/dashboard/inventory'] } },
      {
        v: 1,
        custom: [
          { id: 'x', label: 'Scanner', href: '/dashboard', section: 'devices', iconName: 'X' },
        ],
      },
    ]) {
      const result = await setNavOverridesAction(overrides as unknown as NavOverrides);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('validation_error');
    }
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('reset (null) clears the override and audits', async () => {
    const { stub, updateSpy } = stubWithUpdateSpy();
    stubHolder.stub = stub;

    const result = await setNavOverridesAction(null);
    expect(result.ok).toBe(true);
    expect(updateSpy).toHaveBeenCalledTimes(1);
    const payload = updateSpy.mock.calls[0]?.[0] as { nav_overrides: NavOverrides | null };
    expect(payload.nav_overrides).toBeNull();
    expect(audit).toHaveBeenCalledTimes(1);
  });
});
