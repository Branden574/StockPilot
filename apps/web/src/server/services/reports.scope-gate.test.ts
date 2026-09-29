import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_MODULE_IDS, type ModuleId } from '@stockpilot/core';

/**
 * Security invariant (2026-09-28, 0380): ReportsService reads every report
 * with the CALLER'S client and checks reports:read (the MFA step-up first)
 * and the report's modules itself, before its first read.
 *
 * Before: the six report_* aggregates ran through the SERVICE-ROLE client
 * with only an organization id, so a warehouse- or category-scoped reader
 * got organization-wide top movers (other warehouses' SKUs and names),
 * shrinkage totals and bundle warehouse names; and no report method checked
 * reports:read, so any path that reached the data (a page, an export, a
 * server action) relied on the reports layout alone.
 */

const admin = vi.hoisted(() => ({ created: 0 }));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => {
    admin.created += 1;
    return {
      rpc: async () => ({ data: [], error: null }),
      from: () => {
        throw new Error('admin.from');
      },
    };
  },
}));

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

import { ServiceError } from './context';
import { ReportsService } from './reports';

const REPORT_RPCS = [
  'report_movement_type_summary',
  'report_top_movers',
  'report_shrinkage_totals',
  'report_item_out_movements',
  'report_bundle_activity',
  'report_bundle_component_value',
];

/** A caller's client answering every report read with empty data. */
function callerStub(extra: Record<string, unknown> = {}) {
  const rpcResults = Object.fromEntries(
    REPORT_RPCS.map((fn) => [`rpc:${fn}`, { data: [], error: null }]),
  );
  return makeSupabaseStub({
    ...rpcResults,
    'inventory_items.select': { data: [], error: null },
    'stock_movements.select': { data: [], error: null },
    'purchase_orders.select': { data: [], error: null },
    'purchase_order_items.select': { data: [], error: null },
    'receipt_lines.select': { data: [], error: null },
    'vw_inventory_valuation_by_warehouse.select': { data: [], error: null },
    'vw_inventory_valuation_by_category.select': { data: [], error: null },
    ...(extra as Record<string, never>),
  });
}

type Method = (svc: ReportsService) => Promise<unknown>;
const REPORT_METHODS: Array<[string, Method]> = [
  ['inventoryValuation', (s) => s.inventoryValuation()],
  ['movementSummary', (s) => s.movementSummary(30)],
  ['reorderForecast', (s) => s.reorderForecast()],
  ['shrinkage', (s) => s.shrinkage(30)],
  ['supplierScorecard', (s) => s.supplierScorecard(90)],
  ['velocityClass', (s) => s.velocityClass(90)],
  ['deadStock', (s) => s.deadStock(90)],
  ['bundleActivity', (s) => s.bundleActivity(90)],
  ['bundleShortages', (s) => s.bundleShortages(90)],
  [
    'itemCostHistoryReport',
    (s) => s.itemCostHistoryReport('11111111-2222-4333-8444-555555555555'),
  ],
];

async function refusal(p: Promise<unknown>): Promise<ServiceError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ServiceError) return e;
    throw e;
  }
  throw new Error('expected a refusal');
}

beforeEach(() => {
  admin.created = 0;
});

describe('ReportsService: the caller\'s client, never the service role', () => {
  it.each([
    ['movementSummary', (s: ReportsService) => s.movementSummary(30), ['report_movement_type_summary', 'report_top_movers']],
    ['shrinkage', (s: ReportsService) => s.shrinkage(30), ['report_shrinkage_totals']],
    ['velocityClass', (s: ReportsService) => s.velocityClass(90), ['report_item_out_movements']],
    ['deadStock', (s: ReportsService) => s.deadStock(90), ['report_item_out_movements']],
    ['bundleActivity', (s: ReportsService) => s.bundleActivity(90), ['report_bundle_activity', 'report_bundle_component_value']],
  ] as const)('%s calls its aggregates on the caller\'s client', async (_name, run, fns) => {
    const stub = callerStub();
    const svc = new ReportsService(makeServiceContext(stub.client, { organizationId: 'org-A' }));
    await run(svc);
    expect(admin.created).toBe(0);
    expect(stub.rpcCalls.map((c) => c.name).sort()).toEqual([...fns].sort());
    for (const c of stub.rpcCalls) {
      expect((c.args as { p_organization_id: string }).p_organization_id).toBe('org-A');
    }
  });

  it('no method in the service creates the service-role client', async () => {
    for (const [, run] of REPORT_METHODS) {
      const stub = callerStub({
        'inventory_items.select': { data: { id: '11111111-2222-4333-8444-555555555555' }, error: null },
      });
      await run(new ReportsService(makeServiceContext(stub.client))).catch(() => undefined);
    }
    expect(admin.created).toBe(0);
  });
});

describe('ReportsService.gate: every report checks for itself before reading', () => {
  it.each(REPORT_METHODS)('%s refuses a member without reports:read, before any read', async (_n, run) => {
    const stub = callerStub();
    const ctx = makeServiceContext(stub.client, {
      role: 'viewer',
      permissions: new Set(['items:read']),
    });
    const e = await refusal(run(new ReportsService(ctx)));
    expect(e.code).toBe('forbidden');
    expect(e.message).toMatch(/reports:read/);
    expect(stub.fromCalls).toEqual([]);
    expect(stub.rpcCalls).toEqual([]);
  });

  it.each(REPORT_METHODS)(
    '%s runs the MFA step-up first (aal2_required for an enrolled AAL1 session), before any read',
    async (_n, run) => {
      const stub = callerStub();
      const ctx = {
        ...makeServiceContext(stub.client, { role: 'owner', mfaRequired: true, mfaSatisfied: false }),
        mfaEnrolled: true,
      };
      const e = await refusal(run(new ReportsService(ctx)));
      expect(e.code).toBe('forbidden');
      expect(e.details?.reason).toBe('aal2_required');
      expect(stub.fromCalls).toEqual([]);
      expect(stub.rpcCalls).toEqual([]);
    },
  );

  it.each([
    ['bundleActivity', 'bundles'],
    ['bundleShortages', 'bundles'],
    ['supplierScorecard', 'purchase_orders'],
    ['itemCostHistoryReport', 'purchase_orders'],
  ] as const)('%s refuses when the %s module is off, before any read', async (name, moduleId) => {
    const stub = callerStub();
    const ctx = makeServiceContext(stub.client, {
      enabledModules: new Set<ModuleId>(DEFAULT_MODULE_IDS.filter((m) => m !== moduleId)),
    });
    const run = REPORT_METHODS.find(([n]) => n === name)![1];
    const e = await refusal(run(new ReportsService(ctx)));
    expect(e.code).toBe('module_disabled');
    expect(stub.fromCalls).toEqual([]);
    expect(stub.rpcCalls).toEqual([]);
  });

  it('staff (reports:read by role default) and a viewer granted reports:read pass the gate', () => {
    const stub = callerStub();
    expect(() =>
      new ReportsService(makeServiceContext(stub.client, { role: 'staff' })).gate('stock-movements'),
    ).not.toThrow();
    expect(() =>
      new ReportsService(
        makeServiceContext(stub.client, { role: 'viewer', permissions: new Set(['reports:read']) }),
      ).gate('bundle-activity'),
    ).not.toThrow();
  });

  it('the dashboard donut and the item page cost card stay open to a member without reports:read', async () => {
    const stub = callerStub();
    const ctx = makeServiceContext(stub.client, { role: 'viewer', permissions: new Set(['items:read']) });
    const svc = new ReportsService(ctx);
    await expect(svc.inventoryValuationSummary()).resolves.toMatchObject({ totalValue: 0 });
    await expect(svc.itemCostHistory('11111111-2222-4333-8444-555555555555')).resolves.toMatchObject({
      pointCount: 0,
    });
  });
});

describe('ReportsService.itemCostHistoryReport: the item must be the caller\'s to read', () => {
  it('an item the caller cannot read (or another org\'s, or none) is not_found, and no PO or receipt line is read', async () => {
    const stub = callerStub({ 'inventory_items.select': { data: null, error: null } });
    const e = await refusal(
      new ReportsService(makeServiceContext(stub.client)).itemCostHistoryReport(
        '11111111-2222-4333-8444-555555555555',
      ),
    );
    expect(e.code).toBe('not_found');
    expect(stub.fromCalls).toEqual(['inventory_items']);
  });

  it('a malformed id is a validation error, before any read', async () => {
    const stub = callerStub();
    const e = await refusal(
      new ReportsService(makeServiceContext(stub.client)).itemCostHistoryReport('not-a-uuid'),
    );
    expect(e.code).toBe('validation_error');
    expect(stub.fromCalls).toEqual([]);
  });

  it('a readable item returns its history (read with the caller\'s client, org pinned)', async () => {
    const stub = callerStub({
      'inventory_items.select': { data: { id: '11111111-2222-4333-8444-555555555555' }, error: null },
    });
    const ctx = makeServiceContext(stub.client, { organizationId: 'org-A' });
    const out = await new ReportsService(ctx).itemCostHistoryReport('11111111-2222-4333-8444-555555555555');
    expect(out.pointCount).toBe(0);
    const args = stub.chainArgsAll.get('inventory_items.select')?.[0] ?? [];
    expect(args).toContainEqual(['id', '11111111-2222-4333-8444-555555555555']);
    expect(args).toContainEqual(['organization_id', 'org-A']);
  });
});

describe('ReportsService: an aggregate\'s own gate maps to its real error', () => {
  it.each([
    [{ code: '42501', hint: 'forbidden', message: 'forbidden' }, 'forbidden'],
    [{ code: '42501', hint: 'unauthenticated', message: 'unauthenticated' }, 'unauthenticated'],
    [{ code: 'P0001', hint: 'module_disabled', message: 'module disabled' }, 'module_disabled'],
    [{ code: '42501', message: 'permission denied for function report_top_movers' }, 'internal_error'],
    [{ code: '57014', message: 'canceling statement due to statement timeout' }, 'internal_error'],
  ])('%j -> %s (never a raw database message to the caller)', async (error, code) => {
    const stub = callerStub({
      'rpc:report_movement_type_summary': { data: null, error },
    });
    const e = await refusal(new ReportsService(makeServiceContext(stub.client)).movementSummary(30));
    expect(e.code).toBe(code);
    if (code === 'internal_error') expect(e.message).not.toMatch(/report_top_movers|statement/);
  });
});
