import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

// Mutable session state so per-test role / permission-override / AAL
// combinations work — mirrors auto-archive-settings.test.ts /
// planning-settings.test.ts / order-status-settings.test.ts.
const sessionState = {
  role: 'owner' as 'owner' | 'admin' | 'manager' | 'staff' | 'viewer',
  // Effective permission set (role defaults + role/user overrides already
  // resolved) — when set, `can(ctx, ...)` reads THIS instead of the static
  // role default. Used to model an admin who's been granted
  // maintenance_requests:configure via the EXISTING per-user override
  // system (role-permission-matrix.tsx), exactly like Andrew's real grant
  // path (Task 26's ship checklist).
  permissions: undefined as Set<string> | undefined,
  mfaRequired: false,
  mfaSatisfied: true,
};

// Captured update payload + the settings the "read" returns, plus a knob to
// simulate a missing module row (0-row update -> fail closed).
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
      permissions: sessionState.permissions,
      supabase: makeClient(),
      mfaRequired: sessionState.mfaRequired,
      mfaSatisfied: sessionState.mfaSatisfied,
      enabledModules: new Set(['maintenance_requests']),
    })),
  };
});

import { audit } from '@/server/services/audit';

import { updateMaintenanceSettingsAction } from './maintenance-settings';

const VALID = { categories: ['Facilities', 'Electrical'], includeShareLinksInEmail: true };

describe('updateMaintenanceSettingsAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionState.role = 'owner';
    sessionState.permissions = undefined;
    sessionState.mfaRequired = false;
    sessionState.mfaSatisfied = true;
    dbState.existingSettings = {};
    dbState.updatePayload = undefined;
    dbState.moduleRowExists = true;
  });

  // ── C2: configure is owner-only by design ───────────────────────────────
  describe('configure gate (C2 — owner-only, filtered from admin default set)', () => {
    it('rejects an admin with NO explicit override — forbidden, no write', async () => {
      sessionState.role = 'admin';
      // No `permissions` override -> can() falls back to the static ROLE_PERMISSIONS
      // default, which filters maintenance_requests:configure OUT of admin.
      const r = await updateMaintenanceSettingsAction(VALID);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('forbidden');
      expect(updateSpy).not.toHaveBeenCalled();
      expect(audit).not.toHaveBeenCalled();
    });

    it('rejects manager and staff too', async () => {
      for (const role of ['manager', 'staff', 'viewer'] as const) {
        sessionState.role = role;
        const r = await updateMaintenanceSettingsAction(VALID);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.code).toBe('forbidden');
      }
      expect(updateSpy).not.toHaveBeenCalled();
    });

    it('allows the owner', async () => {
      sessionState.role = 'owner';
      const r = await updateMaintenanceSettingsAction(VALID);
      expect(r.ok).toBe(true);
      expect(updateSpy).toHaveBeenCalledTimes(1);
    });

    it('allows an admin who HOLDS an explicit per-user configure override (Andrew\'s real grant path — role-permission-matrix.tsx / setUserPermissionOverrideAction, not a parallel mechanism)', async () => {
      sessionState.role = 'admin';
      sessionState.permissions = new Set([
        'maintenance_requests:submit',
        'maintenance_requests:read_all',
        'maintenance_requests:manage',
        'maintenance_requests:configure',
      ]);
      const r = await updateMaintenanceSettingsAction(VALID);
      expect(r.ok).toBe(true);
      expect(updateSpy).toHaveBeenCalledTimes(1);
    });
  });

  it('rejects an AAL1 session when the org requires MFA — forbidden, no write (fail closed)', async () => {
    sessionState.mfaRequired = true;
    sessionState.mfaSatisfied = false;
    const r = await updateMaintenanceSettingsAction(VALID);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('forbidden');
    expect(updateSpy).not.toHaveBeenCalled();
  });

  // ── Validation ───────────────────────────────────────────────────────────
  it('rejects an empty categories array — validation_error, no write', async () => {
    const r = await updateMaintenanceSettingsAction({ categories: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('validation_error');
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('rejects a blank category string — validation_error, no write', async () => {
    const r = await updateMaintenanceSettingsAction({ categories: ['Facilities', '   '] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('validation_error');
  });

  it('rejects a notifyAudience key that is not a uuid — validation_error, no write', async () => {
    const r = await updateMaintenanceSettingsAction({
      notifyAudience: { 'not-a-uuid': 'all' } as never,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('validation_error');
  });

  it('rejects an invalid notifyAudience mode — validation_error, no write', async () => {
    const r = await updateMaintenanceSettingsAction({
      notifyAudience: { '11111111-1111-1111-1111-111111111111': 'sometimes' } as never,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('validation_error');
  });

  // ── PIN: recipients can never be overridden from client input ──────────
  // The schema has NO field a recipient value could land in, and is
  // `.strict()` — an unrecognized key is a hard rejection, never a silent
  // strip (mirrors maintenanceRequestFormSchema's own documented rationale,
  // packages/core/src/schemas/maintenance.ts).
  it('rejects an unrecognized key (e.g. a recipient-shaped field) — validation_error, no write, pinning that recipients can never be client input', async () => {
    const r = await updateMaintenanceSettingsAction({
      categories: ['Facilities'],
      recipientTo: 'attacker@example.com',
    } as never);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('validation_error');
    expect(updateSpy).not.toHaveBeenCalled();
  });

  // ── Persistence + audit ──────────────────────────────────────────────────
  it('persists a valid patch + audits maintenance_request.settings_updated', async () => {
    const r = await updateMaintenanceSettingsAction(VALID);
    expect(r.ok).toBe(true);
    expect(updateSpy).toHaveBeenCalledTimes(1);
    const payload = dbState.updatePayload as { settings: Record<string, unknown> };
    expect(payload.settings.categories).toEqual(['Facilities', 'Electrical']);
    expect(payload.settings.includeShareLinksInEmail).toBe(true);
    expect(audit).toHaveBeenCalledTimes(1);
    expect(vi.mocked(audit).mock.calls[0]?.[0].event).toBe('maintenance_request.settings_updated');
  });

  it('dedupes case-insensitive duplicate category names, preserving the first casing', async () => {
    const r = await updateMaintenanceSettingsAction({
      categories: ['Facilities', 'facilities', 'Electrical'],
    });
    expect(r.ok).toBe(true);
    const payload = dbState.updatePayload as { settings: Record<string, unknown> };
    expect(payload.settings.categories).toEqual(['Facilities', 'Electrical']);
  });

  it('persists a valid notifyAudience map', async () => {
    const uid = '11111111-1111-1111-1111-111111111111';
    const r = await updateMaintenanceSettingsAction({ notifyAudience: { [uid]: 'urgent_only' } });
    expect(r.ok).toBe(true);
    const payload = dbState.updatePayload as { settings: Record<string, unknown> };
    expect(payload.settings.notifyAudience).toEqual({ [uid]: 'urgent_only' });
  });

  // ── REQUIRED merge test: never clobber a sibling key that wasn't in the
  // patch. This is the exact landmine class recorded for auto-archive vs
  // auto-delete-archived siblings inside `inventory`'s settings row — here
  // the three maintenance keys (categories / includeShareLinksInEmail /
  // notifyAudience) are themselves siblings of each other AND of any future
  // key this jsonb blob might grow. ─────────────────────────────────────────
  it('MERGES into existing settings — a categories-only patch does not clobber the existing includeShareLinksInEmail or notifyAudience siblings, or an unrelated future key', async () => {
    const uid = '22222222-2222-2222-2222-222222222222';
    dbState.existingSettings = {
      includeShareLinksInEmail: false,
      notifyAudience: { [uid]: 'all' },
      someFutureKey: 'keep-me',
    };
    const r = await updateMaintenanceSettingsAction({ categories: ['Technology'] });
    expect(r.ok).toBe(true);
    const payload = dbState.updatePayload as { settings: Record<string, unknown> };
    expect(payload.settings.categories).toEqual(['Technology']);
    expect(payload.settings.includeShareLinksInEmail).toBe(false);
    expect(payload.settings.notifyAudience).toEqual({ [uid]: 'all' });
    expect(payload.settings.someFutureKey).toBe('keep-me');
  });

  it('an includeShareLinksInEmail-only patch does not clobber existing categories', async () => {
    dbState.existingSettings = { categories: ['Plumbing', 'Vehicle'] };
    const r = await updateMaintenanceSettingsAction({ includeShareLinksInEmail: false });
    expect(r.ok).toBe(true);
    const payload = dbState.updatePayload as { settings: Record<string, unknown> };
    expect(payload.settings.categories).toEqual(['Plumbing', 'Vehicle']);
    expect(payload.settings.includeShareLinksInEmail).toBe(false);
  });

  it('fails closed when the module row is missing (0-row update) — internal_error, no audit', async () => {
    dbState.moduleRowExists = false;
    const r = await updateMaintenanceSettingsAction(VALID);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('internal_error');
    expect(audit).not.toHaveBeenCalled();
  });
});
