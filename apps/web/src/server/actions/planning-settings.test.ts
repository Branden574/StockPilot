import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

// Mutable session state so per-test role / AAL / module-enabled overrides work
// (mirrors order-status-settings.test.ts / nav-settings.test.ts).
const sessionState = {
  role: 'owner' as 'owner' | 'admin' | 'manager' | 'staff' | 'viewer',
  mfaRequired: false,
  mfaSatisfied: true,
  planningEnabled: true,
};

// Captured update payload + the settings the "read" returns.
const dbState: { existingSettings: Record<string, unknown>; updatePayload: unknown } = {
  existingSettings: {},
  updatePayload: undefined,
};
const updateSpy = vi.fn();

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
        update: (payload: unknown) => {
          updateSpy(payload);
          dbState.updatePayload = payload;
          return { eq: () => ({ eq: () => Promise.resolve({ error: null }) }) };
        },
      };
    }),
  };
}

vi.mock('@/server/services/audit', () => ({ audit: vi.fn(async () => undefined) }));

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
      supabase: makeClient(),
      mfaRequired: sessionState.mfaRequired,
      mfaSatisfied: sessionState.mfaSatisfied,
      enabledModules: new Set(sessionState.planningEnabled ? ['planning'] : []),
    })),
  };
});

import { audit } from '@/server/services/audit';

import { setPlanningParamsAction } from './planning-settings';

const VALID = { leadTimeDays: 21, safetyMultiplier: 1.8, velocityWindowDays: 60 };

describe('setPlanningParamsAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionState.role = 'owner';
    sessionState.mfaRequired = false;
    sessionState.mfaSatisfied = true;
    sessionState.planningEnabled = true;
    dbState.existingSettings = {};
    dbState.updatePayload = undefined;
  });

  it('rejects a non-admin (staff) role — forbidden, no write', async () => {
    sessionState.role = 'staff';
    const r = await setPlanningParamsAction(VALID);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('forbidden');
    expect(updateSpy).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it('rejects an AAL1 session when the org requires MFA — forbidden, no write', async () => {
    sessionState.mfaRequired = true;
    sessionState.mfaSatisfied = false;
    const r = await setPlanningParamsAction(VALID);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('forbidden');
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('rejects when the planning module is not enabled — forbidden, no write', async () => {
    sessionState.planningEnabled = false;
    const r = await setPlanningParamsAction(VALID);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('forbidden');
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('rejects an out-of-range lead time — validation_error, no write', async () => {
    const r = await setPlanningParamsAction({ ...VALID, leadTimeDays: 0 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('validation_error');
    const r2 = await setPlanningParamsAction({ ...VALID, leadTimeDays: 500 });
    expect(r2.ok).toBe(false);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('rejects an out-of-range safety multiplier — validation_error', async () => {
    const r = await setPlanningParamsAction({ ...VALID, safetyMultiplier: 0.5 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('validation_error');
    const r2 = await setPlanningParamsAction({ ...VALID, safetyMultiplier: 5 });
    expect(r2.ok).toBe(false);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('rejects an out-of-range velocity window — validation_error', async () => {
    const r = await setPlanningParamsAction({ ...VALID, velocityWindowDays: 5 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('validation_error');
    const r2 = await setPlanningParamsAction({ ...VALID, velocityWindowDays: 500 });
    expect(r2.ok).toBe(false);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('persists valid params + audits planning_params.updated', async () => {
    const r = await setPlanningParamsAction(VALID);
    expect(r.ok).toBe(true);
    expect(updateSpy).toHaveBeenCalledTimes(1);
    const payload = dbState.updatePayload as { settings: Record<string, unknown> };
    expect(payload.settings.leadTimeDays).toBe(21);
    expect(payload.settings.safetyMultiplier).toBe(1.8);
    expect(payload.settings.velocityWindowDays).toBe(60);
    expect(audit).toHaveBeenCalledTimes(1);
    expect(vi.mocked(audit).mock.calls[0]?.[0].event).toBe('planning_params.updated');
  });

  it('MERGES into existing settings without clobbering other keys', async () => {
    dbState.existingSettings = { someOtherModuleKey: 'keep-me', leadTimeDays: 7 };
    const r = await setPlanningParamsAction(VALID);
    expect(r.ok).toBe(true);
    const payload = dbState.updatePayload as { settings: Record<string, unknown> };
    expect(payload.settings.someOtherModuleKey).toBe('keep-me');
    expect(payload.settings.leadTimeDays).toBe(21); // overwritten by the new value
  });
});
