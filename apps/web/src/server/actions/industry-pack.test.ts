import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub } from '@/test/supabase-mock';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

// Mutable session/MFA state so per-test role + AAL overrides work (mirrors
// module-settings.test.ts).
const sessionState = {
  role: 'owner' as 'owner' | 'admin' | 'manager' | 'staff' | 'viewer',
  mfaRequired: false,
  mfaSatisfied: true,
};

const stubHolder: { stub: ReturnType<typeof makeSupabaseStub> | null } = { stub: null };

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
import { MODULE_REGISTRY, modulesForPack, type DomainPack } from '@stockpilot/core';

import { applyIndustryPackAction } from './industry-pack';

/**
 * Build a stub seeded with the org row + currently-enabled modules, and wire
 * spies for organization_modules.upsert and organizations.update. Returns the
 * spies so each test can assert what was written.
 */
function setup(opts: {
  enabledModules?: string[];
  domainPack?: string | null;
  terminology?: Record<string, string> | null;
  /** Row returned by the organizations UPDATE .select('id').maybeSingle().
   *  `null` simulates a 0-row (RLS no-match) update. Defaults to a real row. */
  updatedOrgRow?: { id: string } | null;
}) {
  const upsertSpy = vi.fn((..._args: unknown[]) => ({
    then: (resolve: (v: { error: null }) => void) => resolve({ error: null }),
  }));
  // The action now appends `.select('id').maybeSingle()` and fails closed on a
  // 0-row update, so the spy's chain must terminate in a maybeSingle() that
  // resolves a row. `updatedOrgRow` lets a test simulate the 0-row case.
  const updatedOrgRow =
    'updatedOrgRow' in opts ? opts.updatedOrgRow : { id: 'org-1' };
  const updateSpy = vi.fn((..._args: unknown[]) => ({
    eq: () => ({
      select: () => ({
        maybeSingle: () => Promise.resolve({ data: updatedOrgRow, error: null }),
      }),
    }),
  }));

  const stub = makeSupabaseStub({
    'organizations.select': {
      data: [{ domain_pack: opts.domainPack ?? null, terminology: opts.terminology ?? null }],
      error: null,
    },
    'organization_modules.select': {
      data: (opts.enabledModules ?? []).map((id) => ({ module_id: id, enabled: true })),
      error: null,
    },
  });

  const originalFrom = stub.client.from.bind(stub.client);
  stub.client.from = vi.fn((table: string) => {
    const chain = originalFrom(table);
    if (table === 'organization_modules') {
      return new Proxy(chain as object, {
        get(target, prop: string) {
          if (prop === 'upsert') return upsertSpy;
          return (target as Record<string, unknown>)[prop];
        },
      });
    }
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

  stubHolder.stub = stub;
  return { upsertSpy, updateSpy };
}

describe('applyIndustryPackAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionState.role = 'owner';
    sessionState.mfaRequired = false;
    sessionState.mfaSatisfied = true;
    stubHolder.stub = null;
  });

  it('rejects an unknown pack as validation_error (no writes)', async () => {
    const { upsertSpy, updateSpy } = setup({});
    const result = await applyIndustryPackAction({ pack: 'nope' as DomainPack });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('validation_error');
    expect(upsertSpy).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it('rejects an AAL1 session when the org requires MFA (forbidden, no write)', async () => {
    sessionState.mfaRequired = true;
    sessionState.mfaSatisfied = false;
    const { upsertSpy, updateSpy } = setup({});
    const result = await applyIndustryPackAction({ pack: 'distribution' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('forbidden');
    expect(upsertSpy).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it('returns forbidden for staff role (no write)', async () => {
    sessionState.role = 'staff';
    const { upsertSpy, updateSpy } = setup({});
    const result = await applyIndustryPackAction({ pack: 'distribution' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('forbidden');
    expect(upsertSpy).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('enables exactly the pack non-core module set + sets domain_pack', async () => {
    // Start from an org with NO optional modules enabled.
    const { upsertSpy, updateSpy } = setup({ enabledModules: [], domainPack: 'charter_school' });

    const result = await applyIndustryPackAction({ pack: 'distribution' });
    expect(result.ok).toBe(true);

    // The non-core pack module set is what we expect to enable.
    const expectedNonCore = modulesForPack('distribution').filter(
      (id) => MODULE_REGISTRY[id].tier !== 'core',
    );
    expect(expectedNonCore.length).toBeGreaterThan(0);

    expect(upsertSpy).toHaveBeenCalledTimes(1);
    const rows = upsertSpy.mock.calls[0]?.[0] as Array<{ module_id: string; enabled: boolean }>;
    const upsertedIds = rows.map((r) => r.module_id).sort();
    expect(upsertedIds).toEqual([...expectedNonCore].sort());
    // No core modules written.
    expect(rows.every((r) => MODULE_REGISTRY[r.module_id as keyof typeof MODULE_REGISTRY].tier !== 'core')).toBe(true);
    // All enabled=true, with enable provenance stamped.
    expect(rows.every((r) => r.enabled === true)).toBe(true);
    expect(rows.every((r) => 'enabled_at' in r && 'enabled_by' in r)).toBe(true);

    // organizations.update set domain_pack = 'distribution'.
    expect(updateSpy).toHaveBeenCalledTimes(1);
    const patch = updateSpy.mock.calls[0]?.[0] as { domain_pack: string };
    expect(patch.domain_pack).toBe('distribution');

    // audited once.
    expect(audit).toHaveBeenCalledTimes(1);
    expect(vi.mocked(audit).mock.calls[0]?.[0].event).toBe('industry_pack.applied');
  });

  it('is NON-DESTRUCTIVE: does not re-write modules already enabled outside the pack', async () => {
    // 'returns' is OFF for every pack — pre-enable it and confirm it stays.
    const { upsertSpy } = setup({ enabledModules: ['returns'], domainPack: null });
    const result = await applyIndustryPackAction({ pack: 'distribution' });
    expect(result.ok).toBe(true);

    const rows = upsertSpy.mock.calls[0]?.[0] as Array<{ module_id: string }>;
    // 'returns' is never disabled and is not part of the distribution pack, so
    // it must not appear in the upsert batch at all.
    expect(rows.map((r) => r.module_id)).not.toContain('returns');
    // The returned enabled set still contains 'returns' (left as-is).
    if (result.ok) expect(result.data.enabled).toContain('returns');
  });

  it('merges preset terminology only where the org has NOT customized it', async () => {
    // Org already customized charter_singular; warehouse labels are default.
    const { updateSpy } = setup({
      domainPack: null,
      terminology: { charter_singular: 'My Campus' },
    });
    const result = await applyIndustryPackAction({ pack: 'retail_backroom' });
    expect(result.ok).toBe(true);

    const patch = updateSpy.mock.calls[0]?.[0] as {
      domain_pack: string;
      terminology?: Record<string, string>;
    };
    expect(patch.domain_pack).toBe('retail_backroom');
    // retail_backroom preset suggests Store/Stores + Backroom/Backrooms.
    // The org's existing charter_singular MUST be preserved (not clobbered).
    expect(patch.terminology?.charter_singular).toBe('My Campus');
    // The non-customized warehouse labels get the preset's suggestion.
    expect(patch.terminology?.warehouse_singular).toBe('Backroom');
  });

  it('is idempotent: re-applying writes no new module rows and no terminology change', async () => {
    // Org already has the full distribution non-core set + domain_pack set, and
    // the preset terminology already applied.
    const distNonCore = modulesForPack('distribution').filter(
      (id) => MODULE_REGISTRY[id].tier !== 'core',
    );
    const { upsertSpy, updateSpy } = setup({
      enabledModules: distNonCore,
      domainPack: 'distribution',
      terminology: { charter_singular: 'Account', charter_plural: 'Accounts' },
    });

    const result = await applyIndustryPackAction({ pack: 'distribution' });
    expect(result.ok).toBe(true);

    // No module rows to enable -> upsert never called.
    expect(upsertSpy).not.toHaveBeenCalled();
    // domain_pack is still written (idempotent set), but terminology is omitted
    // since nothing changed.
    expect(updateSpy).toHaveBeenCalledTimes(1);
    const patch = updateSpy.mock.calls[0]?.[0] as {
      domain_pack: string;
      terminology?: unknown;
    };
    expect(patch.domain_pack).toBe('distribution');
    expect('terminology' in patch).toBe(false);
  });

  it('fails CLOSED when the organization_modules read errors (no writes)', async () => {
    const upsertSpy = vi.fn();
    const updateSpy = vi.fn();
    const stub = makeSupabaseStub({
      'organizations.select': { data: [{ domain_pack: null, terminology: null }], error: null },
      'organization_modules.select': { data: null, error: { message: 'boom' } },
    });
    const originalFrom = stub.client.from.bind(stub.client);
    stub.client.from = vi.fn((table: string) => {
      const chain = originalFrom(table);
      if (table === 'organization_modules') {
        return new Proxy(chain as object, {
          get(target, prop: string) {
            if (prop === 'upsert') return upsertSpy;
            return (target as Record<string, unknown>)[prop];
          },
        });
      }
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
    stubHolder.stub = stub;

    const result = await applyIndustryPackAction({ pack: 'distribution' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('internal_error');
    expect(upsertSpy).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('fails CLOSED on a 0-row organizations UPDATE (no error, no row persisted)', async () => {
    // A row-count-0 update (RLS no-match) returns no error AND no row. The
    // action must treat that as a failure rather than reporting ok — otherwise
    // the UI shows the template Active while domain_pack never changed.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { updateSpy } = setup({ enabledModules: [], updatedOrgRow: null });

    const result = await applyIndustryPackAction({ pack: 'distribution' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('internal_error');
    // The update WAS attempted (we didn't bail before it) ...
    expect(updateSpy).toHaveBeenCalledTimes(1);
    // ... but the 0-row result means we must NOT have audited a phantom change.
    expect(audit).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
