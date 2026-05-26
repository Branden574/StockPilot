import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  Boxes,
  CheckCircle2,
  ChevronRight,
  ClipboardCheck,
  ClipboardList,
  DollarSign,
  Download,
  PackageCheck,
  PenLine,
  Plus,
  type LucideIcon,
  Zap,
} from 'lucide-react';
import Link from 'next/link';

import { BigChart } from '@/components/dashboard/big-chart';
import { MiniBarChart } from '@/components/dashboard/mini-bar-chart';
import { EmptyState } from '@/components/ui/empty-state';
import { GetStartedChecklist } from '@/components/dashboard/get-started-checklist';
import { StatCard } from '@/components/dashboard/stat-card';
import { Button } from '@/components/ui/button';
import { Sparkline } from '@/components/ui/sparkline';
import { StockBar } from '@/components/ui/stock-bar';
import { hasPermission, isManagerOrAbove } from '@stockpilot/core';
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
import { requireOrgContext } from '@/lib/auth/session';
import {
  getMfaFactorsForRequest,
  getOrgRowForRequest,
  getWarehousesForRequest,
} from '@/lib/dashboard/request-cache';
import { getActiveWarehouseFilter } from '@/lib/warehouse-filter';
import { createClient } from '@/lib/supabase/server';
import { formatCurrency, formatNumber, formatRelative } from '@/lib/utils';
import { cn } from '@/lib/utils';

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

interface AttentionItem {
  id: string;
  icon: LucideIcon;
  title: string;
  detail: string;
  href: string;
  /**
   * Priority rank — lower wins. Encodes the spec order: low-stock,
   * overdue POs, pending approvals, in-progress cycle counts, orders
   * awaiting signature. When multiple categories have non-zero counts the list
   * sorts by this rank, so the lead row is always the most urgent
   * surface (stockouts first, paperwork last).
   */
  rank: number;
  tone: 'danger' | 'warn' | 'neutral';
}

export default async function DashboardHome() {
  // Resolve the topbar warehouse filter once and pass it into every
  // summary call so the dashboard tiles, low-stock list, and shift-
  // command counts all narrow to the same scope.
  const warehouseFilter = await getActiveWarehouseFilter();

  // Resolve org context first so downstream service builders share the same
  // React.cache()'d auth load. Then dispatch every dashboard data fetch in
  // parallel — one round trip per branch.
  const ctx = await requireOrgContext();
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
    activeWhNameRes,
    // Request-cached: these three (warehousesList, mfaFactors, orgRow)
    // are already fetched by the dashboard layout in the same render.
    // React.cache() guarantees we get the layout's result without a
    // second Supabase round-trip per page render.
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
    warehouseFilter
      ? supabase
          .from('warehouses')
          .select('name')
          .eq('id', warehouseFilter)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    getWarehousesForRequest(ctx.organizationId),
    getMfaFactorsForRequest(),
    getOrgRowForRequest(ctx.organizationId),
  ]);
  const activeWarehouseName = (activeWhNameRes.data?.name as string | undefined) ?? null;
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
  const checklistComplete = checklistSteps.every((s) => s.done);

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

  // Greeting + journalistic date header. Time-of-day greeting respects the
  // org's saved timezone (see organizations.timezone, default 'UTC') so a
  // late-night warehouse in Tokyo doesn't say "good morning" because the
  // Vercel pod woke up in Virginia at 9am ET.
  const orgTimezone = orgRow?.timezone ?? null;
  const { word: greetingWord, dateLabel: today } = buildGreeting(orgTimezone);
  const firstName = ctx.fullName?.split(' ')[0]?.trim() || 'there';

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

  return (
    <div className="mx-auto w-full max-w-[1760px] px-5 pb-20 pt-6 sm:px-7 2xl:px-9">
      {!checklistComplete && (
        <div className="mb-5">
          <GetStartedChecklist steps={checklistSteps} />
        </div>
      )}
      {/* ──────────────── Morning briefing — greeting + hero attention ─────────
       *
       * The hero section is the LEAD. Everything below it (stat row, charts,
       * activity feed) is context. The greeting + briefing sentence answer
       * "who is at the keyboard and what should they look at first"; the
       * attention list answers "where should they click right now".
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
            <p className="mt-1.5 text-[14px] text-[var(--ed-ink-3)]">{briefingSentence}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" asChild>
              <Link href="/dashboard/reports">
                <Download className="h-3 w-3" /> Export
              </Link>
            </Button>
            {hasPermission(ctx.role, 'items:create') && (
              <Button variant="outline" size="sm" asChild>
                <Link href="/dashboard/inventory/new">
                  <Plus className="h-3 w-3" /> New item
                </Link>
              </Button>
            )}
            {hasPermission(ctx.role, 'purchase_orders:manage') && (
              <Button size="sm" asChild>
                <Link href="/dashboard/purchase-orders/new">
                  <Zap className="h-3 w-3" /> Receive stock
                </Link>
              </Button>
            )}
          </div>
        </div>

        <NeedsAttentionHero items={attentionItems} />
      </section>

      <div className="mb-4 flex items-end justify-between gap-3 border-b border-border pb-2">
        <div>
          <h2 className="font-display text-[18px] font-medium tracking-[-0.015em]">
            30-day trends
          </h2>
          <p className="text-[12px] text-[var(--ed-ink-3)]">
            Inventory value, on-hand counts, and movement velocity over the last month.
          </p>
        </div>
        <div className="hidden grid-cols-4 gap-2 sm:grid sm:max-w-xl sm:flex-1">
          <StatusMetric
            label="Health"
            value={`${healthRate}%`}
            tone={attentionStockCount > 0 ? 'warn' : 'good'}
          />
          <StatusMetric
            label="Critical"
            value={formatNumber(summary.outOfStockCount)}
            tone="danger"
          />
          <StatusMetric label="Avg value / SKU" value={formatCurrency(valuePerSku)} />
          <StatusMetric label="Activity (7d)" value={formatNumber(movements7d)} />
        </div>
      </div>

      {/* Shift command — moved below the hero so the morning glance reads
       * top-to-bottom: who/why first, then "where to click next". */}
      <aside className="mb-4 bg-card rounded-lg border border-[var(--ed-line-strong)] p-4 shadow-[0_14px_44px_rgba(14,15,13,0.06)]">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="font-display text-[14px] font-medium tracking-[-0.01em]">
              Shift command
            </div>
            <p className="mt-0.5 text-[12px] text-[var(--ed-ink-3)]">
              Fast paths for the next inventory action.
            </p>
          </div>
          <span className="border-border bg-background inline-flex h-6 items-center gap-1.5 rounded-full border px-2 text-[11px] text-[var(--ed-ink-3)]">
            <span className="h-1.5 w-1.5 rounded-full bg-[hsl(var(--accent))]" />
            Live
          </span>
        </div>

        <div className="divide-border border-border bg-background mt-4 grid grid-cols-3 divide-x overflow-hidden rounded-md border">
          <MiniReadout label="SKUs" value={formatNumber(summary.itemCount)} />
          <MiniReadout label="Low" value={formatNumber(summary.lowStockCount)} />
          <MiniReadout label="Out" value={formatNumber(summary.outOfStockCount)} />
        </div>

        <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
          <QuickAction
            href="/dashboard/inventory?stock=low&type=all"
            icon={AlertTriangle}
            label="Review low stock"
            badge={
              summary.lowStockCount + summary.outOfStockCount > 0
                ? formatNumber(summary.lowStockCount + summary.outOfStockCount)
                : undefined
            }
          />
          <QuickAction
            href="/dashboard/purchase-orders"
            icon={ClipboardList}
            label="Open purchase orders"
            badge={actions.openPoCount > 0 ? formatNumber(actions.openPoCount) : undefined}
          />
          <QuickAction
            href="/dashboard/cycle-counts"
            icon={ClipboardCheck}
            label="Cycle counts in progress"
            badge={actions.openCycleCount > 0 ? formatNumber(actions.openCycleCount) : undefined}
          />
          <QuickAction
            href="/dashboard/purchase-orders/new"
            icon={Zap}
            label="Create receiving run"
          />
          <QuickAction href="/dashboard/reports" icon={ArrowUpRight} label="Open reports" />
        </div>
      </aside>

      {/* Stat row */}
      <div className="mb-4 grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Inventory value"
          value={formatCurrency(summary.inventoryValue)}
          delta={{ value: inventoryValueDelta.label, direction: inventoryValueDelta.direction }}
          series={inventoryValueSeries.slice(-14)}
          foot="vs. 30 days ago"
          icon={DollarSign}
        />
        <StatCard
          label="Items on hand"
          value={formatNumber(summary.itemCount)}
          delta={{ value: itemCountDelta.label, direction: itemCountDelta.direction }}
          series={itemCountSeries.slice(-14)}
          foot={`${summary.itemCount} active SKUs`}
          icon={PackageCheck}
        />
        <StatCard
          label="Low / out of stock"
          value={formatNumber(summary.lowStockCount + summary.outOfStockCount)}
          delta={{ value: lowOutDelta.label, direction: lowOutDelta.direction }}
          series={lowOutSeries.slice(-14)}
          foot={`${summary.outOfStockCount} critical · ${summary.lowStockCount} below par`}
          icon={AlertTriangle}
        />
        <StatCard
          label="Movements today"
          value={formatNumber(movementsToday)}
          delta={{ value: movementsDeltaLabel, direction: movementsDeltaDirection }}
          series={metrics.dailyCounts.slice(-14)}
          foot={
            warehouseFilter
              ? 'in selected warehouse · last 24h'
              : 'across all locations · last 24h'
          }
          icon={Activity}
        />
      </div>

      {/* Big chart + movement breakdown */}
      <div className="mb-4 grid grid-cols-1 gap-3.5 lg:grid-cols-12">
        <Card className="lg:col-span-9">
          <CardHead
            title="Inventory value · 30 days"
            subtitle="USD · cost basis · all locations"
            chips={['All locations', 'Cost basis', '+ Compare']}
          />
          <BigChart data={valueSeries} height={300} />
          <div className="flex justify-between px-5 pb-3.5 font-mono text-[11px] text-[var(--ed-ink-4)]">
            <span>30 days ago</span>
            <span>3 weeks ago</span>
            <span>2 weeks ago</span>
            <span>1 week ago</span>
            <span>Today</span>
          </div>
        </Card>

        <Card className="lg:col-span-3">
          <CardHead title="Movements · 30 days" subtitle="Receive · sale · transfer · adjust" />
          <div className="px-5 pb-4">
            <MiniBarChart values={barValues} height={120} />
            <hr className="border-border my-4" />
            <div className="flex flex-col gap-3">
              {breakdownRows.length === 0 && (
                <p className="text-muted-foreground py-1 text-[12px]">
                  No movements in the last 30 days.
                </p>
              )}
              {breakdownRows.map((r) => (
                <div key={r.label} className="flex items-center justify-between">
                  <span className="text-[12.5px]">{r.label}</span>
                  <div className="flex items-center gap-2">
                    <span
                      className="bg-muted block h-1.5 w-20 overflow-hidden rounded-full"
                      aria-hidden
                    >
                      <span
                        className="block h-full rounded-full bg-[var(--ed-ink-2)]"
                        style={{ width: `${r.share * 100}%` }}
                      />
                    </span>
                    <span className="w-6 text-right font-mono text-[11.5px] tabular-nums text-[var(--ed-ink-3)]">
                      {r.val}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </Card>
      </div>

      {/* ──────────────── Recent activity — context, not lead ───────────────
       *
       * Low-stock detail table + today's movement feed. The hero up top
       * already surfaced the "act now" version of the low-stock signal —
       * this section gives the operator the full table so they can drill
       * into individual SKUs.
       */}
      <div className="mt-2 mb-4 flex items-end justify-between gap-3 border-b border-border pb-2">
        <div>
          <h2 className="font-display text-[18px] font-medium tracking-[-0.015em]">
            Recent activity
          </h2>
          <p className="text-[12px] text-[var(--ed-ink-3)]">
            Low-stock detail and the live movement feed.
          </p>
        </div>
      </div>
      <div className="grid grid-cols-1 gap-3.5 lg:grid-cols-12">
        <Card className="lg:col-span-7">
          <CardHead
            title="Low-stock detail"
            subtitle="Items below reorder point"
            action={
              <Link
                href="/dashboard/inventory?stock=low&type=all"
                className="border-border bg-card inline-flex h-6 items-center gap-1 rounded-md border px-2.5 text-[12px] hover:border-[var(--ed-line-strong)]"
              >
                View all <ChevronRight className="h-3 w-3" />
              </Link>
            }
          />
          {lowStock.length === 0 && summary.itemCount === 0 ? (
            <div className="px-5 pb-6">
              <EmptyState
                icon={Boxes}
                title="No inventory yet"
                description="Add your first item to start tracking stock, locations, and movements."
                cta={{ label: 'Add your first item', href: '/dashboard/inventory/new' }}
                size="sm"
              />
            </div>
          ) : lowStock.length === 0 ? (
            <p className="px-5 pb-5 text-[12.5px] text-[var(--ed-ink-3)]">
              Nothing below reorder point. Quiet shift.
            </p>
          ) : (
            <table className="w-full text-[12.5px]">
              <thead>
                <tr className="border-border border-b">
                  {['Item', 'On hand', 'Reorder', 'Coverage', '14-day', ''].map((h, i) => (
                    <th
                      key={h || i}
                      className={cn(
                        'h-9 px-3 text-[10.5px] font-medium uppercase tracking-[0.06em] text-[var(--ed-ink-4)]',
                        (i === 1 || i === 2 || i === 4) && 'text-right',
                      )}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {lowStock.map((row) => {
                  const par = Math.max(row.reorder_point * 4, row.quantity_on_hand * 1.5, 10);
                  const status: 'ok' | 'warn' | 'crit' =
                    row.quantity_on_hand <= 0 ? 'crit' : 'warn';
                  return (
                    <tr
                      key={row.id}
                      className="border-border hover:bg-muted/50 border-b last:border-0"
                    >
                      <td className="py-2.5 pl-3 pr-3">
                        <div className="flex items-center gap-2.5">
                          <span
                            aria-hidden
                            className="border-border h-7 w-7 shrink-0 rounded-[5px] border"
                            style={{
                              background:
                                'repeating-linear-gradient(45deg, hsl(var(--border)) 0 1px, transparent 1px 6px), hsl(var(--muted))',
                            }}
                          />
                          <div>
                            <Link
                              href={`/dashboard/inventory/${row.id}`}
                              className="font-medium hover:underline"
                            >
                              {row.name}
                            </Link>
                            <div className="font-mono text-[10.5px] text-[var(--ed-ink-3)]">
                              {row.sku}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="px-3 text-right font-mono tabular-nums">
                        {formatNumber(row.quantity_on_hand)}
                      </td>
                      <td className="px-3 text-right font-mono tabular-nums text-[var(--ed-ink-3)]">
                        {formatNumber(row.reorder_point)}
                      </td>
                      <td className="px-3">
                        <StockBar stock={row.quantity_on_hand} par={par} status={status} />
                      </td>
                      <td className="px-3 text-right">
                        <Sparkline
                          data={
                            lowStockTrends.get(row.id)?.qtySeries ??
                            new Array<number>(14).fill(row.quantity_on_hand)
                          }
                          width={70}
                          height={20}
                        />
                      </td>
                      <td className="px-3 text-right">
                        <span
                          className={cn(
                            'inline-flex h-5 items-center gap-1 rounded-[4px] px-1.5 text-[11px] font-medium',
                            status === 'crit'
                              ? 'bg-[hsl(var(--destructive)/0.16)] text-[hsl(var(--destructive))]'
                              : 'bg-[hsl(var(--warning)/0.18)] text-[hsl(var(--warning-foreground))]',
                          )}
                        >
                          <span className="h-1 w-1 rounded-full bg-current" />
                          {status === 'crit' ? 'Out' : 'Low'}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Card>

        <Card className="lg:col-span-5">
          <CardHead title="Today's activity" subtitle="Live · across all locations" />
          {recentMovements.length === 0 ? (
            <p className="px-5 pb-5 text-[12.5px] text-[var(--ed-ink-3)]">
              No movements yet. Adjust stock from any item to see entries here.
            </p>
          ) : (
            <ul>
              {recentMovements.map((m, i) => {
                const item = m.item;
                const change = Number(m.quantity_change);
                return (
                  <li
                    key={m.id as string}
                    className={cn(
                      'grid items-center gap-3 px-5 py-2.5',
                      i < recentMovements.length - 1 && 'border-border border-b',
                    )}
                    style={{ gridTemplateColumns: '60px 1fr auto' }}
                  >
                    <div className="font-mono text-[10.5px] text-[var(--ed-ink-3)]">
                      {formatRelative(m.created_at as string)
                        .replace(' ago', '')
                        .replace(/seconds?/, 's')
                        .replace(/minutes?/, 'm')
                        .replace(/hours?/, 'h')
                        .replace(/days?/, 'd')}
                    </div>
                    <div>
                      <div className="text-[12.5px]">
                        <span
                          className={cn(
                            'mr-1.5 inline-flex h-[18px] items-center rounded-[4px] px-1.5 text-[10px] font-medium',
                            change > 0
                              ? 'bg-[hsl(var(--accent)/0.18)] text-[hsl(var(--accent-foreground))]'
                              : 'bg-muted text-[var(--ed-ink-3)]',
                          )}
                        >
                          {(m.movement_type as string).replace('_', ' ')}
                        </span>
                        {item?.name ?? 'Unknown'}
                      </div>
                      <div className="mt-0.5 font-mono text-[10.5px] text-[var(--ed-ink-3)]">
                        {m.actor?.fullName ?? m.actor?.email ?? (m.user_id ? 'Unknown' : 'System')}
                        {((m.reason as string | null) ?? null) && (
                          <>
                            {' · '}
                            {m.reason as string}
                          </>
                        )}
                      </div>
                    </div>
                    <div
                      className={cn(
                        'font-mono text-[13px] font-medium tabular-nums',
                        change > 0
                          ? 'text-[hsl(var(--accent-foreground))]'
                          : 'text-[var(--ed-ink-3)]',
                      )}
                    >
                      {change > 0 ? '+' : ''}
                      {formatNumber(change)}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}

/**
 * Vertically-stacked attention list. Each row is a journalistic
 * "headline + dek + take a look →" so the operator can scan top-to-bottom
 * without having to parse a grid of pill counters. Renders the "all clear"
 * card when the items array is empty.
 */
function NeedsAttentionHero({ items }: { items: AttentionItem[] }) {
  if (items.length === 0) {
    return (
      <div className="border-border bg-card flex items-center gap-4 rounded-xl border p-5 shadow-[0_10px_34px_rgba(14,15,13,0.045)]">
        <span
          aria-hidden
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[hsl(var(--accent)/0.16)]"
        >
          <CheckCircle2 className="h-5 w-5 text-[hsl(var(--accent-foreground))]" />
        </span>
        <div className="min-w-0">
          <div className="font-display text-[15px] font-medium tracking-[-0.01em]">
            All clear — nothing needs attention today.
          </div>
          <p className="text-[12.5px] text-[var(--ed-ink-3)]">
            No low stock, no overdue POs, no pending approvals, no open counts, no
            orders awaiting signature. The numbers below are just context.
          </p>
        </div>
      </div>
    );
  }
  return (
    <ul className="border-border bg-card divide-y divide-border overflow-hidden rounded-xl border shadow-[0_10px_34px_rgba(14,15,13,0.045)]">
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <li key={item.id}>
            <Link
              href={item.href}
              className="hover:bg-muted/60 group flex items-start gap-4 px-5 py-4 transition-colors"
            >
              <span
                aria-hidden
                className={cn(
                  'mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full',
                  item.tone === 'danger' && 'bg-[hsl(var(--destructive)/0.14)]',
                  item.tone === 'warn' && 'bg-[hsl(var(--warning)/0.18)]',
                  item.tone === 'neutral' && 'bg-muted',
                )}
              >
                <Icon
                  className={cn(
                    'h-4 w-4',
                    item.tone === 'danger' && 'text-[hsl(var(--destructive))]',
                    item.tone === 'warn' && 'text-[hsl(var(--warning-foreground))]',
                    item.tone === 'neutral' && 'text-[var(--ed-ink-3)]',
                  )}
                />
              </span>
              <div className="min-w-0 flex-1">
                <div className="font-display text-[14.5px] font-medium tracking-[-0.005em]">
                  {item.title}
                </div>
                <p className="mt-0.5 text-[12.5px] text-[var(--ed-ink-3)]">{item.detail}</p>
              </div>
              <span className="mt-1 inline-flex shrink-0 items-center gap-1 text-[12px] font-medium text-[var(--ed-ink-2)] group-hover:text-foreground">
                Take a look <ChevronRight className="h-3.5 w-3.5" />
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

function StatusMetric({
  label,
  value,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  tone?: 'neutral' | 'good' | 'warn' | 'danger';
}) {
  return (
    <div className="border-border bg-card rounded-md border px-3 py-2.5">
      <div className="text-[10.5px] font-medium uppercase tracking-[0.08em] text-[var(--ed-ink-4)]">
        {label}
      </div>
      <div
        className={cn(
          'mt-1 font-mono text-[18px] font-medium tabular-nums leading-none',
          // Use the standalone hue vars (`--accent`, `--warning`) not the
          // *-foreground vars — those are designed for text painted ON a
          // colored background and are near-black/near-white, which goes
          // invisible when used as standalone text on the card surface.
          tone === 'good' && 'text-[hsl(var(--accent))]',
          tone === 'warn' && 'text-[hsl(var(--warning))]',
          tone === 'danger' && 'text-[hsl(var(--destructive))]',
        )}
      >
        {value}
      </div>
    </div>
  );
}

function MiniReadout({ label, value }: { label: string; value: string }) {
  return (
    <div className="px-3 py-2.5">
      <div className="font-mono text-[16px] font-medium tabular-nums leading-none">{value}</div>
      <div className="mt-1 text-[10.5px] uppercase tracking-[0.08em] text-[var(--ed-ink-4)]">
        {label}
      </div>
    </div>
  );
}

function QuickAction({
  href,
  icon: Icon,
  label,
  badge,
}: {
  href: string;
  icon: LucideIcon;
  label: string;
  /** Optional count pill rendered before the chevron (e.g. open PO count). */
  badge?: string;
}) {
  return (
    <Link
      href={href}
      className="border-border bg-background hover:bg-muted flex min-h-9 items-center justify-between gap-3 rounded-md border px-3 text-[12.5px] transition-colors hover:border-[var(--ed-line-strong)]"
    >
      <span className="flex min-w-0 items-center gap-2">
        <Icon className="h-3.5 w-3.5 shrink-0 text-[var(--ed-ink-3)]" />
        <span className="truncate">{label}</span>
      </span>
      <span className="flex shrink-0 items-center gap-1.5">
        {badge && (
          <span className="border-border bg-card text-foreground inline-flex h-5 min-w-[20px] items-center justify-center rounded-full border px-1.5 font-mono text-[10.5px] tabular-nums">
            {badge}
          </span>
        )}
        <ChevronRight className="h-3.5 w-3.5 text-[var(--ed-ink-4)]" />
      </span>
    </Link>
  );
}

function Card({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'border-border bg-card overflow-hidden rounded-lg border shadow-[0_10px_34px_rgba(14,15,13,0.045)]',
        className,
      )}
    >
      {children}
    </div>
  );
}

function CardHead({
  title,
  subtitle,
  chips,
  action,
}: {
  title: string;
  subtitle?: string;
  chips?: string[];
  action?: React.ReactNode;
}) {
  return (
    <div className="border-border flex flex-wrap items-start justify-between gap-x-3 gap-y-2 border-b px-5 py-3.5 sm:items-center">
      <div className="min-w-0">
        <div className="font-display text-[14px] font-medium tracking-[-0.01em]">{title}</div>
        {subtitle && <div className="text-[12px] text-[var(--ed-ink-3)]">{subtitle}</div>}
      </div>
      {chips && (
        <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
          {chips.map((c) => (
            <span
              key={c}
              className={cn(
                'inline-flex h-6 shrink-0 items-center rounded-full border px-2.5 text-[11.5px]',
                c.startsWith('+')
                  ? 'border-border border-dashed text-[var(--ed-ink-3)]'
                  : 'border-border bg-background text-[var(--ed-ink-2)]',
              )}
            >
              {c}
            </span>
          ))}
        </div>
      )}
      {action}
    </div>
  );
}
