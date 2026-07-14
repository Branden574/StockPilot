import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

// Mutable session state so per-test role / AAL / module-enabled overrides work
// (mirrors planning-settings.test.ts / order-status-settings.test.ts).
const sessionState = {
  role: 'owner' as 'owner' | 'admin' | 'manager' | 'staff' | 'viewer',
  mfaRequired: false,
  mfaSatisfied: true,
  inventoryEnabled: true,
};

// Captured update payload + the settings the "read" returns, plus a knob to
// simulate a missing module row (0-row update → fail closed).
const dbState: {
  existingSettings: Record<string, unknown>;
  updatePayload: unknown;
  moduleRowExists: boolean;
} = {
  existingSettings: {},
  updatePayload: undefined,
  moduleRowExists: true,
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
          return {
            eq: () => ({
              eq: () => ({
                select: () => ({
                  maybeSingle: async () => ({
                    data: dbState.moduleRowExists ? { organization_id: 'org-1' } : null,
                    error: null,
                  }),
                }),
              }),
            }),
          };
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
      enabledModules: new Set(sessionState.inventoryEnabled ? ['inventory'] : []),
    })),
  };
});

import { audit } from '@/server/services/audit';

import { setAutoArchiveSettingsAction } from './auto-archive-settings';

const VALID = { enabled: true, dwellDays: 7 };

describe('setAutoArchiveSettingsAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionState.role = 'owner';
    sessionState.mfaRequired = false;
    sessionState.mfaSatisfied = true;
    sessionState.inventoryEnabled = true;
    dbState.existingSettings = {};
    dbState.updatePayload = undefined;
    dbState.moduleRowExists = true;
  });

  it('rejects a viewer (no items:update) — forbidden, no write', async () => {
    sessionState.role = 'viewer';
    const r = await setAutoArchiveSettingsAction(VALID);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('forbidden');
    expect(updateSpy).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it('allows staff (has items:update, unlike items:delete)', async () => {
    sessionState.role = 'staff';
    const r = await setAutoArchiveSettingsAction(VALID);
    expect(r.ok).toBe(true);
    expect(updateSpy).toHaveBeenCalledTimes(1);
  });

  it('allows manager (has items:update, unlike items:delete)', async () => {
    sessionState.role = 'manager';
    const r = await setAutoArchiveSettingsAction(VALID);
    expect(r.ok).toBe(true);
    expect(updateSpy).toHaveBeenCalledTimes(1);
  });

  it('rejects an AAL1 session when the org requires MFA — forbidden, no write (fail closed)', async () => {
    sessionState.mfaRequired = true;
    sessionState.mfaSatisfied = false;
    const r = await setAutoArchiveSettingsAction(VALID);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('forbidden');
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('rejects when the inventory module is not enabled — forbidden, no write', async () => {
    sessionState.inventoryEnabled = false;
    const r = await setAutoArchiveSettingsAction(VALID);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('forbidden');
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('rejects an out-of-range dwellDays — validation_error, no write', async () => {
    const r = await setAutoArchiveSettingsAction({ enabled: true, dwellDays: 0 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('validation_error');
    const r2 = await setAutoArchiveSettingsAction({ enabled: true, dwellDays: 366 });
    expect(r2.ok).toBe(false);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('persists valid settings + audits auto_archive_settings.updated', async () => {
    const r = await setAutoArchiveSettingsAction(VALID);
    expect(r.ok).toBe(true);
    expect(updateSpy).toHaveBeenCalledTimes(1);
    const payload = dbState.updatePayload as { settings: Record<string, unknown> };
    expect(payload.settings.autoArchiveOnZeroStock).toEqual({ enabled: true, dwellDays: 7 });
    expect(audit).toHaveBeenCalledTimes(1);
    expect(vi.mocked(audit).mock.calls[0]?.[0].event).toBe('auto_archive_settings.updated');
  });

  it('MERGES into existing settings without clobbering the autoDeleteArchived sibling key', async () => {
    dbState.existingSettings = {
      autoDeleteArchived: { enabled: true, days: 90 },
      someOtherModuleKey: 'keep-me',
    };
    const r = await setAutoArchiveSettingsAction(VALID);
    expect(r.ok).toBe(true);
    const payload = dbState.updatePayload as { settings: Record<string, unknown> };
    expect(payload.settings.autoDeleteArchived).toEqual({ enabled: true, days: 90 });
    expect(payload.settings.someOtherModuleKey).toBe('keep-me');
    expect(payload.settings.autoArchiveOnZeroStock).toEqual({ enabled: true, dwellDays: 7 });
  });

  it('fails closed when the module row is missing (0-row update) — internal_error, no audit', async () => {
    dbState.moduleRowExists = false;
    const r = await setAutoArchiveSettingsAction(VALID);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('internal_error');
    expect(audit).not.toHaveBeenCalled();
  });
});
