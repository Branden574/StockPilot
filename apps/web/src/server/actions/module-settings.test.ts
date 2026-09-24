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

/**
 * S6-A: Rentals cannot be switched off while rentals are out.
 *
 * With the module off nobody can return or cancel (the service and
 * return_rental/cancel_rental both assert it), so the rentals' holds keep
 * items unavailable with no rental in sight. A comped organization keeps
 * access whatever its switch says, so it may switch off. The count read fails
 * closed.
 */
describe('setModuleEnabledAction: switching Rentals off while rentals are out', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionState.role = 'admin';
    sessionState.mfaRequired = false;
    sessionState.mfaSatisfied = true;
    stubHolder.stub = null;
  });

  type Result = { data: unknown; error: { message: string; code?: string } | null; count?: number | null };

  function arrange(opts: {
    org?: Result;
    rentalsCount?: Result;
    enabledRows?: Array<{ module_id: string; enabled: boolean }>;
  }) {
    const upsertSpy = vi.fn((..._args: unknown[]) => ({
      then: (resolve: (v: { error: null }) => void) => resolve({ error: null }),
    }));
    stubHolder.stub = makeSupabaseStub({
      'organization_modules.select': {
        data: opts.enabledRows ?? [{ module_id: 'rentals', enabled: true }],
        error: null,
      },
      'organizations.select': opts.org ?? { data: { all_modules_comp: false }, error: null },
      'rentals.select': opts.rentalsCount ?? { data: null, error: null, count: 0 },
    });
    const stub = stubHolder.stub;
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
      return chain;
    });
    return { stub, upsertSpy };
  }

  // Mutation caught: the guard removed, so the switch goes off and strands
  // two rentals.
  it('refuses with a conflict naming how many are out, and writes nothing', async () => {
    const { stub, upsertSpy } = arrange({ rentalsCount: { data: null, error: null, count: 2 } });

    const result = await setModuleEnabledAction({ moduleId: 'rentals', enabled: false });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('conflict');
      expect(result.error.message).toBe(
        '2 rentals are still out. Return or cancel them before turning Rentals off.',
      );
    }
    expect(upsertSpy).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
    // The count is this org's rentals that are OUT, and a head-only count.
    const [countChain] = stub.chainArgsAll.get('rentals.select') ?? [];
    expect(countChain).toEqual([
      ['id', { count: 'exact', head: true }],
      ['organization_id', 'org-1'],
      ['status', 'out'],
    ]);
  });

  it('uses the singular for one rental', async () => {
    arrange({ rentalsCount: { data: null, error: null, count: 1 } });
    const result = await setModuleEnabledAction({ moduleId: 'rentals', enabled: false });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe(
        '1 rental is still out. Return or cancel it before turning Rentals off.',
      );
    }
  });

  // Mutation caught: the count error ignored, so a failed read reads as
  // "none out" and the switch goes off.
  it('fails closed when the count read errors: internal_error, no write', async () => {
    const { upsertSpy } = arrange({
      rentalsCount: { data: null, error: { message: 'canceling statement due to statement timeout' } },
    });
    const result = await setModuleEnabledAction({ moduleId: 'rentals', enabled: false });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('internal_error');
      expect(result.error.message).not.toContain('statement timeout');
    }
    expect(upsertSpy).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it('fails closed when the count comes back without a number', async () => {
    const { upsertSpy } = arrange({ rentalsCount: { data: null, error: null, count: null } });
    const result = await setModuleEnabledAction({ moduleId: 'rentals', enabled: false });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('internal_error');
    expect(upsertSpy).not.toHaveBeenCalled();
  });

  // Mutation caught: the guard ignoring the comp, which would block a comped
  // org (whose members keep access with the switch off) for no reason.
  it('lets a comped organization switch Rentals off with rentals out, without counting', async () => {
    const { stub, upsertSpy } = arrange({
      org: { data: { all_modules_comp: true }, error: null },
      rentalsCount: { data: null, error: null, count: 3 },
    });
    const result = await setModuleEnabledAction({ moduleId: 'rentals', enabled: false });
    expect(result.ok).toBe(true);
    expect(upsertSpy).toHaveBeenCalledTimes(1);
    const rows = upsertSpy.mock.calls[0]?.[0] as Array<{ module_id: string; enabled: boolean }>;
    expect(rows).toEqual([expect.objectContaining({ module_id: 'rentals', enabled: false })]);
    expect(stub.fromCalls).not.toContain('rentals');
  });

  // Mutation caught: an unreadable comp flag treated as comped, which lets a
  // non-comped org strand its rentals whenever that read blips.
  it('an unreadable comp flag grants nothing: the count still decides', async () => {
    const { upsertSpy } = arrange({
      org: { data: null, error: { message: 'connection reset' } },
      rentalsCount: { data: null, error: null, count: 1 },
    });
    const result = await setModuleEnabledAction({ moduleId: 'rentals', enabled: false });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('conflict');
    expect(upsertSpy).not.toHaveBeenCalled();
  });

  it('switches off when no rental is out', async () => {
    const { upsertSpy } = arrange({ rentalsCount: { data: null, error: null, count: 0 } });
    const result = await setModuleEnabledAction({ moduleId: 'rentals', enabled: false });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.enabled).not.toContain('rentals');
    expect(upsertSpy).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledTimes(1);
  });

  it('switching Rentals ON never counts rentals', async () => {
    const { stub, upsertSpy } = arrange({ enabledRows: [] });
    const result = await setModuleEnabledAction({ moduleId: 'rentals', enabled: true });
    expect(result.ok).toBe(true);
    expect(upsertSpy).toHaveBeenCalledTimes(1);
    expect(stub.fromCalls).not.toContain('rentals');
  });

  it('switching another module off never counts rentals', async () => {
    const { stub, upsertSpy } = arrange({
      enabledRows: [
        { module_id: 'rentals', enabled: true },
        { module_id: 'schedule', enabled: true },
      ],
    });
    const result = await setModuleEnabledAction({ moduleId: 'schedule', enabled: false });
    expect(result.ok).toBe(true);
    expect(upsertSpy).toHaveBeenCalledTimes(1);
    expect(stub.fromCalls).not.toContain('rentals');
  });
});
