import {
  ChevronRight,
  ClipboardList,
  Clock,
  DollarSign,
  Download,
  Truck,
} from 'lucide-react';
import Link from 'next/link';

import { checkModuleAccess } from '@/lib/modules/module-gate';
import { requireOrgContext } from '@/lib/auth/session';
import { createClient } from '@/lib/supabase/server';
import { ModuleNotEnabled } from '@/components/dashboard/module-not-enabled';
import { PoApprovalPanel } from '@/components/settings/po-approval-panel';
import { StatCard } from '@/components/dashboard/stat-card';
import { EmptyState } from '@/components/ui/empty-state';
import { PoStatusBadge } from '@/components/po/po-status-badge';
import { Button } from '@/components/ui/button';
import { PoInstantTable, type PoInstantRow } from '@/components/po/po-instant-table';
import { PoSearch } from '@/components/po/po-search';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  PurchaseOrdersService,
  type PoListStats,
  type PoPageRow,
} from '@/server/services/purchase-orders';
import { SuppliersService } from '@/server/services/suppliers';
import { getActiveWarehouseFilter } from '@/lib/warehouse-filter';
import { formatCurrency, formatDateShort } from '@/lib/utils';
import {
  isPoTab,
  statusesForTab,
  TAB_LABELS,
  TAB_ORDER,
  type PoTab,
} from '@/lib/purchase-orders/tabs';

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

export default async function PurchaseOrdersPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; q?: string; page?: string }>;
}) {
  const moduleAccess = await checkModuleAccess('purchase_orders');
  if (!moduleAccess.enabled) {
    return <ModuleNotEnabled moduleId="purchase_orders" canManage={moduleAccess.canManage} />;
  }

  const params = await searchParams;
  const tab: PoTab = isPoTab(params.status) ? params.status : 'all';
  const q = (params.q ?? '').trim();
  const page = Math.max(1, Number(params.page) || 1);

  // Approval-threshold panel (owner/admin only). Read fails SOFT to "panel
  // shows 0" — the enforcement read in the service is the fail-closed one.
  const orgCtx = await requireOrgContext();
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
      supplierSvc.list(),
    ]);
    stats = rawStats;
    instant = rawStats.totalCount <= PO_INSTANT_CAP;
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
    supplierMap = new Map(suppliers.map((s) => [s.id as string, s.name as string]));
  } catch (error) {
    console.error('[dashboard/purchase-orders] failed to load POs', {
      tab,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    loadFailed = true;
  }

  const supplierName = (id: string | null) => (id ? (supplierMap.get(id) ?? '—') : '—');

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

  return (
    <div className="container mx-auto max-w-6xl px-4 py-8 sm:px-6">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-3 sm:gap-4">
        <div>
          <p className="font-mono text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
            Inventory
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">Purchase orders</h1>
          <p className="text-muted-foreground mt-1 text-sm tabular-nums">
            {stats.totalCount} {stats.totalCount === 1 ? 'PO' : 'POs'} ·{' '}
            {formatCurrency(stats.totalValue)} total value
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button asChild variant="outline">
            <a href={exportHref} download aria-label="Export purchase orders to CSV">
              <Download className="mr-1.5 h-4 w-4" />
              Export
            </a>
          </Button>
          <Button asChild variant="gradient">
            <Link href="/dashboard/purchase-orders/new">+ New PO</Link>
          </Button>
        </div>
      </div>

      {/* Stat cards */}
      <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Open POs"
          value={stats.openCount}
          foot={`across ${stats.openSupplierCount} ${stats.openSupplierCount === 1 ? 'supplier' : 'suppliers'}`}
          icon={ClipboardList}
        />
        <StatCard
          label="Committed value"
          value={formatCurrency(stats.committedValue)}
          foot="USD"
          icon={DollarSign}
        />
        <StatCard
          label="On the water"
          value={stats.inboundCount}
          foot={
            stats.nextEtaPoNumber
              ? `${stats.nextEtaPoNumber} · ETA ${formatDateShort(stats.nextEtaExpectedAt)}`
              : stats.inboundCount > 0
                ? 'No ETA scheduled'
                : 'Nothing inbound'
          }
          icon={Truck}
        />
        <StatCard
          label="Avg lead time"
          value={avgLead != null ? `${avgLead} d` : '—'}
          foot="rolling 90-day"
          icon={Clock}
        />
      </div>

      {/* Filter tabs + search */}
      <div className="mt-8 flex flex-wrap items-center justify-between gap-3">
        <nav className="flex flex-wrap gap-1" aria-label="Filter by status">
          {TAB_ORDER.map((t) => {
            const isActive = t === tab;
            const href =
              `/dashboard/purchase-orders?status=${t}` + (q ? `&q=${encodeURIComponent(q)}` : '');
            return (
              <Link
                key={t}
                href={href}
                aria-current={isActive ? 'page' : undefined}
                className={
                  'rounded-full px-3 py-1 text-sm transition-colors ' +
                  (isActive
                    ? 'bg-foreground text-background font-medium'
                    : 'text-muted-foreground hover:bg-muted')
                }
              >
                {TAB_LABELS[t]}
              </Link>
            );
          })}
        </nav>

        {!instant && <PoSearch key={`${tab}:${q}`} status={tab} initialQuery={q} />}
      </div>

      {/* Table */}
      <div className="mt-4">
        {loadFailed ? (
          <div className="bg-card border-destructive/40 rounded-xl border p-6 text-center">
            <h2 className="text-destructive text-sm font-medium">We couldn&apos;t load purchase orders</h2>
            <p className="text-muted-foreground mx-auto mt-1 max-w-md text-sm">
              Something went wrong loading this list. This is usually temporary — try again in a moment.
            </p>
            <Button asChild variant="outline" className="mt-4">
              <Link href="/dashboard/purchase-orders">Try again</Link>
            </Button>
          </div>
        ) : stats.totalCount === 0 ? (
          <EmptyState
            icon={ClipboardList}
            title="No purchase orders yet"
            description="Draft a PO with line items, send it to a supplier, then receive against it to bump stock automatically."
            cta={{ label: 'Create your first PO', href: '/dashboard/purchase-orders/new' }}
          />
        ) : instant ? (
          visible.length === 0 ? (
            <EmptyState
              icon={ClipboardList}
              title={`Nothing in ${TAB_LABELS[tab].toLowerCase()}`}
              description="Switch tabs above to see purchase orders in other stages."
            />
          ) : (
            <PoInstantTable
              rows={visible as PoInstantRow[]}
              supplierNames={Object.fromEntries(supplierMap)}
            />
          )
        ) : visible.length === 0 ? (
          <EmptyState
            icon={ClipboardList}
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
        ) : (
          <div className="bg-card overflow-x-auto rounded-xl border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>PO #</TableHead>
                  <TableHead>Supplier</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Placed</TableHead>
                  <TableHead>Expected</TableHead>
                  <TableHead className="text-right">Lines</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead className="w-8" aria-label="Open" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((po) => {
                  // "Placed" = when the PO was sent to the supplier. Drafts
                  // haven't been placed yet; imports lack ordered_at so fall
                  // back to created_at.
                  const placed = po.status === 'draft' ? null : (po.ordered_at ?? po.created_at);
                  return (
                    <TableRow key={po.id} className="group">
                      <TableCell>
                        <Link
                          href={`/dashboard/purchase-orders/${po.id}`}
                          className="font-mono text-sm font-medium hover:underline"
                        >
                          {po.po_number}
                        </Link>
                      </TableCell>
                      <TableCell className="text-muted-foreground text-sm">
                        {supplierName(po.supplier_id)}
                      </TableCell>
                      <TableCell>
                        <PoStatusBadge status={po.status} />
                      </TableCell>
                      <TableCell className="text-muted-foreground text-sm tabular-nums">
                        {formatDateShort(placed)}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-sm tabular-nums">
                        {formatDateShort(po.expected_at)}
                      </TableCell>
                      <TableCell className="text-right text-sm tabular-nums">
                        {po.line_count}
                      </TableCell>
                      <TableCell className="text-right text-sm font-medium tabular-nums">
                        {formatCurrency(Number(po.total ?? 0))}
                      </TableCell>
                      <TableCell className="text-muted-foreground w-8 text-right">
                        <Link
                          href={`/dashboard/purchase-orders/${po.id}`}
                          aria-label={`Open ${po.po_number}`}
                        >
                          <ChevronRight className="h-4 w-4 shrink-0 transition-transform group-hover:translate-x-0.5" />
                        </Link>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}

        {/* Server-side pagination (searchParams-driven, like the inventory
            page). Hidden on single-page lists for zero visual change — but
            ALWAYS shown when the URL is past page 1, so the past-end empty
            state's "jump back with the pagination below" copy always has the
            controls it points at (a filtered total ≤ PAGE_SIZE used to hide
            them, stranding the user on a stale ?page= link). */}
        {!instant && !loadFailed && (totalFiltered > PAGE_SIZE || page > 1) && (
          <div className="text-muted-foreground mt-3 flex items-center justify-between gap-3 text-[12px]">
            {/* A stale deep link (?page= past the end) has an empty window —
                skip the row range but keep Prev/Next so the user can get back. */}
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
                <Button variant="outline" size="sm" disabled>
                  ← Prev
                </Button>
              ) : (
                <Button asChild variant="outline" size="sm">
                  {/* Clamp: from a past-end page, "Prev" jumps straight to
                      the last REAL page instead of walking back one empty
                      window at a time. */}
                  <Link href={pageHref(Math.min(page - 1, totalPages))} prefetch={false}>
                    ← Prev
                  </Link>
                </Button>
              )}
              <span className="tabular-nums">
                Page {Math.min(page, totalPages)} of {totalPages}
              </span>
              {page >= totalPages ? (
                <Button variant="outline" size="sm" disabled>
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
        )}
      </div>

      {isAdmin && (
        <div className="mt-6">
          <PoApprovalPanel initialAmount={approvalThreshold} />
        </div>
      )}
    </div>
  );
}
