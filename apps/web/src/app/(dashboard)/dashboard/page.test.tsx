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
  /** The viewer's role and effective permissions (requireOrgContext). */
  viewer: { role: 'owner', permissions: new Set<string>() },
  /** Order requests waiting for approval in the organization (pendingCount). */
  pendingApprovals: vi.fn(async () => 0),
  /** Those of them the viewer could approve (approvablePendingCount). */
  approvableApprovals: vi.fn(async () => 0),
  /** Orders staged for pickup or in transit (awaitingSignatureCount). */
  awaitingSignature: vi.fn(async () => 0),
  /** The viewer's organization (the Demo Co check). */
  orgId: 'org-1',
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
      pendingCount: () => calls.pendingApprovals(),
      approvablePendingCount: () => calls.approvableApprovals(),
      awaitingSignatureCount: () => calls.awaitingSignature(),
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
    organizationId: calls.orgId,
    organizationName: 'Org One',
    userId: 'u1',
    email: 'a@b.com',
    fullName: 'Ann Example',
    role: calls.viewer.role,
    permissions: calls.viewer.permissions,
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

import { effectivePermissions } from '@stockpilot/core';
import { getThirtyDayMetrics } from '@/server/services/movements';

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
  calls.viewer = { role: 'owner', permissions: new Set<string>() };
  calls.pendingApprovals.mockResolvedValue(0);
  calls.approvableApprovals.mockResolvedValue(0);
  calls.awaitingSignature.mockResolvedValue(0);
  calls.orgId = 'org-1';
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

// FX5 (DESIGN-SPEC 6.10, the movement type words): the Movements · 30 days
// card printed each type as its raw code with a capital ("Receive_po",
// "Bundle_assembly"). The page now hands the card the Movements page's own
// words (movementTypeLabel), still the top five types with their shares.
describe('/dashboard: the 30-day breakdown names each type in words (FX5)', () => {
  it('labels each type as the Movements page does', async () => {
    vi.mocked(getThirtyDayMetrics).mockResolvedValueOnce({
      dailyCounts: Array(30).fill(0),
      byType: [
        { type: 'receive_po', count: 10, share: 1 },
        { type: 'bundle_assembly', count: 6, share: 0.6 },
        { type: 'correction', count: 3, share: 0.3 },
        { type: 'add', count: 2, share: 0.2 },
        { type: 'loss', count: 1, share: 0.1 },
        { type: 'damage', count: 1, share: 0.1 },
      ],
    });
    await (
      await startBody()
    ).done;
    const props = widgetProps.mock.calls[0]![0] as {
      breakdownRows: Array<{ label: string; share: number; val: number }>;
    };
    expect(props.breakdownRows).toEqual([
      { label: 'Receive PO', share: 1, val: 10 },
      { label: 'Bundle assembly', share: 0.6, val: 6 },
      { label: 'Correction', share: 0.3, val: 3 },
      { label: 'Add', share: 0.2, val: 2 },
      { label: 'Loss', share: 0.1, val: 1 },
    ]);
  });
});

// Desk check F10, raised again in review (2026-10-05): the "waiting for
// signature" card counted the whole organization's staged and in-transit
// orders for EVERY member, and its link lands on the filtered list only for
// someone who approves orders. A staff requester saw "2 orders waiting for
// signature" and landed on My requests, unfiltered, in every status. The card
// is now shown, and counted, only for orders:approve, the list's own gate
// (orders/page.tsx canApprove).
describe('/dashboard: the waiting for signature card follows orders:approve (F10)', () => {
  type Item = { id: string; href?: string; title?: string };
  const attention = () =>
    ((widgetProps.mock.calls[0]![0] as { attentionItems: Item[] }).attentionItems ?? []) as Item[];

  it('an approver sees the count, linked to the filtered list', async () => {
    calls.viewer = { role: 'staff', permissions: new Set(['orders:request', 'orders:approve']) };
    calls.awaitingSignature.mockResolvedValue(2);
    await (
      await startBody()
    ).done;
    const card = attention().find((i) => i.id === 'orders-awaiting-signature');
    expect(card?.title).toBe('2 orders waiting for signature');
    expect(card?.href).toBe('/dashboard/orders?status=awaiting_signature');
  });

  it('a staff requester without orders:approve gets no card, and the org-wide count is never read', async () => {
    calls.viewer = { role: 'staff', permissions: new Set(['orders:request']) };
    calls.awaitingSignature.mockResolvedValue(2);
    await (
      await startBody()
    ).done;
    expect(attention().map((i) => i.id)).not.toContain('orders-awaiting-signature');
    expect(calls.awaitingSignature).not.toHaveBeenCalled();
  });

  it('a manager whose orders:approve was revoked gets no card either', async () => {
    calls.viewer = { role: 'manager', permissions: new Set(['orders:request']) };
    calls.awaitingSignature.mockResolvedValue(2);
    await (
      await startBody()
    ).done;
    expect(attention().map((i) => i.id)).not.toContain('orders-awaiting-signature');
  });
});

// B11 Part 1 (2026-10-31): since 0390 approving an order follows
// orders:approve alone (has_permission decides, and an override wins either
// way), but the "awaiting your approval" card was still gated on the role
// (isManagerOrAbove). A staff member granted orders:approve never saw it; a
// manager whose orders:approve was revoked saw it and landed on My requests,
// where none of the counted requests can be approved. The card, and the count
// behind it, now follow orders:approve, the gate of the list it opens
// (orders/page.tsx canApprove), as the signature card does (F10). Each
// permission set comes from core's effectivePermissions, the resolution
// requireOrgContext uses, so granted, revoked and default are real overrides.
//
// Review of Part 1 (2026-10-31), two more people:
//   - a viewer granted orders:approve. The app refuses every write for a
//     viewer (assertWarehouseAccess), so neither app offers them Approve or
//     Deny (manager-actions-panel.tsx `approves`, the phone's
//     orderManagerActions). The card would lead nowhere, so they get none;
//   - a staff approver limited to some warehouses. approve() and deny() ask
//     write access to the request's warehouse, so the card counts the
//     requests in their warehouses (approvablePendingCount), not the
//     organization's (pendingCount, which the Insights page still reads).
describe('/dashboard: the pending approvals card follows orders:approve (0390)', () => {
  type Item = { id: string; href?: string; title?: string; detail?: string };
  const attention = () =>
    ((widgetProps.mock.calls[0]![0] as { attentionItems: Item[] }).attentionItems ?? []) as Item[];
  const approvalsCard = () => attention().find((i) => i.id === 'order-approvals');
  /** `inOrg` requests wait for approval in the organization; `approvable` of
   *  them are ones the viewer could approve (all of them unless a test says
   *  otherwise, as for an owner, admin or manager). */
  const waiting = (inOrg: number, approvable = inOrg) => {
    calls.pendingApprovals.mockResolvedValue(inOrg);
    calls.approvableApprovals.mockResolvedValue(approvable);
  };
  /** How many pending-approval counts the page read, of either kind. */
  const countReads = () =>
    calls.pendingApprovals.mock.calls.length + calls.approvableApprovals.mock.calls.length;
  const grantedApprover = (role: 'staff' | 'viewer') => ({
    role,
    permissions: effectivePermissions(role, [], [{ permission: 'orders:approve', granted: true }]),
  });

  it('a staff member granted orders:approve sees the count, linked to the pending list', async () => {
    calls.viewer = grantedApprover('staff');
    waiting(3);
    await (
      await startBody()
    ).done;
    expect(countReads()).toBe(1);
    expect(approvalsCard()?.title).toBe('3 order requests awaiting your approval');
    expect(approvalsCard()?.href).toBe('/dashboard/orders?status=pending_approval');
  });

  it('a manager whose orders:approve was revoked gets no card, and the count is never read', async () => {
    calls.viewer = {
      role: 'manager',
      permissions: effectivePermissions(
        'manager',
        [],
        [{ permission: 'orders:approve', granted: false }],
      ),
    };
    waiting(3);
    await (
      await startBody()
    ).done;
    expect(attention().map((i) => i.id)).not.toContain('order-approvals');
    expect(countReads()).toBe(0);
  });

  it('a manager by default still sees it', async () => {
    calls.viewer = { role: 'manager', permissions: effectivePermissions('manager') };
    waiting(1);
    await (
      await startBody()
    ).done;
    expect(approvalsCard()?.title).toBe('1 order request awaiting your approval');
    expect(approvalsCard()?.href).toBe('/dashboard/orders?status=pending_approval');
  });

  it('says the requests wait for someone who can approve orders, not for a manager', async () => {
    calls.viewer = { role: 'manager', permissions: effectivePermissions('manager') };
    waiting(2);
    await (
      await startBody()
    ).done;
    expect(approvalsCard()?.detail).toBe(
      'Requests are blocked until someone who can approve orders moves them forward.',
    );
  });

  it('a viewer granted orders:approve gets no card, and the count is never read', async () => {
    calls.viewer = grantedApprover('viewer');
    waiting(3);
    await (
      await startBody()
    ).done;
    expect(attention().map((i) => i.id)).not.toContain('order-approvals');
    expect(countReads()).toBe(0);
  });

  it('a staff approver limited to some warehouses is told only the requests they could approve', async () => {
    calls.viewer = grantedApprover('staff');
    waiting(5, 3);
    await (
      await startBody()
    ).done;
    expect(approvalsCard()?.title).toBe('3 order requests awaiting your approval');
    expect(calls.pendingApprovals).not.toHaveBeenCalled();
  });

  it('a staff approver gets no card when none of the waiting requests is theirs to approve', async () => {
    calls.viewer = grantedApprover('staff');
    waiting(2, 0);
    await (
      await startBody()
    ).done;
    expect(attention().map((i) => i.id)).not.toContain('order-approvals');
  });
});

// The header after the redesign (P3.1): the same words, links and gates, now
// handed to the shared page header. Read off the element tree the page
// returns (every prop, not only children: the header takes its actions as
// props).
function allElements(node: unknown, out: AnyElement[] = []): AnyElement[] {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const child of node) allElements(child, out);
    return out;
  }
  const el = node as AnyElement;
  if (!('props' in el) || !el.props) return out;
  out.push(el);
  for (const value of Object.values(el.props)) allElements(value, out);
  return out;
}

function textOf(node: unknown): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  return textOf((node as AnyElement).props?.children);
}

async function headerLinks(): Promise<Record<string, string>> {
  const tree = await DashboardHome();
  return Object.fromEntries(
    allElements(tree)
      .filter((el) => typeof el.props.href === 'string')
      .map((el) => [textOf(el.props.children).trim(), el.props.href as string]),
  );
}

describe('/dashboard header: the same actions behind the same gates', () => {
  it('shows Export to everyone, New item with items:create, Receive stock with purchase_orders:manage', async () => {
    calls.viewer = {
      role: 'manager',
      permissions: new Set(['items:create', 'purchase_orders:manage']),
    };
    expect(await headerLinks()).toEqual({
      Export: '/dashboard/reports',
      'New item': '/dashboard/inventory/new',
      'Receive stock': '/dashboard/purchase-orders/new',
    });
  });

  it('hides New item and Receive stock from a viewer without those permissions', async () => {
    calls.viewer = { role: 'viewer', permissions: new Set(['items:read']) };
    expect(await headerLinks()).toEqual({ Export: '/dashboard/reports' });
  });

  it('greets in the org time zone with "filtered to" the topbar warehouse in the eyebrow', async () => {
    const tree = await DashboardHome();
    const header = findByTypeName(tree, 'PageHeader')!;
    expect(header).not.toBeNull();
    expect(header.props.variant).toBe('greeting');
    expect(header.props.title).toMatch(/^Good (morning|afternoon|evening), Ann\.$/);
    expect(textOf(header.props.eyebrow)).toMatch(
      /^[A-Z][a-z]+day, [A-Z][a-z]+ \d{1,2} · filtered to Main$/,
    );
    expect(findByTypeName(header.props.tour, 'PageTour')).not.toBeNull();
  });

  it('offers the demo scenarios in Demo Co only', async () => {
    expect(findByTypeName(await DashboardHome(), 'DemoScenarios')).toBeNull();
    calls.orgId = 'demo-org';
    expect(findByTypeName(await DashboardHome(), 'DemoScenarios')).not.toBeNull();
  });
});
