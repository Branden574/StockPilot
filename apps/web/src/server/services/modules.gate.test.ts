import { describe, expect, it, vi } from 'vitest';

import type { ModuleId } from '@stockpilot/core';
import { DEFAULT_MODULE_IDS } from '@stockpilot/core';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

import { ServiceError } from './context';
import { BundlesService } from './bundles';
import { CycleCountsService } from './cycle-counts';
import { OrderRequestsService } from './order-requests';
import { PoImportsService } from './po-imports';
import { ProceduresService } from './procedures';
import { PurchaseOrdersService } from './purchase-orders';
import { ReceivingService } from './receiving';
import { RentalsService } from './rentals';
import { ScheduleService } from './schedule';
import { SuppliersService } from './suppliers';

// The selection-count path consults warehouse access before snapshotting,
// but the module gate is the FIRST statement in every entry method — it
// must throw before any of that runs. Stub the helper anyway so a
// regression that moved the gate later doesn't quietly pass.
vi.mock('@/lib/auth/warehouse', () => ({
  getWarehouseAccess: vi.fn(async () => ({
    readableIds: [],
    writableIds: [],
    hasAllAccess: true,
    primaryWarehouseId: null,
  })),
  assertWarehouseAccess: vi.fn(),
  forcedWarehouseId: vi.fn(async () => null),
  ForbiddenError: class ForbiddenError extends Error {
    readonly code = 'forbidden' as const;
  },
}));

/**
 * Builds a ServiceContext whose enabledModules is the full grandfathered
 * set MINUS the one module under test, so only that module's gate fires.
 */
function ctxWithout(moduleId: ModuleId) {
  const enabledModules = new Set<ModuleId>(DEFAULT_MODULE_IDS);
  enabledModules.delete(moduleId);
  return makeServiceContext(makeSupabaseStub({}).client, { enabledModules });
}

async function expectModuleDisabled(fn: () => Promise<unknown>) {
  await expect(fn()).rejects.toBeInstanceOf(ServiceError);
  await expect(fn()).rejects.toMatchObject({ code: 'module_disabled' });
}

describe('optional-module gates (assertModuleEnabled at service entry points)', () => {
  it('orders: list throws module_disabled when orders is off', async () => {
    const svc = new OrderRequestsService(ctxWithout('orders'));
    await expect(svc.list()).rejects.toBeInstanceOf(ServiceError);
    await expect(svc.list()).rejects.toMatchObject({ code: 'module_disabled' });
  });

  it('orders: create throws module_disabled when orders is off', async () => {
    const svc = new OrderRequestsService(ctxWithout('orders'));
    await expectModuleDisabled(() =>
      svc.create({ warehouseId: 'wh', lines: [] } as never),
    );
  });

  it('public_requests: getPublicSettings throws when public_requests is off', async () => {
    const svc = new OrderRequestsService(ctxWithout('public_requests'));
    await expect(svc.getPublicSettings()).rejects.toMatchObject({
      code: 'module_disabled',
    });
  });

  it('rentals: list throws module_disabled when rentals is off', async () => {
    const svc = new RentalsService(ctxWithout('rentals'));
    await expect(svc.list()).rejects.toMatchObject({ code: 'module_disabled' });
  });

  it('bundles: list throws module_disabled when bundles is off', async () => {
    const svc = new BundlesService(ctxWithout('bundles'));
    await expect(svc.list()).rejects.toMatchObject({ code: 'module_disabled' });
  });

  it('cycle_counts: list throws module_disabled when cycle_counts is off', async () => {
    const svc = new CycleCountsService(ctxWithout('cycle_counts'));
    await expect(svc.list()).rejects.toMatchObject({ code: 'module_disabled' });
  });

  it('cycle_counts: start throws module_disabled when cycle_counts is off', async () => {
    const svc = new CycleCountsService(ctxWithout('cycle_counts'));
    await expectModuleDisabled(() =>
      svc.start({ scope: 'selection', warehouseId: null, itemIds: ['i1'] }),
    );
  });

  it('ai_shelf_scan: getLineSetForAiScan throws when ai_shelf_scan is off', async () => {
    const svc = new CycleCountsService(ctxWithout('ai_shelf_scan'));
    await expect(svc.getLineSetForAiScan('cc-1')).rejects.toMatchObject({
      code: 'module_disabled',
    });
  });

  it('procedures: list throws module_disabled when procedures is off', async () => {
    const svc = new ProceduresService(ctxWithout('procedures'));
    await expect(svc.list({} as never)).rejects.toMatchObject({
      code: 'module_disabled',
    });
  });

  it('schedule: create throws module_disabled when schedule is off', async () => {
    const svc = new ScheduleService(ctxWithout('schedule'));
    await expectModuleDisabled(() => svc.create({} as never));
  });

  it('purchase_orders: list throws module_disabled when purchase_orders is off', async () => {
    const svc = new PurchaseOrdersService(ctxWithout('purchase_orders'));
    await expect(svc.list()).rejects.toMatchObject({ code: 'module_disabled' });
  });

  it('receiving: listForPurchaseOrder throws when receiving is off', async () => {
    const svc = new ReceivingService(ctxWithout('receiving'));
    await expect(svc.listForPurchaseOrder('po-1')).rejects.toMatchObject({
      code: 'module_disabled',
    });
  });

  it('po_imports: list throws module_disabled when po_imports is off', async () => {
    const svc = new PoImportsService(ctxWithout('po_imports'));
    await expect(svc.list()).rejects.toMatchObject({ code: 'module_disabled' });
  });

  it('suppliers: list throws module_disabled when suppliers is off', async () => {
    const svc = new SuppliersService(ctxWithout('suppliers'));
    await expect(svc.list()).rejects.toMatchObject({ code: 'module_disabled' });
  });

  it('does NOT throw when the module IS enabled (gate passes through to logic)', async () => {
    // Full default set includes suppliers; suppliers.list then runs its
    // real query against the stub, which returns []. Proves the gate is a
    // no-op for a grandfathered org.
    const svc = new SuppliersService(
      makeServiceContext(
        makeSupabaseStub({ 'suppliers.select': { data: [], error: null } }).client,
      ),
    );
    await expect(svc.list()).resolves.toEqual([]);
  });
});
