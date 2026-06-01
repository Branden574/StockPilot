import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub } from '@/test/supabase-mock';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

// Mutable session/MFA state so per-test role + AAL overrides work.
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

// Resolve org context through `withContext` (the real action does too) so
// the resolved `mfaRequired`/`mfaSatisfied` booleans flow into the MFA gate.
// Mirrors profile.test.ts.
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
import type { ModuleId } from '@stockpilot/core';

import { setModuleEnabledAction } from './module-settings';

describe('setModuleEnabledAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionState.role = 'owner';
    sessionState.mfaRequired = false;
    sessionState.mfaSatisfied = true;
    stubHolder.stub = null;
  });

  it('rejects an AAL1 session when the org requires MFA (forbidden, no write)', async () => {
    // Org policy requires MFA and the session has NOT stepped up to AAL2.
    sessionState.role = 'owner';
    sessionState.mfaRequired = true;
    sessionState.mfaSatisfied = false;

    const upsertSpy = vi.fn((..._args: unknown[]) => ({
      then: (resolve: (v: { error: null }) => void) => resolve({ error: null }),
    }));
    stubHolder.stub = makeSupabaseStub({
      'organization_modules.select': { data: [], error: null },
    });
    const originalFrom = stubHolder.stub.client.from.bind(stubHolder.stub.client);
    stubHolder.stub.client.from = vi.fn((table: string) => {
      const chain = originalFrom(table);
      if (table === 'organization_modules') {
        return new Proxy(chain as object, {
          get(target, prop: string) {
            if (prop === 'upsert') return upsertSpy;
            return (target as Record<string, unknown>)[prop];
          },
        });
      }
      return chain;
    });

    const result = await setModuleEnabledAction({ moduleId: 'receiving', enabled: true });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('forbidden');
    // Fail CLOSED: no module write happened.
    expect(upsertSpy).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it('allows an AAL2 session even when the org requires MFA', async () => {
    sessionState.role = 'owner';
    sessionState.mfaRequired = true;
    sessionState.mfaSatisfied = true; // stepped up to AAL2

    const upsertSpy = vi.fn((..._args: unknown[]) => ({
      then: (resolve: (v: { error: null }) => void) => resolve({ error: null }),
    }));
    stubHolder.stub = makeSupabaseStub({
      'organization_modules.select': { data: [], error: null },
    });
    const originalFrom = stubHolder.stub.client.from.bind(stubHolder.stub.client);
    stubHolder.stub.client.from = vi.fn((table: string) => {
      const chain = originalFrom(table);
      if (table === 'organization_modules') {
        return new Proxy(chain as object, {
          get(target, prop: string) {
            if (prop === 'upsert') return upsertSpy;
            return (target as Record<string, unknown>)[prop];
          },
        });
      }
      return chain;
    });

    const result = await setModuleEnabledAction({ moduleId: 'receiving', enabled: true });

    expect(result.ok).toBe(true);
    expect(upsertSpy).toHaveBeenCalledTimes(1);
  });

  it('allows an AAL1 session when the org does NOT require MFA', async () => {
    sessionState.role = 'owner';
    sessionState.mfaRequired = false; // policy optional -> AAL1 is fine
    sessionState.mfaSatisfied = false;

    const upsertSpy = vi.fn((..._args: unknown[]) => ({
      then: (resolve: (v: { error: null }) => void) => resolve({ error: null }),
    }));
    stubHolder.stub = makeSupabaseStub({
      'organization_modules.select': { data: [], error: null },
    });
    const originalFrom = stubHolder.stub.client.from.bind(stubHolder.stub.client);
    stubHolder.stub.client.from = vi.fn((table: string) => {
      const chain = originalFrom(table);
      if (table === 'organization_modules') {
        return new Proxy(chain as object, {
          get(target, prop: string) {
            if (prop === 'upsert') return upsertSpy;
            return (target as Record<string, unknown>)[prop];
          },
        });
      }
      return chain;
    });

    const result = await setModuleEnabledAction({ moduleId: 'receiving', enabled: true });

    expect(result.ok).toBe(true);
    expect(upsertSpy).toHaveBeenCalledTimes(1);
  });

  it('rejects core moduleId (inventory) as validation_error', async () => {
    stubHolder.stub = makeSupabaseStub();
    const result = await setModuleEnabledAction({ moduleId: 'inventory' as ModuleId, enabled: false });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('validation_error');
  });

  it('rejects unknown moduleId as validation_error', async () => {
    stubHolder.stub = makeSupabaseStub();
    // Cast to bypass TypeScript; the runtime schema.refine should catch it.
    const result = await setModuleEnabledAction({ moduleId: 'nope' as ModuleId, enabled: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('validation_error');
  });

  it('returns forbidden for staff role', async () => {
    sessionState.role = 'staff';
    stubHolder.stub = makeSupabaseStub({
      'organization_modules.select': { data: [], error: null },
    });
    const result = await setModuleEnabledAction({ moduleId: 'receiving', enabled: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('forbidden');
  });

  it('enables receiving + cascades purchase_orders on, calls audit once with module.enabled', async () => {
    sessionState.role = 'owner';

    // Spy on upsert — we need to capture arguments.
    const upsertSpy = vi.fn((..._args: unknown[]) => ({
      then: (resolve: (v: { error: null }) => void) => resolve({ error: null }),
    }));

    stubHolder.stub = makeSupabaseStub({
      // DB has NO enabled modules right now.
      'organization_modules.select': { data: [], error: null },
    });

    // Override the client's from() to intercept upsert on organization_modules.
    const originalFrom = stubHolder.stub.client.from.bind(stubHolder.stub.client);
    stubHolder.stub.client.from = vi.fn((table: string) => {
      const chain = originalFrom(table);
      if (table === 'organization_modules') {
        // Wrap the chain to intercept upsert calls.
        return new Proxy(chain as object, {
          get(target, prop: string) {
            if (prop === 'upsert') {
              return upsertSpy;
            }
            return (target as Record<string, unknown>)[prop];
          },
        });
      }
      return chain;
    });

    const result = await setModuleEnabledAction({ moduleId: 'receiving', enabled: true });

    expect(result.ok).toBe(true);

    // upsert should have been called once.
    expect(upsertSpy).toHaveBeenCalledTimes(1);

    // The rows passed to upsert must include both 'receiving' and 'purchase_orders'.
    const rows = upsertSpy.mock.calls[0]?.[0] as Array<{ module_id: string; enabled: boolean }>;
    const modulesUpserted = rows.map((r) => r.module_id).sort();
    expect(modulesUpserted).toContain('receiving');
    expect(modulesUpserted).toContain('purchase_orders');
    expect(rows.every((r) => r.enabled === true)).toBe(true);

    // audit should have been called once with event 'module.enabled'.
    expect(audit).toHaveBeenCalledTimes(1);
    expect(vi.mocked(audit).mock.calls[0]?.[0].event).toBe('module.enabled');
  });

  it('disables purchase_orders + cascades receiving off, audits module.disabled, no enable-stamp', async () => {
    sessionState.role = 'owner';

    const upsertSpy = vi.fn((..._args: unknown[]) => ({
      then: (resolve: (v: { error: null }) => void) => resolve({ error: null }),
    }));

    // DB currently has purchase_orders + receiving enabled (po_imports is off).
    stubHolder.stub = makeSupabaseStub({
      'organization_modules.select': {
        data: [
          { module_id: 'purchase_orders', enabled: true },
          { module_id: 'receiving', enabled: true },
        ],
        error: null,
      },
    });
    const originalFrom = stubHolder.stub.client.from.bind(stubHolder.stub.client);
    stubHolder.stub.client.from = vi.fn((table: string) => {
      const chain = originalFrom(table);
      if (table === 'organization_modules') {
        return new Proxy(chain as object, {
          get(target, prop: string) {
            if (prop === 'upsert') return upsertSpy;
            return (target as Record<string, unknown>)[prop];
          },
        });
      }
      return chain;
    });

    const result = await setModuleEnabledAction({ moduleId: 'purchase_orders', enabled: false });
    expect(result.ok).toBe(true);

    expect(upsertSpy).toHaveBeenCalledTimes(1);
    const rows = upsertSpy.mock.calls[0]?.[0] as Array<{ module_id: string; enabled: boolean }>;
    const mods = rows.map((r) => r.module_id).sort();
    expect(mods).toContain('purchase_orders');
    expect(mods).toContain('receiving'); // cascaded off (depends on purchase_orders)
    expect(mods).not.toContain('po_imports'); // was already off -> not a change
    expect(rows.every((r) => r.enabled === false)).toBe(true);
    // I2: disabling must NOT stamp the enable provenance columns.
    expect(rows.every((r) => !('enabled_at' in r) && !('enabled_by' in r))).toBe(true);

    // audit: module.disabled, with `before` capturing the prior enabled set.
    expect(audit).toHaveBeenCalledTimes(1);
    const auditArg = vi.mocked(audit).mock.calls[0]?.[0];
    expect(auditArg?.event).toBe('module.disabled');
    expect(auditArg?.before).toEqual({
      enabled: expect.arrayContaining(['purchase_orders', 'receiving']),
    });
  });
});
