// CycleCountsService.listPage(): the one server list behind the web history
// page and GET /api/v1/cycle-counts (migration 0358's cycle_counts_page RPC).
//
// Visibility regression pin for SP-127 carries over from list(): a count whose
// header warehouse is null (a manager's selection spanning two warehouses, or
// an org-wide count) must still reach the warehouse-scoped staffer it is
// assigned to. The RPC applies that arm with auth.uid(); the service's job is
// to hand it the caller's WRITABLE warehouses (never readable, never a
// widening) and to stop before querying when there is nothing to see.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub, type MockCall } from '@/test/supabase-mock';

vi.mock('@/lib/auth/warehouse', () => ({
  getWarehouseAccess: vi.fn(),
  assertWarehouseAccess: vi.fn(),
  forcedWarehouseId: vi.fn(async () => null),
  ForbiddenError: class ForbiddenError extends Error {
    readonly code = 'forbidden' as const;
  },
}));

vi.mock('@/lib/dashboard/cached-org', () => ({
  getCachedOrgTimezone: vi.fn(async () => 'America/Los_Angeles'),
}));

vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn() }));

vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({
    userId: 'user-test',
    organizationId: 'org-test',
    role: 'admin',
  })),
}));

import { getWarehouseAccess } from '@/lib/auth/warehouse';
import { getCachedOrgTimezone } from '@/lib/dashboard/cached-org';
import { reportError } from '@/lib/error-reporter';

import { CycleCountsService } from './cycle-counts';

function fullAccess() {
  vi.mocked(getWarehouseAccess).mockResolvedValue({
    readableIds: ['wh-a', 'wh-b'],
    writableIds: ['wh-a', 'wh-b'],
    hasAllAccess: true,
    primaryWarehouseId: 'wh-a',
  });
}

function scopedAccess(writable = ['wh-a'], readable = ['wh-a', 'wh-c']) {
  vi.mocked(getWarehouseAccess).mockResolvedValue({
    readableIds: readable,
    writableIds: writable,
    hasAllAccess: false,
    primaryWarehouseId: writable[0] ?? null,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  fullAccess();
  vi.mocked(getCachedOrgTimezone).mockResolvedValue('America/Los_Angeles');
});

function row(n: number, extra: Record<string, unknown> = {}) {
  return {
    id: `cc-${n}`,
    count_number: n,
    warehouse_id: 'wh-a',
    warehouse_name: 'North DC',
    scope: 'warehouse',
    status: 'completed',
    notes: null,
    started_by: 'u-mgr',
    started_by_name: 'Morgan Manager',
    started_at: '2026-09-01T16:00:00Z',
    completed_at: '2026-09-02T16:00:00Z',
    canceled_at: null,
    assigned_to: null,
    assignee_name: null,
    line_total: 20,
    line_counted: 20,
    total_count: 137,
    effective_page: 2,
    ...extra,
  };
}

type RpcResult = { data: unknown; error: { message: string } | null };

/** The args object a stubbed rpc() was called with. */
function rpcArgs(call: MockCall): Record<string, unknown> {
  return (call.args[0]?.[0] ?? {}) as Record<string, unknown>;
}

function svcWith(
  rpc: RpcResult | ((call: MockCall) => RpcResult),
  overrides: Parameters<typeof makeServiceContext>[1] = {},
) {
  const stub = makeSupabaseStub({ 'rpc:cycle_counts_page': rpc as never });
  const svc = new CycleCountsService(
    makeServiceContext(stub.client, { role: 'manager', userId: 'u-mgr', ...overrides }),
  );
  return { stub, svc };
}

function pageArgs(stub: ReturnType<typeof makeSupabaseStub>, i = 0) {
  return stub.rpcCalls.filter((c) => c.name === 'cycle_counts_page')[i]?.args as Record<
    string,
    unknown
  >;
}

describe('CycleCountsService.listPage: the page contract', () => {
  it('returns the RPC page with the effective page, total and navigation flags', async () => {
    const { svc } = svcWith({ data: [row(112), row(111)], error: null });
    const res = await svc.listPage({ page: 2 });
    expect(res.page).toBe(2);
    expect(res.pageSize).toBe(25);
    expect(res.total).toBe(137);
    expect(res.totalPages).toBe(6);
    expect(res.hasPrevious).toBe(true);
    expect(res.hasNext).toBe(true);
    expect(res.items.map((i) => i.countNumber)).toEqual([112, 111]);
    expect(res.items[0]).toMatchObject({
      id: 'cc-112',
      warehouseName: 'North DC',
      scope: 'warehouse',
      status: 'completed',
      lineTotal: 20,
      lineCounted: 20,
    });
  });

  it('asks for exactly 25 sessions and the requested page', async () => {
    const { stub, svc } = svcWith({ data: [], error: null });
    await svc.listPage({ page: '3' });
    expect(pageArgs(stub)).toMatchObject({ p_organization_id: 'org-test', p_page: 3, p_page_size: 25 });
  });

  it('reads an unusable page as page 1 and caps an absurd one', async () => {
    const { stub, svc } = svcWith({ data: [], error: null });
    await svc.listPage({ page: 'abc' });
    await svc.listPage({ page: -4 });
    await svc.listPage({ page: '999999999' });
    expect(pageArgs(stub, 0).p_page).toBe(1);
    expect(pageArgs(stub, 1).p_page).toBe(1);
    expect(pageArgs(stub, 2).p_page).toBe(1_000_000);
  });

  it('trusts the server clamp: a past-end request reports the page it got', async () => {
    const { svc } = svcWith({ data: [row(12, { effective_page: 6 })], error: null });
    const res = await svc.listPage({ page: 99 });
    expect(res.page).toBe(6);
    expect(res.hasNext).toBe(false);
  });

  it('an empty result is zero on page 1, never "1-0"', async () => {
    const { svc } = svcWith({ data: [], error: null });
    const res = await svc.listPage({ page: 4, q: 'nothing' });
    expect(res).toMatchObject({ items: [], page: 1, total: 0, totalPages: 1, hasPrevious: false, hasNext: false });
  });

  it('keeps a null number null (the unavailable label), never inventing one', async () => {
    const { svc } = svcWith({ data: [row(5, { count_number: null })], error: null });
    const res = await svc.listPage();
    expect(res.items[0]!.countNumber).toBeNull();
  });

  it('throws on an RPC error instead of showing an empty history', async () => {
    const { svc } = svcWith({ data: null, error: { message: 'boom' } });
    await expect(svc.listPage()).rejects.toMatchObject({ code: 'internal_error' });
  });
});

describe('CycleCountsService.listPage: search goes to the server, typed', () => {
  it.each(['CC-000042', 'cc-000042', 'CC-42', '000042', '42'])('"%s" is an exact number lookup', async (q) => {
    const { stub, svc } = svcWith({ data: [], error: null });
    await svc.listPage({ q });
    expect(pageArgs(stub)).toMatchObject({ p_number: 42, p_text: null });
  });

  it('ordinary text is a literal text search, passed as a parameter', async () => {
    const { stub, svc } = svcWith({ data: [], error: null });
    await svc.listPage({ q: "  50% off, (shelf_1) O'Brien  " });
    expect(pageArgs(stub)).toMatchObject({ p_number: null, p_text: "50% off, (shelf_1) O'Brien" });
  });

  it('blank search sends neither', async () => {
    const { stub, svc } = svcWith({ data: [], error: null });
    await svc.listPage({ q: '   ' });
    expect(pageArgs(stub)).toMatchObject({ p_number: null, p_text: null });
  });

  it('passes the status and the retained assignment / warehouse filters through', async () => {
    const { stub, svc } = svcWith({ data: [], error: null });
    await svc.listPage({ status: 'canceled', warehouseId: 'wh-a', assignedTo: 'u-dana', unassigned: false });
    expect(pageArgs(stub)).toMatchObject({
      p_status: 'canceled',
      p_warehouse_id: 'wh-a',
      p_assigned_to: 'u-dana',
      p_unassigned: false,
    });
  });
});

describe('CycleCountsService.listPage: warehouse-scoped visibility', () => {
  it('a warehouse-scoped staffer is narrowed to her WRITABLE warehouses (the null arm is the RPC)', async () => {
    scopedAccess(['wh-a', 'wh-b'], ['wh-a', 'wh-b', 'wh-c']);
    const { stub, svc } = svcWith({ data: [], error: null }, { role: 'staff', userId: 'u-dana' });
    await svc.listPage();
    expect(pageArgs(stub).p_scope_warehouse_ids).toEqual(['wh-a', 'wh-b']);
  });

  it('a full-access manager is not narrowed', async () => {
    const { stub, svc } = svcWith({ data: [], error: null });
    await svc.listPage();
    expect(pageArgs(stub).p_scope_warehouse_ids).toBeNull();
  });

  it('a member with no writable warehouse sees no counts, without querying', async () => {
    scopedAccess([], ['wh-a']);
    const { stub, svc } = svcWith(
      { data: [row(1)], error: null },
      { role: 'viewer', userId: 'u-v', permissions: new Set(['cycle_counts:read']) },
    );
    const res = await svc.listPage();
    expect(res.total).toBe(0);
    expect(res.items).toEqual([]);
    expect(stub.rpcCalls).toHaveLength(0);
  });

  it('a FAILED access read is an error, not "No cycle counts yet"', async () => {
    vi.mocked(getWarehouseAccess).mockResolvedValue({
      readableIds: [],
      writableIds: [],
      hasAllAccess: false,
      primaryWarehouseId: null,
      unreadable: true,
    });
    const { stub, svc } = svcWith({ data: [row(1)], error: null }, { role: 'staff' });
    await expect(svc.listPage()).rejects.toMatchObject({ code: 'internal_error' });
    expect(stub.rpcCalls).toHaveLength(0);
  });

  it('a manager whose warehouse list failed still lists (role decides, not the list)', async () => {
    vi.mocked(getWarehouseAccess).mockResolvedValue({
      readableIds: [],
      writableIds: [],
      hasAllAccess: true,
      primaryWarehouseId: null,
      unreadable: true,
    });
    const { stub, svc } = svcWith({ data: [], error: null });
    await svc.listPage();
    expect(pageArgs(stub).p_scope_warehouse_ids).toBeNull();
  });
});

describe('CycleCountsService.listPage: gates', () => {
  it('refuses a member with neither cycle_counts:read nor stock:adjust', async () => {
    const { stub, svc } = svcWith({ data: [], error: null }, { role: 'viewer', permissions: new Set(['items:read']) });
    await expect(svc.listPage()).rejects.toMatchObject({ code: 'forbidden' });
    expect(stub.rpcCalls).toHaveLength(0);
  });

  it('allows a viewer granted cycle_counts:read', async () => {
    const { svc } = svcWith({ data: [], error: null }, { role: 'viewer', permissions: new Set(['cycle_counts:read']) });
    await expect(svc.listPage()).resolves.toMatchObject({ total: 0 });
  });

  it('allows stock:adjust as the fallback', async () => {
    const { svc } = svcWith({ data: [], error: null }, { role: 'staff', permissions: new Set(['stock:adjust']) });
    await expect(svc.listPage()).resolves.toMatchObject({ total: 0 });
  });

  it('does not apply the MFA step-up to a read (same as the page and the phone before)', async () => {
    const { svc } = svcWith({ data: [], error: null }, { mfaRequired: true, mfaSatisfied: false });
    await expect(svc.listPage()).resolves.toMatchObject({ total: 0 });
  });
});

describe('CycleCountsService.listPage: summary', () => {
  it('computes in-progress and started-today over the same scope, ignoring the search', async () => {
    scopedAccess(['wh-a']);
    const stub = makeSupabaseStub({
      'rpc:cycle_counts_page': (call: MockCall) => {
        const args = rpcArgs(call);
        if (args.p_status === 'in_progress' && args.p_page_size === 1) {
          return { data: [row(9, { total_count: 8, effective_page: 1 })], error: null };
        }
        if (args.p_started_from) {
          return { data: [row(9, { total_count: 2, effective_page: 1 })], error: null };
        }
        return { data: [row(42, { total_count: 1, effective_page: 1 })], error: null };
      },
    } as never);
    const svc = new CycleCountsService(makeServiceContext(stub.client, { role: 'staff', userId: 'u-dana' }));
    const res = await svc.listPage(
      { q: 'CC-42', status: 'completed' },
      { includeSummary: true, now: new Date('2026-09-23T10:00:00Z') },
    );
    expect(res.summary).toEqual({ inProgress: 8, startedToday: 2, timezone: 'America/Los_Angeles' });
    const calls = stub.rpcCalls.map((c) => c.args as Record<string, unknown>);
    expect(calls).toHaveLength(3);
    for (const a of calls) expect(a.p_scope_warehouse_ids).toEqual(['wh-a']);
    const today = calls.find((a) => a.p_started_from)!;
    // Midnight in Los Angeles on 2026-09-23 (PDT, UTC-7).
    expect(today.p_started_from).toBe('2026-09-23T07:00:00.000Z');
    expect(today).toMatchObject({ p_number: null, p_text: null, p_status: null });
    const open = calls.find((a) => a.p_status === 'in_progress')!;
    expect(open).toMatchObject({ p_number: null, p_text: null });
    expect(getWarehouseAccess).toHaveBeenCalledTimes(1);
  });

  it('a failed total is null (a dash), not zero, and does not fail the list', async () => {
    const stub = makeSupabaseStub({
      'rpc:cycle_counts_page': (call: MockCall) =>
        rpcArgs(call).p_page_size === 1
          ? { data: null, error: { message: 'stall' } }
          : { data: [row(1, { total_count: 1, effective_page: 1 })], error: null },
    } as never);
    const svc = new CycleCountsService(makeServiceContext(stub.client, { role: 'manager' }));
    const res = await svc.listPage({}, { includeSummary: true });
    expect(res.total).toBe(1);
    expect(res.summary).toBeNull();
    expect(reportError).toHaveBeenCalled();
  });

  it('is absent unless asked for', async () => {
    const { stub, svc } = svcWith({ data: [], error: null });
    const res = await svc.listPage();
    expect('summary' in res).toBe(false);
    expect(stub.rpcCalls).toHaveLength(1);
  });
});
