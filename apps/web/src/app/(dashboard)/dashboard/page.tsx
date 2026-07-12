import { Suspense } from 'react';
import {
  AlertTriangle,
  ClipboardCheck,
  ClipboardList,
  Download,
  PenLine,
  Plus,
  Zap,
} from 'lucide-react';
import Link from 'next/link';

import {
  toBreakdownSlices,
  toMovementBars,
  toValueSeries,
} from '@/components/dashboard/charts/widget-data';
import {
  renderDashboardWidgets,
  type AttentionItem,
  type DashboardWidgetProps,
} from '@/components/dashboard/widgets';
import { Button } from '@/components/ui/button';
import { can, DASHBOARD_WIDGETS, isManagerOrAbove, resolveDashboardWidgets, type DashboardLayout } from '@stockpilot/core';
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
import {
  getMfaFactorsForRequest,
  getOrgRowForRequest,
  getWarehousesForRequest,
} from '@/lib/dashboard/request-cache';
import { getActiveWarehouseFilter } from '@/lib/warehouse-filter';
import { createClient } from '@/lib/supabase/server';

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
    hour >= 5 && hour <= 11
      ? 'morning'
      : hour >= 12 && hour <= 17
        ? 'afternoon'
        : 'evening';
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
      ? supabaseShell
          .from('warehouses')
          .select('name')
          .eq('id', warehouseFilter)
          .maybeSingle()
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
    <div className="mx-auto w-full max-w-[1760px] px-5 pb-20 pt-6 sm:px-7 2xl:px-9">
      {/* ──────────────── Morning briefing — greeting + hero attention ─────────
       *
       * The hero section is the LEAD. Everything below it (stat row, charts,
       * activity feed) is context. The greeting + briefing sentence answer
       * "who is at the keyboard and what should they look at first"; the
       * attention list answers "where should they click right now".
       *
       * The greeting + action buttons paint immediately from the request-
       * cached auth context; the data-driven body (checklist, attention hero,
       * stat row, charts, activity feed) streams in via <Suspense> below.
       */}
      <section className="mb-6">
        <div className="flex flex-col gap-4 pb-5 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.1em] text-[var(--ed-ink-4)]">
              {today}
              {activeWarehouseName && (
                <>
                  {' · '}
                  <span className="text-foreground">
                    filtered to {activeWarehouseName}
                  </span>
                </>
              )}
            </p>
            <h1 className="font-display text-[34px] font-medium leading-tight tracking-[-0.025em]">
              Good {greetingWord}, {firstName}.
            </h1>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" asChild>
              <Link href="/dashboard/reports">
                <Download className="h-3 w-3" /> Export
              </Link>
            </Button>
            {can(ctx, 'items:create') && (
              <Button variant="outline" size="sm" asChild>
                <Link href="/dashboard/inventory/new">
                  <Plus className="h-3 w-3" /> New item
                </Link>
              </Button>
            )}
            {can(ctx, 'purchase_orders:manage') && (
              <Button size="sm" asChild>
                <Link href="/dashboard/purchase-orders/new">
                  <Zap className="h-3 w-3" /> Receive stock
                </Link>
              </Button>
            )}
          </div>
        </div>
      </section>

      <Suspense fallback={<DashboardBodySkeleton />}>
        <DashboardBody ctx={ctx} warehouseFilter={warehouseFilter} />
      </Suspense>
    </div>
  );
}

/**
 * Lightweight fallback for the streamed dashboard body. Mirrors the rough
 * shape of the data sections (stat row + chart row) so the layout doesn't
 * jump when the real content streams in. Chrome above (greeting + actions)
 * has already painted by the time this shows.
 */
function DashboardBodySkeleton() {
  return (
    <div className="animate-pulse">
      <div className="mb-4 grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="bg-card h-[120px] rounded-lg border border-border" />
        ))}
      </div>
      <div className="mb-4 grid grid-cols-1 gap-3.5 lg:grid-cols-12">
        <div className="bg-card h-[360px] rounded-lg border border-border lg:col-span-9" />
        <div className="bg-card h-[360px] rounded-lg border border-border lg:col-span-3" />
      </div>
      <div className="grid grid-cols-1 gap-3.5 lg:grid-cols-12">
        <div className="bg-card h-[300px] rounded-lg border border-border lg:col-span-7" />
        <div className="bg-card h-[300px] rounded-lg border border-border lg:col-span-5" />
      </div>
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

  // Single parallel fan-out — was two serial Promise.all blocks (15
  // queries total, the second waiting on the first to complete). With
  // both blocks merged, the page now blocks only on the slowest query
  // in the union instead of slowest-of-block-1 + slowest-of-block-2.
  // Measured: cut /dashboard FCP from ~3.7s to ~1.5s on warm cache.
  const supabase = await createClient();
  const [
    summary,
    lowStock,
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
  ] = await Promise.all([
    getDashboardSummary({ warehouseId: warehouseFilter ?? undefined }),
    getLowStockItems(5, { warehouseId: warehouseFilter ?? undefined }),
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
    OrderRequestsService.forCurrentUser().then((svc) =>
      svc.awaitingSignatureCount(),
    ),
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
    getMfaFactorsForRequest(),
    getOrgRowForRequest(ctx.organizationId),
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
  const { data: profileRow } = await supabase
    .from('user_profiles')
    .select('onboarding_dismissed_at, full_name')
    .eq('id', ctx.userId)
    .maybeSingle();
  const checklistDismissed = Boolean(
    (profileRow as { onboarding_dismissed_at?: string | null } | null)?.onboarding_dismissed_at,
  );
  const checklistComplete = checklistDismissed || checklistSteps.every((s) => s.done);

  // Real 14-day qty trends for the low-stock table sparklines. Replaces the
  // synthetic Math.sin curve every row used to show. One small query
  // bucketed in TS — runs only when there are low-stock rows to chart.
  const lowStockTrends =
    lowStock.length > 0
      ? await getItemTrends(
          lowStock.map((r) => ({ id: r.id, quantityOnHand: r.quantity_on_hand })),
        )
      : new Map<string, { qtySeries: number[]; moveSeries: number[] }>();

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
  const breakdownRows = metrics.byType.slice(0, 5).map((b) => ({
    label: b.type.replace(/^./, (s) => s.toUpperCase()),
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

  // Compute delta + direction for a tile by comparing today (index 29) to
  // 30 days ago (index 0). Returns a percentage label for value-y series
  // (currency, big counts) and a raw delta label for low/out.
  //
  // When `head` is at or near zero (fresh org just loading inventory, or
  // floating-point dust from the reverse-walk math), the percentage
  // explodes to astronomical garbage. Treat that as "new" instead of
  // dividing into a tiny denominator. The 1.0 threshold absorbs the
  // common case of a near-zero starting value while still treating
  // "1 unit → 100 units" as a real +9900% growth signal.
  const NEAR_ZERO = 1.0;
  // Cap the displayed percentage so even legitimate huge growths render
  // as a readable token instead of a 17-digit number.
  const MAX_DISPLAY_PCT = 999;
  const deltaPct = (series: number[]): { label: string; direction: 'up' | 'down' | 'flat' } => {
    const head = series[0] ?? 0;
    const tail = series.at(-1) ?? 0;
    if (Math.abs(head) < NEAR_ZERO && Math.abs(tail) < NEAR_ZERO) {
      return { label: '—', direction: 'flat' };
    }
    if (Math.abs(head) < NEAR_ZERO) {
      return { label: 'new', direction: 'up' };
    }
    const pct = ((tail - head) / head) * 100;
    if (Math.abs(pct) < 0.05) return { label: '—', direction: 'flat' };
    if (Math.abs(pct) > MAX_DISPLAY_PCT) {
      return {
        label: `${pct > 0 ? '+' : '−'}${MAX_DISPLAY_PCT}%+`,
        direction: pct > 0 ? 'up' : 'down',
      };
    }
    const rounded = pct.toFixed(1);
    return {
      label: `${pct > 0 ? '+' : ''}${rounded}%`,
      direction: pct > 0 ? 'up' : 'down',
    };
  };
  const deltaRaw = (series: number[]): { label: string; direction: 'up' | 'down' | 'flat' } => {
    const head = series[0] ?? 0;
    const tail = series.at(-1) ?? 0;
    const diff = tail - head;
    if (diff === 0) return { label: '—', direction: 'flat' };
    return {
      label: `${diff > 0 ? '+' : ''}${diff}`,
      // For low/out, MORE is bad — invert so up=red feels right.
      direction: diff > 0 ? 'down' : 'up',
    };
  };
  const inventoryValueDelta = deltaPct(inventoryValueSeries);
  const itemCountDelta = deltaPct(itemCountSeries);
  const lowOutDelta = deltaRaw(lowOutSeries);

  const attentionStockCount = summary.lowStockCount + summary.outOfStockCount;
  const healthyCount = Math.max(summary.itemCount - attentionStockCount, 0);
  const healthRate =
    summary.itemCount > 0 ? Math.round((healthyCount / summary.itemCount) * 100) : 100;
  const valuePerSku = summary.itemCount > 0 ? summary.inventoryValue / summary.itemCount : 0;

  // Hero "needs attention" list — five categories, fixed priority order.
  // Each surfaced only when its count is > 0. Rank ascending = most urgent
  // first (stock runs out before paperwork goes stale). When ALL categories
  // are zero we render the "all clear" card instead of a misleading list.
  const attentionItems: AttentionItem[] = [];
  if (attentionStockCount > 0) {
    attentionItems.push({
      id: 'low-stock',
      icon: AlertTriangle,
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
      icon: ClipboardList,
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
      icon: ClipboardCheck,
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
      icon: ClipboardCheck,
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
      icon: PenLine,
      title: `${awaitingSignature} order${awaitingSignature === 1 ? '' : 's'} waiting for signature`,
      detail:
        'Staged for pickup or out for delivery. Confirm the QR-scan signature on arrival or hand-off.',
      href: '/dashboard/orders?tab=in_transit',
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

  return <>{renderDashboardWidgets(widgetIds, widgetProps)}</>;
}
