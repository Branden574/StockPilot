import { Suspense } from 'react';
import Link from 'next/link';

import {
  toBreakdownSlices,
  toMovementBars,
  toValueSeries,
} from '@/components/dashboard/charts/widget-data';
import {
  OVERVIEW_PAGE_CLASS,
  OverviewBodySkeleton,
} from '@/components/dashboard/overview-skeleton';
import {
  renderDashboardWidgets,
  type AttentionItem,
  type DashboardWidgetProps,
} from '@/components/dashboard/widgets';
import { percentDelta, worseWhenUpDelta } from '@/components/dashboard/widgets/deltas';
import { PageHeader } from '@/components/patterns/page-header';
import { Button } from '@/components/ui/button';
import {
  can,
  DASHBOARD_WIDGETS,
  isManagerOrAbove,
  resolveDashboardWidgets,
  type DashboardLayout,
} from '@stockpilot/core';
import {
  getDashboardActions,
  getDashboardHistory,
  getDashboardSummary,
  getItemTrends,
  getLowStockItems,
  getThirtyDayMetrics,
  MovementsService,
} from '@/server/services/movements';
import { CycleCountsService } from '@/server/services/cycle-counts';
import { OrderRequestsService } from '@/server/services/order-requests';
import { PurchaseOrdersService } from '@/server/services/purchase-orders';
import { ReportsService } from '@/server/services/reports';
import { requireOrgContext } from '@/lib/auth/session';
import { movementTypeLabel } from '@/lib/movements/movement-type';
import { ORDERS_AWAITING_SIGNATURE_HREF } from '@/lib/orders/export';
import { orSessionEnded } from '@/lib/auth/session-ended';
import {
  getMfaFactorsForRequest,
  getOrgRowForRequest,
  getWarehousesForRequest,
} from '@/lib/dashboard/request-cache';
import { getActiveWarehouseFilter } from '@/lib/warehouse-filter';
import { ScopedWarehouseNotice } from '@/components/dashboard/scoped-warehouse-notice';
import { createClient } from '@/lib/supabase/server';
import { PageTour } from '@/components/onboarding/page-tour';
import { PerfUseful } from '@/components/perf/perf-useful';
import { DASHBOARD_TOUR } from '@/lib/onboarding/tours';
import { DEMO_ORG_ID, DemoScenarios } from '@/components/onboarding/demo-scenarios';

/**
 * Returns the morning/afternoon/evening greeting word + the long-form
 * date string ("Sunday, May 10") in the org's timezone. Falls back to
 * the runtime's tz only if Intl rejects the supplied zone (typo / unset).
 *
 * Hours: morning 5–11, afternoon 12–17, evening 18–4. Computed from a
 * single `hour` formatter so DST handoffs do the right thing.
 */
function buildGreeting(timezone: string | null): { word: string; dateLabel: string } {
  const tz = timezone || 'UTC';
  const safeFormat = (opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat => {
    try {
      return new Intl.DateTimeFormat('en-US', { ...opts, timeZone: tz });
    } catch {
      return new Intl.DateTimeFormat('en-US', opts);
    }
  };
  const now = new Date();
  const hour = Number(safeFormat({ hour: 'numeric', hour12: false }).format(now));
  const word =
    hour >= 5 && hour <= 11 ? 'morning' : hour >= 12 && hour <= 17 ? 'afternoon' : 'evening';
  const dateLabel = safeFormat({
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(now);
  return { word, dateLabel };
}

// Note: the long-form date is now built per-request inside buildGreeting()
// so it can use the org's saved timezone. There's no longer a module-level
// formatter — every dashboard render needs the tz before formatting.
//
// AttentionItem now lives in components/dashboard/widgets/shared.tsx (moved
// with the NeedsAttentionHero it feeds) and is imported above.

export default async function DashboardHome() {
  // Resolve the topbar warehouse filter once and pass it into every
  // summary call so the dashboard tiles, low-stock list, and shift-
  // command counts all narrow to the same scope.
  const warehouseFilter = await getActiveWarehouseFilter();

  // SECURITY-CRITICAL: org/auth context stays BLOCKING in the shell (never
  // behind Suspense) so an unauthenticated/unauthorized request is rejected
  // before any chrome paints. requireOrgContext + orgRow + the active
  // warehouse name are all request-cached/cheap, so the header (greeting,
  // action buttons) paints immediately while the heavy data sections stream.
  const ctx = await requireOrgContext();

  const supabaseShell = await createClient();
  const [orgRow, activeWhNameRes] = await Promise.all([
    getOrgRowForRequest(ctx.organizationId),
    warehouseFilter
      ? supabaseShell.from('warehouses').select('name').eq('id', warehouseFilter).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);
  const activeWarehouseName = (activeWhNameRes.data?.name as string | undefined) ?? null;

  // Greeting + journalistic date header. Time-of-day greeting respects the
  // org's saved timezone (see organizations.timezone, default 'UTC') so a
  // late-night warehouse in Tokyo doesn't say "good morning" because the
  // Vercel pod woke up in Virginia at 9am ET.
  const orgTimezone = orgRow?.timezone ?? null;
  const { word: greetingWord, dateLabel: today } = buildGreeting(orgTimezone);
  const firstName = ctx.fullName?.split(' ')[0]?.trim() || 'there';

  return (
    <div className={OVERVIEW_PAGE_CLASS}>
      {/* ──────────────── Morning briefing — greeting + actions ─────────────
       *
       * The greeting answers "who is at the keyboard"; the attention card
       * below answers "where should they click right now". Everything else
       * (stat strips, charts, activity feed) is context.
       *
       * The header paints immediately from the request-cached auth context;
       * the data-driven body (checklist, attention card, stats, charts,
       * activity feed) streams in via <Suspense> below. It is the reference's
       * greeting header (DESIGN-SPEC 6.1): the date eyebrow, the 32 px
       * greeting, then Tour, Export and New item as secondary buttons and
       * Receive stock as the page's one ink button, each behind its own gate.
       */}
      <PageHeader
        variant="greeting"
        eyebrow={
          <>
            {today}
            {activeWarehouseName && (
              <>
                {' · '}
                <span className="text-foreground">filtered to {activeWarehouseName}</span>
              </>
            )}
          </>
        }
        title={`Good ${greetingWord}, ${firstName}.`}
        tour={<PageTour tour={DASHBOARD_TOUR} />}
        actions={
          <>
            <Button variant="outline" asChild>
              <Link href="/dashboard/reports">Export</Link>
            </Button>
            {can(ctx, 'items:create') && (
              <Button variant="outline" asChild>
                <Link href="/dashboard/inventory/new">New item</Link>
              </Button>
            )}
          </>
        }
        commitAction={
          can(ctx, 'purchase_orders:manage') ? (
            <Button asChild>
              <Link href="/dashboard/purchase-orders/new">Receive stock</Link>
            </Button>
          ) : null
        }
      >
        {/* Warehouse-scoped users (staff/viewer): name the scope so the
            narrowed dashboard reads as intentional. Null for managers+.
            Request-cached from the layout render — no extra queries. */}
        <ScopedWarehouseNotice className="text-muted-foreground mt-1.5 text-[12.5px]" />
      </PageHeader>

      {ctx.organizationId === DEMO_ORG_ID && <DemoScenarios />}

      <Suspense fallback={<OverviewBodySkeleton />}>
        <DashboardBody ctx={ctx} warehouseFilter={warehouseFilter} />
      </Suspense>
    </div>
  );
}

/**
 * Inner async Server Component holding ALL data-dependent dashboard content
 * (the parallel data fan-out + every derived stat/chart/feed). Streamed
 * behind <Suspense> so the page header paints before this resolves. The
 * security-critical org/auth gate already ran in the shell — `ctx` is passed
 * in so this never re-gates and the request-cached helpers reuse the layout's
 * loads.
 */
async function DashboardBody({
  ctx,
  warehouseFilter,
}: {
  ctx: Awaited<ReturnType<typeof requireOrgContext>>;
  warehouseFilter: string | null;
}) {
  const isManagerPlus = isManagerOrAbove(ctx.role);
  // The "waiting for signature" card links to the orders list filtered to
  // those orders, a list only someone who approves orders gets
  // (orders/page.tsx canApprove); anyone else lands on their own requests,
  // unfiltered, under an org-wide count (desk check F10). So only an approver
  // sees the card, and only for them is the count read.
  const canApproveOrders = can(ctx, 'orders:approve');

  // Single parallel fan-out — was two serial Promise.all blocks (15
  // queries total, the second waiting on the first to complete). With
  // both blocks merged, the page now blocks only on the slowest query
  // in the union instead of slowest-of-block-1 + slowest-of-block-2.
  // Measured: cut /dashboard FCP from ~3.7s to ~1.5s on warm cache.
  //
  // The two reads that used to run AFTER it, one after the other, live in it
  // now: the onboarding dismissal (user_profiles), and the low-stock
  // sparklines, which start the moment the low-stock rows land instead of
  // after everything else has returned. Three serial levels became one plus a
  // short chain. Each level was one more chance to wait: 3-5% of our server's
  // Supabase calls stall 1-8 s on weekday daytimes (logs, 2026-09-22).
  const supabase = await createClient();
  const lowStockRows = getLowStockItems(5, { warehouseId: warehouseFilter ?? undefined });
  const [
    summary,
    lowStock,
    // Real 14-day qty trends for the low-stock table sparklines. Replaces the
    // synthetic Math.sin curve every row used to show. One small query
    // bucketed in TS, run only when there are low-stock rows to chart.
    lowStockTrends,
    recentMovements,
    metrics,
    actions,
    history,
    poOverdueCount,
    cycleInProgress,
    pendingApprovals,
    awaitingSignature,
    teamCountRes,
    // Analytics-section inputs. history90 powers the value widget's 90d
    // range toggle (history above is the 30d series the StatCards reuse);
    // valuation feeds the category/warehouse breakdown donut. Both join the
    // single fan-out so they don't add a serial round trip.
    history90,
    valuation,
    // Request-cached: warehousesList + mfaFactors + orgRow are already fetched
    // by the dashboard layout (and the shell, for orgRow) in the same render.
    // React.cache() guarantees we get those results without a second Supabase
    // round-trip per page render. orgRow carries the per-org dashboard_layout
    // jsonb that drives the widget order/visibility below.
    warehousesList,
    mfaFactors,
    orgRow,
    // Cross-device dismissal of the Getting-started panel (mig 0257).
    profileRes,
  ] = await Promise.all([
    getDashboardSummary({ warehouseId: warehouseFilter ?? undefined }),
    lowStockRows,
    lowStockRows.then((rows) =>
      rows.length > 0
        ? getItemTrends(rows.map((r) => ({ id: r.id, quantityOnHand: r.quantity_on_hand })))
        : new Map<string, { qtySeries: number[]; moveSeries: number[] }>(),
    ),
    MovementsService.forCurrentUser().then((svc) =>
      svc.list({ limit: 6, warehouseId: warehouseFilter ?? undefined }),
    ),
    getThirtyDayMetrics({ warehouseId: warehouseFilter ?? undefined }),
    getDashboardActions({ warehouseId: warehouseFilter ?? undefined }),
    getDashboardHistory({ warehouseId: warehouseFilter ?? undefined }),
    PurchaseOrdersService.forCurrentUser().then((svc) =>
      svc.overdueCount({ warehouseId: warehouseFilter ?? undefined }),
    ),
    CycleCountsService.forCurrentUser().then((svc) =>
      svc.inProgressCount({ warehouseId: warehouseFilter ?? undefined }),
    ),
    // Manager+ are the only roles allowed to approve order requests; for
    // everyone else this hero row would point at a page they can't act on,
    // so we skip the query entirely instead of rendering a dead link.
    isManagerPlus
      ? OrderRequestsService.forCurrentUser().then((svc) => svc.pendingCount())
      : Promise.resolve(0),
    canApproveOrders
      ? OrderRequestsService.forCurrentUser().then((svc) => svc.awaitingSignatureCount())
      : Promise.resolve(0),
    supabase
      .from('organization_members')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', ctx.organizationId)
      .not('accepted_at', 'is', null),
    getDashboardHistory({ warehouseId: warehouseFilter ?? undefined, rangeDays: 90 }),
    // Valuation is org-wide (not warehouse-scoped) by design — the breakdown
    // donut shows the whole org's value split by category/warehouse, which is
    // most useful unfiltered. The byWarehouse rollup already answers the
    // per-warehouse question inside the widget.
    // Summary-only (rollups, not per-item rows) so the dashboard's DB cost
    // stays flat regardless of item count — the donut only needs byCategory/
    // byWarehouse. The full inventoryValuation() still backs the report page.
    ReportsService.forCurrentUser().then((svc) => svc.inventoryValuationSummary()),
    getWarehousesForRequest(ctx.organizationId),
    orSessionEnded(getMfaFactorsForRequest()),
    getOrgRowForRequest(ctx.organizationId),
    supabase
      .from('user_profiles')
      .select('onboarding_dismissed_at, full_name')
      .eq('id', ctx.userId)
      .maybeSingle(),
  ]);
  const warehouseCount = warehousesList.length;
  const teamCount = teamCountRes.count ?? 0;
  const hasVerifiedFactor = mfaFactors.some((f) => f.status === 'verified');

  const checklistSteps = [
    {
      id: 'warehouse',
      done: warehouseCount > 0,
      title: 'Confirm your warehouse',
      description: 'A "Main Warehouse" was created automatically — rename it or add more in Admin.',
      href: '/dashboard/admin/warehouses',
      cta: 'Open',
    },
    {
      id: 'team',
      done: teamCount > 1,
      title: 'Invite your team',
      description: 'Send invites so staff can scan and receive alongside you.',
      href: '/dashboard/team',
      cta: 'Invite',
    },
    {
      id: 'item',
      done: summary.itemCount > 0,
      title: 'Add your first item',
      description: 'Create a product or scan a book by ISBN to populate the catalog.',
      href: '/dashboard/inventory/new',
      cta: 'Add',
    },
    {
      id: 'mfa',
      done: hasVerifiedFactor,
      title: 'Secure your account',
      description: 'Enroll an authenticator app and grab recovery codes.',
      href: '/dashboard/settings/security',
      cta: 'Set up',
    },
  ];
  // Cross-device dismissal (mig 0257): treat dismissed exactly like complete
  // — the animated Getting-started panel never returns once waved away.
  const profileRow = profileRes.data;
  const checklistDismissed = Boolean(
    (profileRow as { onboarding_dismissed_at?: string | null } | null)?.onboarding_dismissed_at,
  );
  const checklistComplete = checklistDismissed || checklistSteps.every((s) => s.done);

  // Real 30-day series for the StatCards. Replaces the synthetic sin-wave
  // valueSeries and the hardcoded sparkline arrays that used to live here.
  // Today (index 29) reconciles with `summary` so the tile value and the
  // sparkline tip always agree.
  const valueSeries = history.inventoryValueSeries.map((value, i) => ({
    value,
    label: `D-${30 - i}`,
  }));
  const itemCountSeries = history.itemCountSeries;
  const inventoryValueSeries = history.inventoryValueSeries;
  const lowOutSeries = history.lowOutSeries;

  // Real 30-day movement metrics — replaces the synthetic barValues +
  // breakdownRows that lived here. Both are bounded by stock_movements
  // count over 30d, so query cost is small.
  const barValues = metrics.dailyCounts;
  // Each type in the Movements page's words ("Receive PO", "Bundle assembly"),
  // never the raw code with a capital ("Receive_po") (FX5, DESIGN-SPEC 6.10).
  const breakdownRows = metrics.byType.slice(0, 5).map((b) => ({
    label: movementTypeLabel(b.type),
    share: b.share,
    val: b.count,
  }));

  // ── Analytics-section widget data ──────────────────────────────────────
  // Map the already-fetched server data into JSON-serializable chart series
  // for the lazy Recharts island. `history` is the 30d series; `history90`
  // the 90d one — both feed the value widget's range toggle. The breakdown
  // donut + movement bars map from the valuation report and 30-day metrics.
  const analyticsValueSeries = {
    30: toValueSeries(history),
    90: toValueSeries(history90),
  };
  const analyticsByCategory = toBreakdownSlices(valuation, 'category');
  const analyticsByWarehouse = toBreakdownSlices(valuation, 'warehouse');
  const analyticsMovementBars = toMovementBars(metrics);

  // dailyCounts[29] is the rolling 24h ending at request time; [28] is the
  // 24h before that. Use the difference for a real delta on the
  // "Movements today" card so it stops flat-lining at 6.
  const movementsToday = metrics.dailyCounts.at(-1) ?? 0;
  const movementsYesterday = metrics.dailyCounts.at(-2) ?? 0;
  const movementsDelta = movementsToday - movementsYesterday;
  const movementsDeltaLabel =
    movementsDelta === 0 ? '—' : `${movementsDelta > 0 ? '+' : ''}${movementsDelta}`;
  const movementsDeltaDirection: 'up' | 'down' | 'flat' =
    movementsDelta > 0 ? 'up' : movementsDelta < 0 ? 'down' : 'flat';

  // Rolling 7-day movement total — used for the "Activity (7d)" status
  // metric in the top strip. Replaces the old "Recent moves" tile that was
  // hardwired to recentMovements.length and capped at 6.
  const movements7d = metrics.dailyCounts.slice(-7).reduce((a, b) => a + b, 0);

  // Delta + direction for a tile: today (index 29) against 30 days ago
  // (index 0). A percentage for value-y series (currency, big counts) and a
  // raw, inverted delta for low/out, where more is worse. The rules (near-zero
  // starts read "new", the 999%+ cap) live in widgets/deltas.ts, shared with
  // the value card's island so both say the same thing for the same line.
  const inventoryValueDelta = percentDelta(inventoryValueSeries);
  const itemCountDelta = percentDelta(itemCountSeries);
  const lowOutDelta = worseWhenUpDelta(lowOutSeries);

  const attentionStockCount = summary.lowStockCount + summary.outOfStockCount;
  const healthyCount = Math.max(summary.itemCount - attentionStockCount, 0);
  const healthRate =
    summary.itemCount > 0 ? Math.round((healthyCount / summary.itemCount) * 100) : 100;
  const valuePerSku = summary.itemCount > 0 ? summary.inventoryValue / summary.itemCount : 0;

  // "Needs attention" list — five categories, fixed priority order.
  // Each surfaced only when its count is > 0. Rank ascending = most urgent
  // first (stock runs out before paperwork goes stale). When ALL categories
  // are zero we render the "all clear" card instead of a misleading list.
  const attentionItems: AttentionItem[] = [];
  if (attentionStockCount > 0) {
    attentionItems.push({
      id: 'low-stock',
      title: `${attentionStockCount} item${attentionStockCount === 1 ? '' : 's'} at or below reorder point`,
      detail:
        summary.outOfStockCount > 0
          ? `${summary.outOfStockCount} critical · ${summary.lowStockCount} below par. Draft POs before they hit zero.`
          : 'Inventory below the reorder line. Draft POs before it hits zero.',
      href: '/dashboard/inventory?stock=low&type=all',
      rank: 1,
      tone: summary.outOfStockCount > 0 ? 'danger' : 'warn',
    });
  }
  if (poOverdueCount > 0) {
    attentionItems.push({
      id: 'po-overdue',
      title: `${poOverdueCount} overdue purchase order${poOverdueCount === 1 ? '' : 's'}`,
      detail: 'Expected receipt date has passed. Chase your suppliers or update the ETA.',
      href: '/dashboard/purchase-orders?status=overdue',
      rank: 2,
      tone: 'warn',
    });
  }
  if (isManagerPlus && pendingApprovals > 0) {
    attentionItems.push({
      id: 'order-approvals',
      title: `${pendingApprovals} order request${pendingApprovals === 1 ? '' : 's'} awaiting your approval`,
      detail: 'Requests are blocked until a manager moves them forward.',
      href: '/dashboard/orders?status=pending_approval',
      rank: 3,
      tone: 'warn',
    });
  }
  if (cycleInProgress > 0) {
    attentionItems.push({
      id: 'cycle-counts',
      title: `${cycleInProgress} cycle count${cycleInProgress === 1 ? '' : 's'} in progress`,
      detail: 'Lines are still open. Post counts to reconcile, or cancel if abandoned.',
      href: '/dashboard/cycle-counts',
      rank: 4,
      tone: 'neutral',
    });
  }
  if (awaitingSignature > 0) {
    attentionItems.push({
      id: 'orders-awaiting-signature',
      title: `${awaitingSignature} order${awaitingSignature === 1 ? '' : 's'} waiting for signature`,
      detail:
        'Staged for pickup or out for delivery. Confirm the QR-scan signature on arrival or hand-off.',
      href: ORDERS_AWAITING_SIGNATURE_HREF,
      rank: 5,
      tone: 'neutral',
    });
  }
  attentionItems.sort((a, b) => a.rank - b.rank);
  const attentionItemCount = attentionItems.length;
  const briefingSentence =
    attentionItemCount === 0
      ? 'Everything looks healthy.'
      : `${attentionItemCount} thing${attentionItemCount === 1 ? '' : 's'} need${attentionItemCount === 1 ? 's' : ''} attention today.`;

  // ── Compose the single, already-computed widget props bag ──────────────
  // Every widget reads its slice from this; none of them fetch data, so the
  // parallel fan-out above is unchanged and the load-perf work is preserved.
  const widgetProps: DashboardWidgetProps = {
    checklistSteps,
    checklistComplete,
    attentionItems,
    briefingSentence,
    healthRate,
    attentionStockCount,
    outOfStockCount: summary.outOfStockCount,
    valuePerSku,
    movements7d,
    itemCount: summary.itemCount,
    lowStockCount: summary.lowStockCount,
    openPoCount: actions.openPoCount,
    openCycleCount: actions.openCycleCount,
    inventoryValue: summary.inventoryValue,
    inventoryValueSeries,
    inventoryValueDelta,
    itemCountSeries,
    itemCountDelta,
    lowOutSeries,
    lowOutDelta,
    dailyCounts: metrics.dailyCounts,
    movementsToday,
    movementsDelta: {
      label: movementsDeltaLabel,
      direction: movementsDeltaDirection,
    },
    warehouseFilter,
    valueSeries,
    // Already-fetched (request-cached) warehouse list — feeds the value card's
    // interactive location filter without any extra round-trip.
    warehouses: warehousesList,
    barValues,
    breakdownRows,
    analytics: {
      valueSeries: analyticsValueSeries,
      byCategory: analyticsByCategory,
      byWarehouse: analyticsByWarehouse,
      movementBars: analyticsMovementBars,
    },
    lowStock,
    lowStockTrends,
    recentMovements: recentMovements as DashboardWidgetProps['recentMovements'],
  };

  // Resolve the ordered, visible widget id list from the per-org layout (read
  // off the request-cached org row; the editor that writes it ships in T3b).
  // FAIL-CLOSED: a null / empty / malformed layout yields the catalog default
  // order — pixel-identical to the pre-refactor dashboard. Never blanks.
  const layout = (orgRow?.dashboard_layout ?? null) as DashboardLayout | null;
  const widgetIds = resolveDashboardWidgets(
    layout,
    DASHBOARD_WIDGETS.map((w) => w.id),
  );

  return (
    <>
      {renderDashboardWidgets(widgetIds, widgetProps)}
      {/* Performance marker: mounts WITH the widgets, inside the Suspense
          boundary, once the data fan-out above has resolved. The greeting
          shell and OverviewBodySkeleton never render it. */}
      <PerfUseful />
    </>
  );
}
