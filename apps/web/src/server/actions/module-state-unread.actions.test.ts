import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MODULE_REGISTRY, type ModuleId } from '@stockpilot/core';

import { reportError } from '@/lib/error-reporter';
import { UnreadableModuleSet } from '@/lib/modules/module-state';
import { makeServiceContext, makeSupabaseStub, type SupabaseStub } from '@/test/supabase-mock';

/**
 * Server Actions and a module state the context could not read.
 *
 * withContext() holds an organization's module state as unknown when its rows
 * could not be read (server/services/context.module-state.test.ts pins that
 * through the real loader). This file runs real actions over such a context:
 * the ones that ask the context's set themselves, and ones whose service asks
 * through assertModuleEnabled. Each answers the try-again sentence as an
 * internal_error, reported once as a warning, never the refusal a module that
 * is off gets, and nothing is written. With the module read as off, each
 * still answers its own refusal.
 */

vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => undefined) }));
vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  unstable_cache: (fn: unknown) => fn,
}));
vi.mock('@/server/services/audit', () => ({ audit: vi.fn(async () => undefined) }));

const holder = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock('@/server/services/context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/services/context')>()),
  withContext: vi.fn(async () => holder.ctx),
}));

import { setAutoReorderSettingsAction } from './auto-reorder-settings';
import { startCycleCountAction } from './cycle-counts';
import { setPlanningParamsAction } from './planning-settings';
import { setPoApprovalSettingsAction } from './po-approval-settings';
import { createRecurringTemplateAction } from './recurring-pos';
import { importSage50Action } from './sage50-import';

const TRY_AGAIN = 'Your access could not be checked. Please try again.';
const WAREHOUSE = '0a000000-0000-4000-8000-0000000000a1';
const ITEM = '0a000000-0000-4000-8000-0000000000b1';

const CORE = (Object.keys(MODULE_REGISTRY) as ModuleId[]).filter(
  (m) => MODULE_REGISTRY[m].tier === 'core',
);

let stub: SupabaseStub;

/** An owner whose module state is `modules`: a plain set, or the unknown one. */
function asOwner(modules: Set<ModuleId>) {
  stub = makeSupabaseStub({});
  holder.ctx = makeServiceContext(stub.client, { role: 'owner', enabledModules: modules });
}

const ACTIONS: Array<{
  name: string;
  /** The module the action asks about. */
  module: ModuleId;
  run: () => Promise<{ ok: boolean; error?: { code: string; message: string } }>;
}> = [
  {
    name: 'start a cycle count (the service asks)',
    module: 'cycle_counts',
    run: () => startCycleCountAction({ warehouseId: WAREHOUSE }),
  },
  {
    name: 'set the purchase order approval threshold',
    module: 'purchase_orders',
    run: () => setPoApprovalSettingsAction({ approvalThresholdAmount: 500 }),
  },
  {
    name: 'set the auto-reorder settings',
    module: 'purchase_orders',
    run: () => setAutoReorderSettingsAction({ enabled: false, mode: 'draft', maxAutoSendCents: null }),
  },
  {
    name: 'set the planning parameters',
    module: 'planning',
    run: () =>
      setPlanningParamsAction({ leadTimeDays: 7, safetyMultiplier: 1.5, velocityWindowDays: 30 }),
  },
  {
    name: 'create a recurring purchase order template',
    module: 'purchase_orders',
    run: () =>
      createRecurringTemplateAction({
        name: 'Monthly paper',
        cadence: 'monthly',
        sendMode: 'draft',
        lineItems: [{ itemId: ITEM, quantityOrdered: 1, unitCost: 2 }],
      }),
  },
  {
    name: 'import from a Sage 50 file with vendors',
    module: 'suppliers',
    run: () =>
      importSage50Action({
        warehouseId: WAREHOUSE,
        items: [{ sku: 'SKU-1', name: 'Paper' }],
        vendors: [{ vendorId: 'V1', name: 'Paper Co' }],
      }),
  },
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('a Server Action whose module state could not be read', () => {
  it.each(ACTIONS)('$name: the try-again sentence, reported as a warning, and nothing written', async (a) => {
    asOwner(new UnreadableModuleSet([]));
    const res = await a.run();
    expect(res).toEqual({ ok: false, error: { code: 'internal_error', message: TRY_AGAIN } });
    // Never the words a module that is off gets.
    expect(JSON.stringify(res)).not.toMatch(/not enabled|module_disabled/i);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(vi.mocked(reportError).mock.calls[0]![0]).toMatchObject({
      name: 'ModulesUnavailableError',
    });
    expect(vi.mocked(reportError).mock.calls[0]![1]).toMatchObject({ level: 'warning' });
    // Refused before any write.
    for (const key of stub.chains.keys()) {
      expect(key.endsWith('.insert') || key.endsWith('.update') || key.endsWith('.delete')).toBe(
        false,
      );
    }
    expect(stub.rpcCalls).toEqual([]);
  });
});

describe('the same actions when the module was read as off', () => {
  it.each(ACTIONS.filter((a) => a.name !== 'import from a Sage 50 file with vendors'))(
    '$name: its own refusal, which names the module as not enabled, unreported',
    async (a) => {
      asOwner(new Set<ModuleId>(CORE));
      const res = await a.run();
      expect(res.ok).toBe(false);
      expect(['module_disabled', 'forbidden']).toContain(res.error?.code);
      expect(res.error?.message).toMatch(/not enabled/i);
      expect(reportError).not.toHaveBeenCalled();
    },
  );
});
