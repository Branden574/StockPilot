import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub } from '@/test/supabase-mock';

import {
  applyNavOverrides,
  resolveSurface,
  type ModuleId,
  type NavOverrides,
} from '@stockpilot/core';

import { UnreadableModuleSet } from '@/lib/modules/module-state';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

// Mutable session/MFA state so per-test role + AAL overrides work (mirrors
// module-settings.test.ts).
const sessionState = {
  role: 'owner' as 'owner' | 'admin' | 'manager' | 'staff' | 'viewer',
  mfaRequired: false,
  mfaSatisfied: true,
  enabledModules: new Set<ModuleId>() as Set<ModuleId>,
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
      enabledModules: sessionState.enabledModules,
    })),
  };
});

import { audit } from '@/server/services/audit';

import { setNavOverridesAction } from './nav-settings';

/** Build a stub that records the organizations.update payload. */
function stubWithUpdateSpy(results: Parameters<typeof makeSupabaseStub>[0] = {}) {
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
  const stub = makeSupabaseStub(results);
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
    sessionState.enabledModules = new Set();
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

/**
 * Settings > Navigation lists the links of the modules that are on, and Save
 * sends the organization's whole menu setting. The stored entries for a link
 * the editor did not list (its module is off, or was turned on after the page
 * opened) are not the editor's to change: the save keeps them, so the hides,
 * renames and places an admin chose come back when the module is on again.
 * The links the editor listed take the editor's answer, so a hide undone, a
 * rename cleared or a link moved is saved. A stored entry for a link the
 * product no longer has is let go.
 */
describe('a save keeps the stored entries of links the editor did not list', () => {
  const RENTALS = '/dashboard/rentals';
  const MAINTENANCE = '/dashboard/maintenance';

  /** The links the editor lists for these modules (Settings > Navigation). */
  function editorLinks(modules: readonly ModuleId[]): string[] {
    return resolveSurface('web_sidebar', { role: 'admin', enabledModules: new Set(modules) })
      .flatMap((s) => s.items.map((i) => i.href));
  }

  /** The sidebar an admin sees with these modules on and this setting saved. */
  function sidebar(modules: readonly ModuleId[], saved: NavOverrides | null) {
    return applyNavOverrides(
      resolveSurface('web_sidebar', { role: 'admin', enabledModules: new Set(modules) }),
      saved,
    ).flatMap((s) => s.items.map((i) => ({ href: i.href, label: i.label, section: s.section })));
  }

  const STORED: NavOverrides = {
    v: 1,
    hidden: [RENTALS],
    labels: { [MAINTENANCE]: 'Work requests' },
    order: { fulfillment: ['/dashboard/returns', RENTALS, '/dashboard/orders'] },
  };

  function storedRow(value: unknown) {
    return { 'organizations.select': { data: { nav_overrides: value }, error: null } };
  }

  function written(updateSpy: ReturnType<typeof stubWithUpdateSpy>['updateSpy']) {
    expect(updateSpy).toHaveBeenCalledTimes(1);
    return (updateSpy.mock.calls[0]?.[0] as { nav_overrides: NavOverrides | null }).nav_overrides;
  }

  const ON_NOW: ModuleId[] = ['orders', 'returns'];

  it('saving with a module off keeps its hides, renames and place in the order', async () => {
    sessionState.enabledModules = new Set(ON_NOW);
    const { stub, updateSpy } = stubWithUpdateSpy(storedRow(STORED));
    stubHolder.stub = stub;

    const result = await setNavOverridesAction(
      {
        v: 1,
        labels: { '/dashboard/inventory': 'Stock' },
        order: { fulfillment: ['/dashboard/orders', '/dashboard/returns'] },
      },
      editorLinks(ON_NOW),
    );

    expect(result.ok).toBe(true);
    expect(written(updateSpy)).toEqual({
      v: 1,
      hidden: [RENTALS],
      labels: { '/dashboard/inventory': 'Stock', [MAINTENANCE]: 'Work requests' },
      order: { fulfillment: ['/dashboard/orders', '/dashboard/returns', RENTALS] },
    });
  });

  it('turning the module back on shows them; while it is off they draw nothing', async () => {
    sessionState.enabledModules = new Set(ON_NOW);
    const { stub, updateSpy } = stubWithUpdateSpy(storedRow(STORED));
    stubHolder.stub = stub;
    await setNavOverridesAction({ v: 1 }, editorLinks(ON_NOW));
    const saved = written(updateSpy);

    const off = sidebar(ON_NOW, saved);
    expect(off.map((i) => i.href)).not.toContain(MAINTENANCE);
    expect(off.map((i) => i.href)).not.toContain(RENTALS);

    const on = sidebar([...ON_NOW, 'maintenance_requests', 'rentals'], saved);
    expect(on.find((i) => i.href === MAINTENANCE)?.label).toBe('Work requests');
    // Rentals stays hidden, as the admin left it.
    expect(on.map((i) => i.href)).not.toContain(RENTALS);
  });

  it('a change to a listed link is saved: a hide undone, a rename cleared, a section reordered', async () => {
    sessionState.enabledModules = new Set(ON_NOW);
    const { stub, updateSpy } = stubWithUpdateSpy(
      storedRow({
        v: 1,
        hidden: ['/dashboard/inventory', RENTALS],
        labels: { '/dashboard/orders': 'Sales', [MAINTENANCE]: 'Work requests' },
      }),
    );
    stubHolder.stub = stub;

    await setNavOverridesAction(
      { v: 1, order: { inventory: ['/dashboard/movements', '/dashboard/inventory'] } },
      editorLinks(ON_NOW),
    );

    expect(written(updateSpy)).toEqual({
      v: 1,
      hidden: [RENTALS],
      labels: { [MAINTENANCE]: 'Work requests' },
      order: { inventory: ['/dashboard/movements', '/dashboard/inventory'] },
    });
  });

  it('a section moved back to its default order keeps the place of a link that is off', async () => {
    sessionState.enabledModules = new Set(ON_NOW);
    const { stub, updateSpy } = stubWithUpdateSpy(storedRow(STORED));
    stubHolder.stub = stub;

    await setNavOverridesAction({ v: 1 }, editorLinks(ON_NOW));

    const fulfillmentNow = resolveSurface('web_sidebar', {
      role: 'admin',
      enabledModules: new Set(ON_NOW),
    })
      .find((s) => s.section === 'fulfillment')!
      .items.map((i) => i.href);
    expect(fulfillmentNow).toEqual(['/dashboard/orders', '/dashboard/returns']);
    // Rentals sat after Returns; it keeps that place among the listed links.
    expect(written(updateSpy)?.order).toEqual({
      fulfillment: ['/dashboard/orders', '/dashboard/returns', RENTALS],
    });
  });

  it('a link the editor did not list is kept even when its module is on now', async () => {
    // The page opened while Rentals and Maintenance were off; they are on by the save.
    sessionState.enabledModules = new Set([...ON_NOW, 'rentals', 'maintenance_requests']);
    const { stub, updateSpy } = stubWithUpdateSpy(storedRow(STORED));
    stubHolder.stub = stub;

    await setNavOverridesAction({ v: 1 }, editorLinks(ON_NOW));

    const saved = written(updateSpy);
    expect(saved?.hidden).toEqual([RENTALS]);
    expect(saved?.labels).toEqual({ [MAINTENANCE]: 'Work requests' });
  });

  it('a save that does not say what it listed keeps the entries of every module that is off', async () => {
    sessionState.enabledModules = new Set(ON_NOW);
    const { stub, updateSpy } = stubWithUpdateSpy(storedRow(STORED));
    stubHolder.stub = stub;

    await setNavOverridesAction({ v: 1, hidden: ['/dashboard/orders'] });

    const saved = written(updateSpy);
    expect(saved?.hidden?.sort()).toEqual(['/dashboard/orders', RENTALS]);
    expect(saved?.labels).toEqual({ [MAINTENANCE]: 'Work requests' });
  });

  it('a stored entry for a link the product no longer has is let go', async () => {
    sessionState.enabledModules = new Set(ON_NOW);
    const { stub, updateSpy } = stubWithUpdateSpy(
      storedRow({
        v: 1,
        hidden: ['/dashboard/retired-board', RENTALS],
        labels: { '/dashboard/retired-board': 'Old board' },
        order: { workspace: ['/dashboard/retired-board', MAINTENANCE] },
      }),
    );
    stubHolder.stub = stub;

    await setNavOverridesAction({ v: 1 }, editorLinks(ON_NOW));

    expect(written(updateSpy)).toEqual({
      v: 1,
      hidden: [RENTALS],
      order: {
        workspace: [
          MAINTENANCE,
          ...resolveSurface('web_sidebar', { role: 'admin', enabledModules: new Set(ON_NOW) })
            .find((s) => s.section === 'workspace')!
            .items.map((i) => i.href),
        ],
      },
    });
  });

  it('nothing stored and nothing to save writes no setting (null)', async () => {
    sessionState.enabledModules = new Set(ON_NOW);
    const { stub, updateSpy } = stubWithUpdateSpy(storedRow(null));
    stubHolder.stub = stub;

    const result = await setNavOverridesAction({ v: 1 }, editorLinks(ON_NOW));
    expect(result.ok).toBe(true);
    expect(written(updateSpy)).toBeNull();
  });

  it('Reset to default still clears everything, the entries of modules that are off too', async () => {
    sessionState.enabledModules = new Set(ON_NOW);
    const { stub, updateSpy } = stubWithUpdateSpy(storedRow(STORED));
    stubHolder.stub = stub;

    await setNavOverridesAction(null);
    expect(written(updateSpy)).toBeNull();
  });

  it('a module state that could not be read: no save, nothing written', async () => {
    sessionState.enabledModules = new UnreadableModuleSet([]);
    const { stub, updateSpy } = stubWithUpdateSpy(storedRow(STORED));
    stubHolder.stub = stub;

    const result = await setNavOverridesAction({ v: 1 }, editorLinks([]));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe('Your access could not be checked. Please try again.');
    }
    expect(updateSpy).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it('a stored setting that could not be read: no save, nothing written', async () => {
    sessionState.enabledModules = new Set(ON_NOW);
    const { stub, updateSpy } = stubWithUpdateSpy({
      'organizations.select': { data: null, error: { message: 'read error', code: '57014' } },
    });
    stubHolder.stub = stub;

    const result = await setNavOverridesAction({ v: 1 }, editorLinks(ON_NOW));
    expect(result.ok).toBe(false);
    expect(updateSpy).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it('rejects a listed-links value that is not a list of links (validation_error, no write)', async () => {
    const { stub, updateSpy } = stubWithUpdateSpy(storedRow(STORED));
    stubHolder.stub = stub;

    const result = await setNavOverridesAction({ v: 1 }, [42] as unknown as string[]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('validation_error');
    expect(updateSpy).not.toHaveBeenCalled();
  });
});
