import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub } from '@/test/supabase-mock';

import { DASHBOARD_WIDGETS, type DashboardLayout } from '@stockpilot/core';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

// Mutable session/MFA state so per-test role + AAL overrides work (mirrors
// nav-settings.test.ts / module-settings.test.ts).
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

import { setDashboardLayoutAction } from './dashboard-settings';

/** Build a stub that records the organizations.update payload. */
function stubWithUpdateSpy() {
  const updateSpy = vi.fn((..._args: unknown[]) => ({
    eq: vi.fn(() => ({
      then: (resolve: (v: { error: null }) => void) => resolve({ error: null }),
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

const KNOWN_ID = DASHBOARD_WIDGETS[0]!.id;
const KNOWN_ID_2 = DASHBOARD_WIDGETS[1]!.id;

describe('setDashboardLayoutAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionState.role = 'owner';
    sessionState.mfaRequired = false;
    sessionState.mfaSatisfied = true;
    stubHolder.stub = null;
  });

  it('drops an unknown widget id but keeps the known ones', async () => {
    const { stub, updateSpy } = stubWithUpdateSpy();
    stubHolder.stub = stub;

    const layout = {
      v: 1,
      widgets: [{ id: 'ghost-widget' }, { id: KNOWN_ID }, { id: KNOWN_ID_2, hidden: true }],
    } as unknown as DashboardLayout;

    const result = await setDashboardLayoutAction(layout);
    expect(result.ok).toBe(true);
    expect(updateSpy).toHaveBeenCalledTimes(1);
    const payload = updateSpy.mock.calls[0]?.[0] as { dashboard_layout: DashboardLayout };
    const ids = payload.dashboard_layout.widgets.map((w) => w.id);
    expect(ids).toEqual([KNOWN_ID, KNOWN_ID_2]); // ghost-widget dropped
    expect(payload.dashboard_layout.widgets[1]).toEqual({ id: KNOWN_ID_2, hidden: true });
    expect(audit).toHaveBeenCalledTimes(1);
    expect(vi.mocked(audit).mock.calls[0]?.[0].event).toBe('dashboard_layout.updated');
  });

  it('de-dupes repeated widget ids (first occurrence wins)', async () => {
    const { stub, updateSpy } = stubWithUpdateSpy();
    stubHolder.stub = stub;

    const layout = {
      v: 1,
      widgets: [{ id: KNOWN_ID }, { id: KNOWN_ID, hidden: true }, { id: KNOWN_ID_2 }],
    } as unknown as DashboardLayout;

    const result = await setDashboardLayoutAction(layout);
    expect(result.ok).toBe(true);
    const payload = updateSpy.mock.calls[0]?.[0] as { dashboard_layout: DashboardLayout };
    expect(payload.dashboard_layout.widgets.map((w) => w.id)).toEqual([KNOWN_ID, KNOWN_ID_2]);
    // First occurrence (visible) won; the later hidden dup was discarded.
    expect(payload.dashboard_layout.widgets[0]).toEqual({ id: KNOWN_ID });
  });

  it('returns forbidden for a non-admin (staff) role, no write', async () => {
    sessionState.role = 'staff';
    const { stub, updateSpy } = stubWithUpdateSpy();
    stubHolder.stub = stub;

    const result = await setDashboardLayoutAction({ v: 1, widgets: [{ id: KNOWN_ID }] });
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

    const result = await setDashboardLayoutAction({ v: 1, widgets: [{ id: KNOWN_ID }] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('forbidden');
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('rejects a malformed (wrong-version) payload as validation_error, no write', async () => {
    const { stub, updateSpy } = stubWithUpdateSpy();
    stubHolder.stub = stub;

    const result = await setDashboardLayoutAction({ v: 2, widgets: [] } as unknown as DashboardLayout);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('validation_error');
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('reset (null) clears the layout and audits', async () => {
    const { stub, updateSpy } = stubWithUpdateSpy();
    stubHolder.stub = stub;

    const result = await setDashboardLayoutAction(null);
    expect(result.ok).toBe(true);
    expect(updateSpy).toHaveBeenCalledTimes(1);
    const payload = updateSpy.mock.calls[0]?.[0] as { dashboard_layout: DashboardLayout | null };
    expect(payload.dashboard_layout).toBeNull();
    expect(audit).toHaveBeenCalledTimes(1);
    expect(vi.mocked(audit).mock.calls[0]?.[0].event).toBe('dashboard_layout.updated');
  });
});
