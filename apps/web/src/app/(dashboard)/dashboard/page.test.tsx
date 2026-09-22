import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 2026-09-22 (cold start): /dashboard's data body ran three serial levels,
 * the main fan-out, THEN the onboarding-dismissal read (user_profiles), THEN
 * the low-stock sparkline read. 3-5% of our server's Supabase calls stall
 * 1-8 s on weekday daytimes, so each level was one more chance to hold the
 * page. The profile read is now in the fan-out and the sparkline read starts
 * as soon as the low-stock rows land. These tests pin that timing AND that the
 * page issues exactly the reads it did before, with the same filters.
 */

type Call = [string, ...unknown[]];
const calls = vi.hoisted(() => ({
  /** Every Supabase table read: [table, ...chain of [method, ...args]]. */
  reads: [] as Array<{ table: string; chain: Call[] }>,
  profile: { onboarding_dismissed_at: null as string | null },
}));

// ── The fan-out's services. `summary` is held open by the timing tests. ──
let summaryGate: Promise<void> | null = null;
const getDashboardSummary = vi.fn(async (_opts: unknown) => {
  if (summaryGate) await summaryGate;
  return { itemCount: 3, lowStockCount: 1, outOfStockCount: 0, inventoryValue: 90 };
});
let lowStockRows: Array<{ id: string; quantity_on_hand: number }> = [];
const getLowStockItems = vi.fn(async (_limit: number, _opts: unknown) => lowStockRows);
const trendsMap = new Map([['i1', { qtySeries: [1], moveSeries: [0] }]]);
const getItemTrends = vi.fn(async (_items: unknown) => trendsMap);
const series30 = () => ({
  inventoryValueSeries: Array(30).fill(0),
  itemCountSeries: Array(30).fill(0),
  lowOutSeries: Array(30).fill(0),
});

vi.mock('@/server/services/movements', () => ({
  getDashboardSummary: (opts: unknown) => getDashboardSummary(opts),
  getLowStockItems: (limit: number, opts: unknown) => getLowStockItems(limit, opts),
  getItemTrends: (items: unknown) => getItemTrends(items),
  getThirtyDayMetrics: vi.fn(async () => ({ dailyCounts: Array(30).fill(0), byType: [] })),
  getDashboardActions: vi.fn(async () => ({ openPoCount: 0, openCycleCount: 0 })),
  getDashboardHistory: vi.fn(async () => series30()),
  MovementsService: { forCurrentUser: async () => ({ list: async () => [] }) },
}));
vi.mock('@/server/services/cycle-counts', () => ({
  CycleCountsService: { forCurrentUser: async () => ({ inProgressCount: async () => 0 }) },
}));
vi.mock('@/server/services/order-requests', () => ({
  OrderRequestsService: {
    forCurrentUser: async () => ({
      pendingCount: async () => 0,
      awaitingSignatureCount: async () => 0,
    }),
  },
}));
vi.mock('@/server/services/purchase-orders', () => ({
  PurchaseOrdersService: { forCurrentUser: async () => ({ overdueCount: async () => 0 }) },
}));
vi.mock('@/server/services/reports', () => ({
  ReportsService: {
    forCurrentUser: async () => ({ inventoryValuationSummary: async () => ({}) }),
  },
}));

vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: async () => ({
    organizationId: 'org-1',
    organizationName: 'Org One',
    userId: 'u1',
    email: 'a@b.com',
    fullName: 'Ann Example',
    role: 'owner',
    permissions: new Set<string>(),
  }),
}));
vi.mock('@/lib/dashboard/request-cache', () => ({
  getOrgRowForRequest: async () => ({ timezone: 'UTC', dashboard_layout: null }),
  getMfaFactorsForRequest: async () => [],
  getWarehousesForRequest: async () => [{ id: 'wh-1', name: 'Main' }],
}));
vi.mock('@/lib/warehouse-filter', () => ({ getActiveWarehouseFilter: async () => 'wh-1' }));

// Records each read's full chain and answers per table.
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    from: (table: string) => {
      const entry = { table, chain: [] as Call[] };
      calls.reads.push(entry);
      const answer = () => {
        if (table === 'organization_members') return { data: null, count: 2, error: null };
        if (table === 'user_profiles') return { data: { ...calls.profile }, error: null };
        if (table === 'warehouses') return { data: { name: 'Main' }, error: null };
        return { data: null, error: null };
      };
      const builder: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'not', 'is', 'in']) {
        builder[m] = (...args: unknown[]) => {
          entry.chain.push([m, ...args]);
          return builder;
        };
      }
      builder.maybeSingle = (...args: unknown[]) => {
        entry.chain.push(['maybeSingle', ...args]);
        return Promise.resolve(answer());
      };
      builder.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve(answer()).then(resolve, reject);
      return builder;
    },
  }),
}));

const widgetProps = vi.fn();
vi.mock('@/components/dashboard/widgets', () => ({
  renderDashboardWidgets: (_ids: unknown, props: unknown) => {
    widgetProps(props);
    return null;
  },
}));
vi.mock('@/components/dashboard/charts/widget-data', () => ({
  toBreakdownSlices: () => [],
  toMovementBars: () => [],
  toValueSeries: () => [],
}));
vi.mock('@/components/dashboard/scoped-warehouse-notice', () => ({
  ScopedWarehouseNotice: () => null,
}));
vi.mock('@/components/onboarding/page-tour', () => ({ PageTour: () => null }));
vi.mock('@/components/perf/perf-useful', () => ({ PerfUseful: () => null }));
vi.mock('@/lib/onboarding/tours', () => ({ DASHBOARD_TOUR: {} }));
vi.mock('@/components/onboarding/demo-scenarios', () => ({
  DEMO_ORG_ID: 'demo-org',
  DemoScenarios: () => null,
}));

import DashboardHome from './page';

type AnyElement = ReactElement<Record<string, unknown>>;

function findByTypeName(node: unknown, name: string): AnyElement | null {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findByTypeName(child, name);
      if (hit) return hit;
    }
    return null;
  }
  const el = node as AnyElement;
  const type = el.type as { name?: string } | string | undefined;
  if (typeof type === 'function' && (type as { name?: string }).name === name) return el;
  return findByTypeName(el.props?.children, name);
}

/** Renders the shell, then starts the streamed body the way React would. */
async function startBody(): Promise<{ done: Promise<unknown> }> {
  const tree = await DashboardHome();
  const body = findByTypeName(tree, 'DashboardBody');
  expect(body).not.toBeNull();
  const render = body!.type as unknown as (props: unknown) => Promise<unknown>;
  // Wrapped: an async function returning a bare promise would adopt it, and
  // the caller could not look at the reads while the body is still waiting.
  return { done: render(body!.props) };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.clearAllMocks();
  calls.reads.length = 0;
  calls.profile.onboarding_dismissed_at = null;
  summaryGate = null;
  lowStockRows = [{ id: 'i1', quantity_on_hand: 2 }];
});

describe('/dashboard data body: one wave', () => {
  it('starts the onboarding read and the sparkline read while the rest of the fan-out is still out', async () => {
    let openSummary!: () => void;
    summaryGate = new Promise<void>((resolve) => {
      openSummary = resolve;
    });

    const { done } = await startBody();
    await flush();

    // `summary` has not returned, yet both used-to-be-serial reads are out.
    expect(calls.reads.map((r) => r.table)).toContain('user_profiles');
    expect(getItemTrends).toHaveBeenCalledWith([{ id: 'i1', quantityOnHand: 2 }]);
    expect(widgetProps).not.toHaveBeenCalled();

    openSummary();
    await done;
    expect(widgetProps).toHaveBeenCalledTimes(1);
    expect(widgetProps.mock.calls[0]![0]).toMatchObject({ lowStockTrends: trendsMap });
  });

  it('issues the same reads, with the same filters, as before', async () => {
    await (
      await startBody()
    ).done;

    const byTable = Object.fromEntries(calls.reads.map((r) => [r.table, r.chain]));
    expect(calls.reads.map((r) => r.table).sort()).toEqual([
      'organization_members',
      'user_profiles',
      'warehouses',
    ]);
    // Shell: the active warehouse's name for the "filtered to" label.
    expect(byTable.warehouses).toEqual([['select', 'name'], ['eq', 'id', 'wh-1'], ['maybeSingle']]);
    expect(byTable.organization_members).toEqual([
      ['select', 'id', { count: 'exact', head: true }],
      ['eq', 'organization_id', 'org-1'],
      ['not', 'accepted_at', 'is', null],
    ]);
    expect(byTable.user_profiles).toEqual([
      ['select', 'onboarding_dismissed_at, full_name'],
      ['eq', 'id', 'u1'],
      ['maybeSingle'],
    ]);
    expect(getDashboardSummary).toHaveBeenCalledWith({ warehouseId: 'wh-1' });
    expect(getLowStockItems).toHaveBeenCalledWith(5, { warehouseId: 'wh-1' });
    expect(getItemTrends).toHaveBeenCalledTimes(1);
    expect(getItemTrends).toHaveBeenCalledWith([{ id: 'i1', quantityOnHand: 2 }]);
  });

  it('skips the sparkline read when nothing is low, and still charts nothing', async () => {
    lowStockRows = [];
    await (
      await startBody()
    ).done;
    expect(getItemTrends).not.toHaveBeenCalled();
    const props = widgetProps.mock.calls[0]![0] as { lowStockTrends: Map<string, unknown> };
    expect(props.lowStockTrends).toBeInstanceOf(Map);
    expect(props.lowStockTrends.size).toBe(0);
  });

  it('a dismissed Getting-started panel stays dismissed', async () => {
    calls.profile.onboarding_dismissed_at = '2026-09-01T00:00:00Z';
    await (
      await startBody()
    ).done;
    expect(widgetProps.mock.calls[0]![0]).toMatchObject({ checklistComplete: true });
  });

  it('an undismissed panel with open steps still shows', async () => {
    await (
      await startBody()
    ).done;
    // warehouse yes, team (2 members) yes, item yes, MFA no: not complete.
    expect(widgetProps.mock.calls[0]![0]).toMatchObject({ checklistComplete: false });
  });
});
