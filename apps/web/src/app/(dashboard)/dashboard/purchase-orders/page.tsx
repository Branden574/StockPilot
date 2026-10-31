import { ClipboardList, Download, SearchX } from 'lucide-react';
import Link from 'next/link';

import { checkModuleAccess } from '@/lib/modules/module-gate';
import { requireOrgContext } from '@/lib/auth/session';
import { getOrgRowForRequest } from '@/lib/dashboard/request-cache';
import { reportError } from '@/lib/error-reporter';
import { effectiveNavLabel } from '@/lib/nav-labels';
import { createClient } from '@/lib/supabase/server';
import { ModuleUnavailable } from '@/components/dashboard/module-unavailable';
import { FilterBar } from '@/components/patterns/filter-bar';
import { PageHeader, SublineValue } from '@/components/patterns/page-header';
import { SegmentedTabs } from '@/components/patterns/segmented-tabs';
import { StatePanel } from '@/components/patterns/state-panel';
import { StatStrip, StatStripItem } from '@/components/patterns/stat-strip';
import { PoApprovalPanel } from '@/components/settings/po-approval-panel';
import { Button } from '@/components/ui/button';
import { PoInstantTable, PoListTable, type PoInstantRow } from '@/components/po/po-instant-table';
import { PoSearch } from '@/components/po/po-search';
import {
  PurchaseOrdersService,
  type PoListStats,
  type PoPageRow,
} from '@/server/services/purchase-orders';
import { SuppliersService } from '@/server/services/suppliers';
import { getActiveWarehouseFilter } from '@/lib/warehouse-filter';
import { searchedPage } from '@/lib/purchase-orders/list-search';
import { cn, formatCurrency } from '@/lib/utils';
import {
  isPoTab,
  statusesForTab,
  TAB_LABELS,
  TAB_ORDER,
  type PoTab,
} from '@/lib/purchase-orders/tabs';

import { formatCalendarDate, resolveOrgTimezone } from '@stockpilot/core';

export const metadata = { title: 'Purchase orders' };

/**
 * Rows per page. The table is paginated SERVER-SIDE (searchParams-driven,
 * same pattern as the inventory page's ?page=N): the old version dumped
 * every org PO into this RSC and filtered/rendered them all in memory,
 * which at tens of thousands of POs meant dozens of serial DB round trips
 * plus an unbounded HTML table per view.
 */
const PAGE_SIZE = 30;

/**
 * Instant-search threshold. When the org has ≤ this many POs total, the active
 * tab is loaded in full and filtered client-side (zero-latency, matching the
 * Items/Books instant experience). Above it, server-side pagination + search
 * (the mig-0227 scale path) stays in force.
 */
const PO_INSTANT_CAP = 800;

/** The page area (DESIGN-SPEC 5.3 and 4): max 1320, 28 / 32 / 64, 16 px gutters on a phone. */
const PAGE = 'mx-auto flex w-full max-w-[1320px] flex-col gap-4 px-4 pb-16 pt-6 sm:px-8 sm:pt-7';

/** The filter row: on a phone each group takes the whole width, so the search spans it. */
const TOOLBAR = 'max-sm:[&>div]:w-full';

/**
 * The four stats sit two by two until the content is wide enough for one row
 * of four, so a phone shows them in two short rows instead of four tall ones.
 */
const STATS = '[&>div]:grid-cols-2 lg:[&>div]:grid-cols-4';

/** A disabled pager button goes quiet (DESIGN-SPEC 6.2) instead of fading. */
const PAGER_DISABLED =
  'disabled:opacity-100 disabled:border-border disabled:bg-transparent disabled:text-ink-4';

export default async function PurchaseOrdersPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; q?: string; page?: string }>;
}) {
  const moduleAccess = await checkModuleAccess('purchase_orders');
  if (!moduleAccess.enabled) {
    return <ModuleUnavailable moduleId="purchase_orders" access={moduleAccess} />;
  }

  const params = await searchParams;
  const tab: PoTab = isPoTab(params.status) ? params.status : 'all';
  const q = (params.q ?? '').trim();
  const page = Math.max(1, Number(params.page) || 1);

  // The heading follows a Settings > Navigation rename of this page's sidebar
  // entry, as the sidebar and the crumb do (PLAN rule 10). Both reads are
  // request-cached lookups the dashboard layout already made, so nothing new
  // is read; a failed lookup keeps the page's own words instead of failing
  // the page.
  const [orgCtx, heading] = await Promise.all([
    requireOrgContext(),
    effectiveNavLabel('/dashboard/purchase-orders', 'Purchase orders').catch(
      () => 'Purchase orders',
    ),
  ]);

  // The Placed column prints a day, and whose day it is matters: in the
  // server's zone (UTC on Vercel) an evening order in California lands on the
  // next date, a morning one in Sydney on the day before. So the
  // organization's zone, from the request-cached org row the layout reads
  // (normally already in hand from the membership bundle), in both tables
  // (small fixes slice 8). Started before the list reads; an unreadable row
  // is the documented default zone, reported, never an error page
  // (getOrgRowForRequest throws on a read error).
  const timeZoneRead = getOrgRowForRequest(orgCtx.organizationId)
    .then((org) => resolveOrgTimezone(org?.timezone))
    .catch((e: unknown) => {
      void reportError(e, { tag: 'purchase_orders.list.org_timezone_failed', level: 'warning' });
      return resolveOrgTimezone(null);
    });

  // Approval-threshold panel (owner/admin only). Read fails SOFT to "panel
  // shows 0" — the enforcement read in the service is the fail-closed one.
  const isAdmin = orgCtx.role === 'owner' || orgCtx.role === 'admin';
  let approvalThreshold = 0;
  if (isAdmin) {
    const supabase = await createClient();
    const { data: moduleRow } = await supabase
      .from('organization_modules')
      .select('settings')
      .eq('organization_id', orgCtx.organizationId)
      .eq('module_id', 'purchase_orders')
      .maybeSingle();
    const raw = Number(
      ((moduleRow as { settings?: Record<string, unknown> } | null)?.settings ?? {})
        .approvalThresholdAmount,
    );
    approvalThreshold = Number.isFinite(raw) && raw > 0 ? raw : 0;
  }

  // Fail CLOSED: a read error must NEVER crash the whole page (recurring bug
  // pattern #1 — a thrown RSC read trips the dashboard error boundary). Degrade
  // to an inline retry banner so the header + tabs still work.
  //
  // The stats (header + cards) come from ONE aggregate RPC over the FULL
  // warehouse-scoped list (tab/search never change them — parity with the
  // old JS roll-up), and the table is ONE server-side page of the filtered
  // set (purchase_orders_stats / purchase_orders_page, migration 0227) —
  // the org's whole PO table never crosses the wire again.
  let stats: PoListStats = {
    totalCount: 0,
    totalValue: 0,
    openCount: 0,
    committedValue: 0,
    openSupplierCount: 0,
    inboundCount: 0,
    nextEtaPoNumber: null,
    nextEtaExpectedAt: null,
    avgLeadDays: null,
  };
  let visible: PoPageRow[] = [];
  let totalFiltered = 0;
  let supplierMap = new Map<string, string>();
  let loadFailed = false;
  // The Overdue view (?status=overdue, where the dashboard's overdue line
  // links): every overdue purchase order, and the organization's day the
  // rule was applied on ("YYYY-MM-DD").
  let overdueTotal = 0;
  let overdueAsOf: string | null = null;
  let activeWarehouse: string | null = null;
  // Instant mode: when the org's whole PO set is small, load the active tab in
  // full and filter client-side (zero-latency, like Items/Books). Above the cap
  // we stay on the scale-safe server pagination + search (mig 0227).
  let instant = false;
  try {
    const [poSvc, supplierSvc, warehouseFilter] = await Promise.all([
      PurchaseOrdersService.forCurrentUser(),
      SuppliersService.forCurrentUser(),
      getActiveWarehouseFilter(),
    ]);
    activeWarehouse = warehouseFilter ?? null;
    // Stats + suppliers first — stats.totalCount decides instant vs server.
    const [rawStats, suppliers] = await Promise.all([
      poSvc.listStats({ warehouseId: warehouseFilter ?? undefined }),
      supplierSvc.listForLookups(),
    ]);
    stats = rawStats;
    instant = rawStats.totalCount <= PO_INSTANT_CAP;
    supplierMap = new Map(suppliers.map((s) => [s.id as string, s.name as string]));
    if (tab === 'overdue') {
      // Overdue (small fixes slice 8): exactly the purchase orders the
      // dashboard's overdue line counts, for the same warehouse
      // (PurchaseOrdersService.listOverdue uses the count's own filter:
      // receivable, and the organization's date after the expected day).
      // Read whole; the instant list searches them in the browser, and the
      // server-paged list (above 800) searches and pages them here, with the
      // rule the other views search by (lib/purchase-orders/list-search.ts).
      const overdue = await poSvc.listOverdue({ warehouseId: warehouseFilter ?? undefined });
      overdueTotal = overdue.rows.length;
      overdueAsOf = overdue.asOfDay;
      if (instant) {
        visible = overdue.rows;
        totalFiltered = overdue.rows.length;
      } else {
        const found = searchedPage(overdue.rows, {
          query: q,
          page,
          perPage: PAGE_SIZE,
          supplierName: (id) => (id ? (supplierMap.get(id) ?? '—') : '—'),
        });
        visible = found.rows;
        totalFiltered = found.total;
      }
    } else {
      const poPage = await poSvc.listPage({
        warehouseId: warehouseFilter ?? undefined,
        // All = all NON-cancelled statuses (owner request 2026-07-16) — a
        // cancelled PO is void/mostly test noise and stays reachable via its
        // own Cancelled tab instead. statusesForTab() always returns an
        // explicit array now (never null), so this applies identically in
        // BOTH the instant (client-filtered) and server-paginated branches
        // below — they both flow through this same listPage() call.
        statuses: statusesForTab(tab),
        // Instant mode filters client-side, so it loads the tab unfiltered.
        q: instant ? '' : q,
        page: instant ? 1 : page,
        perPage: instant ? PO_INSTANT_CAP : PAGE_SIZE,
      });
      visible = poPage.rows;
      totalFiltered = poPage.total;
    }
  } catch (error) {
    console.error('[dashboard/purchase-orders] failed to load POs', {
      tab,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    loadFailed = true;
  }

  // The table is a client component (the instant list searches in the
  // browser, and both lists draw the same table), so the rows cross the wire:
  // only the columns it prints, and only the names of the suppliers these
  // rows name, never the whole lookup list.
  const tableRows: PoInstantRow[] = visible.map((po) => ({
    id: po.id,
    po_number: po.po_number,
    supplier_id: po.supplier_id,
    status: po.status,
    ordered_at: po.ordered_at,
    created_at: po.created_at,
    expected_at: po.expected_at,
    line_count: po.line_count,
    total: po.total,
  }));
  const supplierNames: Record<string, string> = {};
  for (const po of visible) {
    const name = po.supplier_id ? supplierMap.get(po.supplier_id) : undefined;
    if (po.supplier_id && name !== undefined) supplierNames[po.supplier_id] = name;
  }
  const timeZone = await timeZoneRead;

  const avgLead = stats.avgLeadDays != null ? Math.round(stats.avgLeadDays) : null;

  // ── Pagination footer state ──
  const totalPages = Math.max(1, Math.ceil(totalFiltered / PAGE_SIZE));
  const startRow = totalFiltered === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const endRow = Math.min(page * PAGE_SIZE, totalFiltered);
  const pageHref = (p: number) => {
    const sp = new URLSearchParams();
    sp.set('status', tab);
    if (q) sp.set('q', q);
    if (p > 1) sp.set('page', String(p));
    return `/dashboard/purchase-orders?${sp.toString()}`;
  };

  const exportHref =
    `/api/purchase-orders/export.csv?status=${tab}` +
    (q ? `&q=${encodeURIComponent(q)}` : '') +
    (activeWarehouse ? `&warehouse=${encodeURIComponent(activeWarehouse)}` : '');

  // The status tabs and the Overdue view, as the segmented track: links that
  // keep `q`, a navigation landmark named "Filter by status" with
  // aria-current on the tab shown, as the pill links were.
  const statusTabs = (
    <SegmentedTabs
      semantics="nav"
      aria-label="Filter by status"
      activeId={tab}
      // Seven tabs do not fit a phone's width; they wrap to a second line
      // there instead of scrolling the current one out of sight.
      className="max-sm:flex-wrap"
      items={TAB_ORDER.map((t) => ({
        id: t,
        label: TAB_LABELS[t],
        href: `/dashboard/purchase-orders?status=${t}` + (q ? `&q=${encodeURIComponent(q)}` : ''),
      }))}
    />
  );

  // The filter row for every state but the instant table, which draws its own
  // with its search beside the tabs. The server-mode search shows above 800
  // POs, and whenever the list could not load, as before.
  const toolbar = (
    <FilterBar leading={statusTabs} className={TOOLBAR}>
      {!instant ? <PoSearch key={`${tab}:${q}`} status={tab} initialQuery={q} /> : null}
    </FilterBar>
  );

  // Server-side pagination (searchParams-driven, like the inventory page).
  // Hidden on single-page lists — but ALWAYS shown when the URL is past page
  // 1, so the past-end empty state's "jump back with the pagination below"
  // copy always has the controls it points at (a filtered total ≤ PAGE_SIZE
  // used to hide them, stranding the user on a stale ?page= link).
  const showPager = !instant && !loadFailed && (totalFiltered > PAGE_SIZE || page > 1);
  // Under the rows inside the table card (DESIGN-SPEC 6.9 pagination footer),
  // or under the empty panel on a past-end page.
  const pager = (inCard: boolean) => (
    <div
      className={cn(
        'text-muted-foreground flex flex-wrap items-center justify-between gap-x-3 gap-y-2 text-[12.5px]',
        inCard ? 'border-border border-t px-4 py-2.5' : 'px-1',
      )}
    >
      {/* A stale deep link (?page= past the end) has an empty window — skip
          the row range but keep Prev/Next so the user can get back. */}
      <span className="tabular-nums">
        {visible.length > 0 ? (
          <>
            Showing <span className="text-foreground font-medium">{startRow}</span>–
            <span className="text-foreground font-medium">{endRow}</span> of{' '}
            <span className="text-foreground font-medium">{totalFiltered}</span>
          </>
        ) : (
          <>
            <span className="text-foreground font-medium">{totalFiltered}</span> match
            {totalFiltered === 1 ? '' : 'es'} on earlier pages
          </>
        )}
      </span>
      <div className="flex items-center gap-2">
        {page <= 1 ? (
          <Button variant="outline" size="sm" disabled className={PAGER_DISABLED}>
            ← Prev
          </Button>
        ) : (
          <Button asChild variant="outline" size="sm">
            {/* Clamp: from a past-end page, "Prev" jumps straight to the last
                REAL page instead of walking back one empty window at a time. */}
            <Link href={pageHref(Math.min(page - 1, totalPages))} prefetch={false}>
              ← Prev
            </Link>
          </Button>
        )}
        <span className="tabular-nums">
          Page {Math.min(page, totalPages)} of {totalPages}
        </span>
        {page >= totalPages ? (
          <Button variant="outline" size="sm" disabled className={PAGER_DISABLED}>
            Next →
          </Button>
        ) : (
          <Button asChild variant="outline" size="sm">
            <Link href={pageHref(page + 1)} prefetch={false}>
              Next →
            </Link>
          </Button>
        )}
      </div>
    </div>
  );

  // The Overdue view says what it lists, and how many, in the words of the
  // rule the dashboard counts by (#338), under the filter row.
  const overdueLine =
    tab === 'overdue' && !loadFailed && overdueAsOf && overdueTotal > 0 ? (
      <p className="text-muted-foreground text-[13px] leading-5">
        {overdueTotal === 1
          ? '1 purchase order is overdue'
          : `${overdueTotal} purchase orders are overdue`}
        : ordered or in transit and not fully received, with an expected date before today,{' '}
        {formatCalendarDate(`${overdueAsOf}T00:00:00.000Z`)}, in your organization&apos;s time zone.
      </p>
    ) : null;

  let list: React.ReactNode;
  if (loadFailed) {
    list = (
      <>
        {toolbar}
        <StatePanel
          kind="failed"
          title={<>We couldn&apos;t load purchase orders</>}
          description="Something went wrong loading this list. This is usually temporary — try again in a moment."
          action={
            <Button asChild variant="outline">
              <Link href="/dashboard/purchase-orders">Try again</Link>
            </Button>
          }
        />
      </>
    );
  } else if (stats.totalCount === 0) {
    list = (
      <>
        {toolbar}
        <StatePanel
          kind="empty"
          icon={ClipboardList}
          title="No purchase orders yet"
          description="Draft a PO with line items, send it to a supplier, then receive against it to bump stock automatically."
          action={
            <Button asChild variant="gradient">
              <Link href="/dashboard/purchase-orders/new">Create your first PO</Link>
            </Button>
          }
        />
      </>
    );
  } else if (tab === 'overdue' && overdueTotal === 0) {
    list = (
      <>
        {toolbar}
        <StatePanel
          kind="empty"
          icon={ClipboardList}
          title="Nothing overdue"
          description="No purchase order that is ordered or in transit has an expected date before today in your organization's time zone."
        />
      </>
    );
  } else if (instant) {
    list =
      visible.length === 0 ? (
        <>
          {toolbar}
          <StatePanel
            kind="empty"
            icon={ClipboardList}
            title={`Nothing in ${TAB_LABELS[tab].toLowerCase()}`}
            description="Switch tabs above to see purchase orders in other stages."
          />
        </>
      ) : (
        <PoInstantTable
          rows={tableRows}
          supplierNames={supplierNames}
          timeZone={timeZone}
          leading={statusTabs}
          caption={overdueLine}
        />
      );
  } else if (visible.length === 0) {
    const noMatch = totalFiltered === 0 && q !== '';
    list = (
      <>
        {toolbar}
        {overdueLine}
        <StatePanel
          kind={noMatch ? 'no-match' : 'empty'}
          icon={noMatch ? SearchX : ClipboardList}
          title={
            totalFiltered > 0
              ? 'Nothing on this page'
              : q
                ? `No POs match “${q}”`
                : `Nothing in ${TAB_LABELS[tab].toLowerCase()}`
          }
          description={
            totalFiltered > 0
              ? 'This page is past the end of the list — jump back with the pagination below.'
              : q
                ? 'Try a different PO number or supplier, or clear the search.'
                : 'Switch tabs above to see purchase orders in other stages.'
          }
        />
        {showPager ? pager(false) : null}
      </>
    );
  } else {
    list = (
      <>
        {toolbar}
        {overdueLine}
        <PoListTable
          rows={tableRows}
          supplierNames={supplierNames}
          timeZone={timeZone}
          footer={showPager ? pager(true) : undefined}
        />
      </>
    );
  }

  return (
    <div className={PAGE}>
      <PageHeader
        eyebrow="Purchasing"
        title={heading}
        subline={
          <span className="tabular-nums">
            {stats.totalCount} {stats.totalCount === 1 ? 'PO' : 'POs'} ·{' '}
            <SublineValue>{formatCurrency(stats.totalValue)}</SublineValue> total value
          </span>
        }
        actions={
          <Button asChild variant="outline">
            <a href={exportHref} download aria-label="Export purchase orders to CSV">
              <Download className="h-4 w-4" />
              Export
            </a>
          </Button>
        }
        primaryAction={
          <Button asChild variant="gradient">
            <Link href="/dashboard/purchase-orders/new">+ New PO</Link>
          </Button>
        }
      />

      <StatStrip className={STATS}>
        <StatStripItem
          label="Open POs"
          value={stats.openCount}
          sub={`across ${stats.openSupplierCount} ${stats.openSupplierCount === 1 ? 'supplier' : 'suppliers'}`}
        />
        <StatStripItem
          label="Committed value"
          value={formatCurrency(stats.committedValue)}
          sub="USD"
        />
        <StatStripItem
          label="On the water"
          value={stats.inboundCount}
          sub={
            stats.nextEtaPoNumber
              ? `${stats.nextEtaPoNumber} · ETA ${formatCalendarDate(stats.nextEtaExpectedAt)}`
              : stats.inboundCount > 0
                ? 'No ETA scheduled'
                : 'Nothing inbound'
          }
        />
        <StatStripItem
          label="Avg lead time"
          value={avgLead != null ? `${avgLead} d` : '—'}
          sub="rolling 90-day"
        />
      </StatStrip>

      {list}

      {isAdmin && <PoApprovalPanel initialAmount={approvalThreshold} />}
    </div>
  );
}
