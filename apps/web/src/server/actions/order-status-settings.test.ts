import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub } from '@/test/supabase-mock';

import type { OrderStatusConfig } from '@stockpilot/core';

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

import { setOrderStatusConfigAction } from './order-status-settings';

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

describe('setOrderStatusConfigAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionState.role = 'owner';
    sessionState.mfaRequired = false;
    sessionState.mfaSatisfied = true;
    stubHolder.stub = null;
  });

  it('returns forbidden for a non-admin (staff) role, no write', async () => {
    sessionState.role = 'staff';
    const { stub, updateSpy } = stubWithUpdateSpy();
    stubHolder.stub = stub;

    const result = await setOrderStatusConfigAction({
      approved: { label: 'OK' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('forbidden');
    expect(updateSpy).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it('rejects an AAL1 session when the org requires MFA (forbidden, no write)', async () => {
    sessionState.mfaRequired = true;
    sessionState.mfaSatisfied = false;
    const { stub, updateSpy } = stubWithUpdateSpy();
    stubHolder.stub = stub;

    const result = await setOrderStatusConfigAction({ approved: { label: 'OK' } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('forbidden');
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('rejects an unknown status key (validation_error, no write)', async () => {
    const { stub, updateSpy } = stubWithUpdateSpy();
    stubHolder.stub = stub;

    const result = await setOrderStatusConfigAction({
      not_a_status: { label: 'Hax' },
    } as unknown as OrderStatusConfig);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('validation_error');
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('rejects a disallowed color token (validation_error, no write)', async () => {
    const { stub, updateSpy } = stubWithUpdateSpy();
    stubHolder.stub = stub;

    const result = await setOrderStatusConfigAction({
      approved: { color: 'neon' as never },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('validation_error');
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('rejects an over-long label (> 60 chars) as validation_error', async () => {
    const { stub, updateSpy } = stubWithUpdateSpy();
    stubHolder.stub = stub;

    const result = await setOrderStatusConfigAction({
      approved: { label: 'x'.repeat(61) },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('validation_error');
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('rejects an empty override entry (validation_error, no write)', async () => {
    const { stub, updateSpy } = stubWithUpdateSpy();
    stubHolder.stub = stub;

    const result = await setOrderStatusConfigAction({ approved: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('validation_error');
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('persists a valid config + audits order_status_config.updated', async () => {
    const { stub, updateSpy } = stubWithUpdateSpy();
    stubHolder.stub = stub;

    const config: OrderStatusConfig = {
      pending_approval: { label: 'Awaiting sign-off', color: 'destructive' },
      completed: { label: 'Fulfilled' },
    };

    const result = await setOrderStatusConfigAction(config);
    expect(result.ok).toBe(true);
    expect(updateSpy).toHaveBeenCalledTimes(1);
    const payload = updateSpy.mock.calls[0]?.[0] as { order_status_config: OrderStatusConfig };
    expect(payload.order_status_config.pending_approval?.label).toBe('Awaiting sign-off');
    expect(payload.order_status_config.pending_approval?.color).toBe('destructive');
    expect(audit).toHaveBeenCalledTimes(1);
    expect(vi.mocked(audit).mock.calls[0]?.[0].event).toBe('order_status_config.updated');
  });

  it('reset (null) clears the override and audits', async () => {
    const { stub, updateSpy } = stubWithUpdateSpy();
    stubHolder.stub = stub;

    const result = await setOrderStatusConfigAction(null);
    expect(result.ok).toBe(true);
    expect(updateSpy).toHaveBeenCalledTimes(1);
    const payload = updateSpy.mock.calls[0]?.[0] as {
      order_status_config: OrderStatusConfig | null;
    };
    expect(payload.order_status_config).toBeNull();
    expect(audit).toHaveBeenCalledTimes(1);
  });
});
