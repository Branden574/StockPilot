import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub } from '@/test/supabase-mock';

vi.mock('next/cache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/cache')>();
  return { ...actual, revalidatePath: vi.fn() };
});

// Mutable session/MFA state so per-test role + AAL overrides work.
const sessionState = {
  role: 'owner' as 'owner' | 'admin' | 'manager' | 'staff' | 'viewer',
  mfaRequired: false,
  mfaSatisfied: true,
  enabledModules: new Set<string>(['purchase_orders']),
  // The effective permission set, when a test models an override; unset, can()
  // falls back to the role's defaults.
  permissions: undefined as Set<string> | undefined,
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
      ...(sessionState.permissions ? { permissions: sessionState.permissions } : {}),
    })),
  };
});

// Stable service instance mock — defined OUTSIDE vi.mock so vi.clearAllMocks()
// only clears call history, not the object itself.
const mockServiceInstance = {
  create: vi.fn(async () => ({ id: 'tpl-1' })),
  update: vi.fn(async () => ({ id: 'tpl-1' })),
  setEnabled: vi.fn(async () => ({ id: 'tpl-1' })),
  remove: vi.fn(async () => undefined),
  seedFromPo: vi.fn(async () => ({
    supplierId: 'sup-1',
    destinationLocationId: null,
    lineItems: [{ itemId: '00000000-0000-0000-0000-000000000001', quantityOrdered: 2, unitCost: 10 }],
  })),
};

// Use importOriginal so the real recurringTemplateSchema Zod export is
// preserved while only the service class is mocked.
vi.mock('@/server/services/recurring-pos', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/services/recurring-pos')>();
  return {
    ...actual,
    RecurringPoTemplatesService: vi.fn(function () {
      return mockServiceInstance;
    }),
  };
});

// Convenience aliases for assertions.
const mockCreate = mockServiceInstance.create;
const mockUpdate = mockServiceInstance.update;
const mockSetEnabled = mockServiceInstance.setEnabled;
const mockRemove = mockServiceInstance.remove;
const mockSeedFromPo = mockServiceInstance.seedFromPo;

import { revalidatePath } from 'next/cache';

import {
  createRecurringTemplateAction,
  deleteRecurringTemplateAction,
  seedRecurringTemplateFromPoAction,
  setRecurringTemplateEnabledAction,
  updateRecurringTemplateAction,
} from './recurring-pos';

// Minimal valid template input for tests.
const validInput = {
  name: 'Weekly Supplies',
  cadence: 'weekly' as const,
  sendMode: 'draft' as const,
  lineItems: [{ itemId: '00000000-0000-0000-0000-000000000001', quantityOrdered: 2, unitCost: 10 }],
};

// Org row returned when querying organizations for the plan gate.
const PRO_ORG_ROW = {
  plan: 'pro',
  access_tier: null,
  billing_arrangement: null,
  stripe_subscription_id: null,
  trial_ends_at: null,
  trial_tier: null,
};

const FREE_ORG_ROW = {
  plan: 'free',
  access_tier: null,
  billing_arrangement: null,
  stripe_subscription_id: null,
  trial_ends_at: null,
  trial_tier: null,
};

// Every test starts from the role's default permissions.
beforeEach(() => {
  sessionState.permissions = undefined;
});

function makeStubWithOrgPlan(orgRow: Record<string, unknown>) {
  return makeSupabaseStub({
    'organizations.select': { data: orgRow, error: null },
    'recurring_po_templates.insert': { data: { id: 'tpl-1' }, error: null },
    'recurring_po_templates.update': { data: { id: 'tpl-1' }, error: null },
    'recurring_po_templates.delete': { data: { id: 'tpl-1' }, error: null },
  });
}

describe('createRecurringTemplateAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionState.role = 'owner';
    sessionState.mfaRequired = false;
    sessionState.mfaSatisfied = true;
    sessionState.enabledModules = new Set(['purchase_orders']);
    stubHolder.stub = makeStubWithOrgPlan(PRO_ORG_ROW);
  });

  it('blocks Free-plan orgs (plan_limit_exceeded, no service call)', async () => {
    stubHolder.stub = makeStubWithOrgPlan(FREE_ORG_ROW);
    const result = await createRecurringTemplateAction(validInput);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('plan_limit_exceeded');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('blocks when MFA is required but not satisfied (fail-closed)', async () => {
    sessionState.mfaRequired = true;
    sessionState.mfaSatisfied = false;
    const result = await createRecurringTemplateAction(validInput);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('forbidden');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('blocks a role without purchase_orders:manage (staff)', async () => {
    sessionState.role = 'staff';
    const result = await createRecurringTemplateAction(validInput);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('forbidden');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('blocks when purchase_orders module is disabled', async () => {
    sessionState.enabledModules = new Set();
    const result = await createRecurringTemplateAction(validInput);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('forbidden');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('happy path: calls service.create + revalidates', async () => {
    const result = await createRecurringTemplateAction(validInput);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual({ id: 'tpl-1' });
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(revalidatePath).toHaveBeenCalledWith('/dashboard/purchase-orders/recurring');
  });

  it('returns validation_error for empty name', async () => {
    const result = await createRecurringTemplateAction({ ...validInput, name: '' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('validation_error');
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

describe('updateRecurringTemplateAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionState.role = 'owner';
    sessionState.mfaRequired = false;
    sessionState.mfaSatisfied = true;
    sessionState.enabledModules = new Set(['purchase_orders']);
    stubHolder.stub = makeStubWithOrgPlan(PRO_ORG_ROW);
  });

  it('blocks Free-plan orgs (plan_limit_exceeded, no service call)', async () => {
    stubHolder.stub = makeStubWithOrgPlan(FREE_ORG_ROW);
    const result = await updateRecurringTemplateAction('tpl-1', validInput);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('plan_limit_exceeded');
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('blocks when MFA required but not satisfied', async () => {
    sessionState.mfaRequired = true;
    sessionState.mfaSatisfied = false;
    const result = await updateRecurringTemplateAction('tpl-1', validInput);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('forbidden');
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('happy path: calls service.update + revalidates', async () => {
    const result = await updateRecurringTemplateAction('tpl-1', validInput);
    expect(result.ok).toBe(true);
    expect(mockUpdate).toHaveBeenCalledWith('tpl-1', validInput);
    expect(revalidatePath).toHaveBeenCalledWith('/dashboard/purchase-orders/recurring');
  });
});

describe('setRecurringTemplateEnabledAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionState.role = 'owner';
    sessionState.mfaRequired = false;
    sessionState.mfaSatisfied = true;
    sessionState.enabledModules = new Set(['purchase_orders']);
    stubHolder.stub = makeStubWithOrgPlan(PRO_ORG_ROW);
  });

  it('blocks Free-plan when enabling (plan_limit_exceeded)', async () => {
    stubHolder.stub = makeStubWithOrgPlan(FREE_ORG_ROW);
    const result = await setRecurringTemplateEnabledAction('tpl-1', true);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('plan_limit_exceeded');
    expect(mockSetEnabled).not.toHaveBeenCalled();
  });

  it('allows Free-plan when DISABLING (can always turn off)', async () => {
    stubHolder.stub = makeStubWithOrgPlan(FREE_ORG_ROW);
    const result = await setRecurringTemplateEnabledAction('tpl-1', false);
    expect(result.ok).toBe(true);
    expect(mockSetEnabled).toHaveBeenCalledWith('tpl-1', false);
  });

  it('happy path enable: calls service.setEnabled + revalidates', async () => {
    const result = await setRecurringTemplateEnabledAction('tpl-1', true);
    expect(result.ok).toBe(true);
    expect(mockSetEnabled).toHaveBeenCalledWith('tpl-1', true);
    expect(revalidatePath).toHaveBeenCalledWith('/dashboard/purchase-orders/recurring');
  });
});

describe('deleteRecurringTemplateAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionState.role = 'owner';
    sessionState.mfaRequired = false;
    sessionState.mfaSatisfied = true;
    sessionState.enabledModules = new Set(['purchase_orders']);
    stubHolder.stub = makeStubWithOrgPlan(PRO_ORG_ROW);
  });

  it('blocks MFA-required + unsatisfied', async () => {
    sessionState.mfaRequired = true;
    sessionState.mfaSatisfied = false;
    const result = await deleteRecurringTemplateAction('tpl-1');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('forbidden');
    expect(mockRemove).not.toHaveBeenCalled();
  });

  it('blocks staff role (no manage permission)', async () => {
    sessionState.role = 'staff';
    const result = await deleteRecurringTemplateAction('tpl-1');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('forbidden');
    expect(mockRemove).not.toHaveBeenCalled();
  });

  it('happy path: calls service.remove + revalidates', async () => {
    const result = await deleteRecurringTemplateAction('tpl-1');
    expect(result.ok).toBe(true);
    expect(mockRemove).toHaveBeenCalledWith('tpl-1');
    expect(revalidatePath).toHaveBeenCalledWith('/dashboard/purchase-orders/recurring');
  });
});

describe('seedRecurringTemplateFromPoAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionState.role = 'owner';
    sessionState.mfaRequired = false;
    sessionState.mfaSatisfied = true;
    sessionState.enabledModules = new Set(['purchase_orders']);
    stubHolder.stub = makeStubWithOrgPlan(PRO_ORG_ROW);
  });

  it('blocks MFA-required + unsatisfied', async () => {
    sessionState.mfaRequired = true;
    sessionState.mfaSatisfied = false;
    const result = await seedRecurringTemplateFromPoAction('po-1');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('forbidden');
    expect(mockSeedFromPo).not.toHaveBeenCalled();
  });

  it('blocks staff role', async () => {
    sessionState.role = 'staff';
    const result = await seedRecurringTemplateFromPoAction('po-1');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('forbidden');
    expect(mockSeedFromPo).not.toHaveBeenCalled();
  });

  it('happy path: calls service.seedFromPo + returns seed payload', async () => {
    const result = await seedRecurringTemplateFromPoAction('po-1');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.supplierId).toBe('sup-1');
      expect(result.data.lineItems).toHaveLength(1);
    }
    expect(mockSeedFromPo).toHaveBeenCalledWith('po-1');
    // seed action does NOT revalidate (read-only)
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

// Since migration 0423 writing a purchase order needs View purchase orders, and
// the database holds recurring templates (which the daily run turns into
// purchase orders as an owner) to the same rule. The gate refuses a manager
// whose View purchase orders is turned off before the plan is read, so they
// hear what is really missing.
describe('the recurring template actions need purchase_orders:read', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionState.role = 'manager';
    sessionState.mfaRequired = false;
    sessionState.mfaSatisfied = true;
    sessionState.enabledModules = new Set(['purchase_orders']);
    sessionState.permissions = new Set(['purchase_orders:manage']);
    // A Free org: a gate that read the plan first would answer plan_limit_exceeded.
    stubHolder.stub = makeStubWithOrgPlan(FREE_ORG_ROW);
  });

  const cases: Array<
    [string, () => Promise<{ ok: boolean; error?: { code: string } }>, ReturnType<typeof vi.fn>]
  > = [
    ['create', () => createRecurringTemplateAction(validInput) as never, mockCreate],
    ['update', () => updateRecurringTemplateAction('tpl-1', validInput) as never, mockUpdate],
    ['enable', () => setRecurringTemplateEnabledAction('tpl-1', true) as never, mockSetEnabled],
    ['delete', () => deleteRecurringTemplateAction('tpl-1') as never, mockRemove],
    ['seed', () => seedRecurringTemplateFromPoAction('po-1') as never, mockSeedFromPo],
  ];

  it.each(cases)(
    '%s: refused as forbidden without it, before the plan is read, and the service is not called',
    async (_name, run, svcFn) => {
      const result = await run();
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error?.code).toBe('forbidden');
      expect(svcFn).not.toHaveBeenCalled();
      expect(stubHolder.stub!.fromCalls).toEqual([]);
    },
  );

  it('a manager holding it is let through to the service', async () => {
    sessionState.permissions = new Set(['purchase_orders:manage', 'purchase_orders:read']);
    stubHolder.stub = makeStubWithOrgPlan(PRO_ORG_ROW);
    const result = await createRecurringTemplateAction(validInput);
    expect(result.ok).toBe(true);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });
});
