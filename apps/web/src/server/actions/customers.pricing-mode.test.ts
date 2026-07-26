import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

// Mutable session state so per-test role / AAL / module-enabled overrides
// work (mirrors auto-archive-settings.test.ts / recurring-pos.test.ts).
const sessionState = {
  role: 'owner' as 'owner' | 'admin' | 'manager' | 'staff' | 'viewer',
  mfaRequired: false,
  mfaSatisfied: true,
  portalEnabled: true,
};

// The b2b_portal module row's current settings jsonb, as the service's
// read-then-merge-then-write would see it.
const dbState: { existingSettings: Record<string, unknown> } = { existingSettings: {} };
const upsertSpy = vi.fn();

function makeClient() {
  return {
    from: vi.fn((table: string) => {
      if (table !== 'organization_modules') throw new Error(`unexpected table ${table}`);
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: { settings: dbState.existingSettings },
                error: null,
              }),
            }),
          }),
        }),
        upsert: (payload: unknown, options: unknown) => {
          upsertSpy(payload, options);
          return Promise.resolve({ data: null, error: null });
        },
      };
    }),
  };
}

// permissionSpy wraps the REAL assertPermission by default (set inside the
// vi.mock factory below, once `actual` is available) so every test exercises
// real gating unless it explicitly overrides the implementation for one call.
// vi.hoisted: the vi.mock() factory below is itself hoisted above normal
// top-level `const`s, so a plain `const permissionSpy = vi.fn()` referenced
// directly in the factory body would hit the TDZ.
const { permissionSpy, auditSpy } = vi.hoisted(() => ({
  permissionSpy: vi.fn(),
  auditSpy: vi.fn(async () => {}),
}));

vi.mock('@/server/services/audit', () => ({ audit: auditSpy }));

vi.mock('@/server/services/context', async () => {
  const actual = await vi.importActual<typeof import('@/server/services/context')>(
    '@/server/services/context',
  );
  permissionSpy.mockImplementation(actual.assertPermission);
  return {
    ...actual,
    assertPermission: permissionSpy,
    withContext: vi.fn(async () => ({
      organizationId: 'org-1',
      userId: 'user-1',
      role: sessionState.role,
      supabase: makeClient(),
      mfaRequired: sessionState.mfaRequired,
      mfaSatisfied: sessionState.mfaSatisfied,
      enabledModules: new Set(sessionState.portalEnabled ? ['b2b_portal'] : []),
    })),
  };
});

import { ServiceError } from '@/server/services/context';

import { setPortalPricingModeAction } from './customers';

describe('setPortalPricingModeAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionState.role = 'owner';
    sessionState.mfaRequired = false;
    sessionState.mfaSatisfied = true;
    sessionState.portalEnabled = true;
    dbState.existingSettings = {};
  });

  it('rejects a value outside the two modes', async () => {
    const res = await setPortalPricingModeAction('free' as never);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('validation_error');
    expect(upsertSpy).not.toHaveBeenCalled();
  });

  it('accepts no_charge and priced', async () => {
    expect((await setPortalPricingModeAction('no_charge')).ok).toBe(true);
    expect((await setPortalPricingModeAction('priced')).ok).toBe(true);
    expect(upsertSpy).toHaveBeenCalledTimes(2);
  });

  it('MERGES into the existing settings jsonb rather than replacing it', async () => {
    // existing settings on the b2b_portal row: { someOtherFlag: true }
    dbState.existingSettings = { someOtherFlag: true };
    const res = await setPortalPricingModeAction('priced');
    expect(res.ok).toBe(true);
    expect(upsertSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        settings: { someOtherFlag: true, pricingMode: 'priced' },
      }),
      expect.anything(),
    );
  });

  it('surfaces a permission failure rather than writing', async () => {
    permissionSpy.mockImplementationOnce(() => {
      throw new ServiceError('forbidden', 'Missing permission');
    });
    const res = await setPortalPricingModeAction('priced');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('forbidden');
    expect(upsertSpy).not.toHaveBeenCalled();
  });

  it('rejects when the b2b_portal module is not enabled — forbidden, no write', async () => {
    sessionState.portalEnabled = false;
    const res = await setPortalPricingModeAction('priced');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('module_disabled');
    expect(upsertSpy).not.toHaveBeenCalled();
  });

  it('rejects an AAL1 session when the org requires MFA — forbidden, no write (fail closed)', async () => {
    sessionState.mfaRequired = true;
    sessionState.mfaSatisfied = false;
    const res = await setPortalPricingModeAction('priced');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('forbidden');
    expect(upsertSpy).not.toHaveBeenCalled();
  });

  // Writing organization_modules is has_org_role(..., 'admin') at the RLS layer
  // (mig 0219). customers:manage is manager-and-above, so gating only on it let
  // a manager reach the write and get a raw Postgres RLS error back in a toast.
  // The gate now sits at the altitude the database enforces.
  it.each(['manager', 'staff', 'viewer'] as const)(
    'refuses a %s — the RLS floor on organization_modules is admin',
    async (role) => {
      sessionState.role = role;
      const res = await setPortalPricingModeAction('priced');
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe('forbidden');
      expect(upsertSpy).not.toHaveBeenCalled();
    },
  );

  it.each(['owner', 'admin'] as const)('allows an %s to save', async (role) => {
    sessionState.role = role;
    expect((await setPortalPricingModeAction('priced')).ok).toBe(true);
    expect(upsertSpy).toHaveBeenCalledTimes(1);
  });

  it('audits the change with before and after', async () => {
    dbState.existingSettings = { pricingMode: 'no_charge' };
    const res = await setPortalPricingModeAction('priced');
    expect(res.ok).toBe(true);
    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'portal_pricing_mode.updated',
        entityType: 'organization_module',
        entityId: 'b2b_portal',
        before: { pricingMode: 'no_charge' },
        after: { pricingMode: 'priced' },
      }),
      expect.anything(),
    );
  });

  it('does not audit a change that was refused', async () => {
    sessionState.role = 'manager';
    await setPortalPricingModeAction('priced');
    expect(auditSpy).not.toHaveBeenCalled();
  });
});
