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
import { ModuleNotEnabled } from '@/components/dashboard/module-not-enabled';
import { StatCard } from '@/components/dashboard/stat-card';
import { EmptyState } from '@/components/ui/empty-state';
import { PoStatusBadge } from '@/components/po/po-status-badge';
import { Button } from '@/components/ui/button';
import { PoSearch } from '@/components/po/po-search';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { PurchaseOrdersService } from '@/server/services/purchase-orders';
import { SuppliersService } from '@/server/services/suppliers';
import { getActiveWarehouseFilter } from '@/lib/warehouse-filter';
import { formatCurrency, formatDateShort } from '@/lib/utils';

export const metadata = { title: 'Purchase orders' };

// ── Status grouping ────────────────────────────────────────────────────────
// The DB has 6 statuses; we partition them into mutually-exclusive filter tabs
// (every status lands in exactly one tab) so the pills echo the design mockup
// while staying faithful to the real data model.
type PoTab = 'all' | 'draft' | 'ordered' | 'in_transit' | 'received' | 'cancelled';

const TAB_ORDER: PoTab[] = ['all', 'draft', 'ordered', 'in_transit', 'received', 'cancelled'];

const TAB_LABELS: Record<PoTab, string> = {
  all: 'All',
  draft: 'Draft',
  ordered: 'Ordered',
  in_transit: 'In transit',
  received: 'Received',
  cancelled: 'Cancelled',
};

const TAB_STATUSES: Record<Exclude<PoTab, 'all'>, string[]> = {
  draft: ['draft'],
  ordered: ['ordered'],
  in_transit: ['expected_inbound', 'partially_received'],
  received: ['received'],
  cancelled: ['cancelled'],
};

// "Open" = committed but not yet fully received and not cancelled.
const OPEN_STATUSES = new Set(['draft', 'expected_inbound', 'ordered', 'partially_received']);
// "On the water" = placed/approved and en route (open minus drafts).
const INBOUND_STATUSES = new Set(['ordered', 'expected_inbound', 'partially_received']);
const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function isPoTab(value: string | undefined): value is PoTab {
  return TAB_ORDER.includes(value as PoTab);
}

type PoRow = {
  id: string;
  po_number: string;
  status: string;
  supplier_id: string | null;
  expected_at: string | null;
  ordered_at: string | null;
  received_at: string | null;
  total: number;
  created_at: string;
  line_count: number;
};

export default async function PurchaseOrdersPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; q?: string }>;
}) {
  const moduleAccess = await checkModuleAccess('purchase_orders');
  if (!moduleAccess.enabled) {
    return <ModuleNotEnabled moduleId="purchase_orders" canManage={moduleAccess.canManage} />;
  }

  const params = await searchParams;
  const tab: PoTab = isPoTab(params.status) ? params.status : 'all';
  const q = (params.q ?? '').trim();

  // Fail CLOSED: a read error must NEVER crash the whole page (recurring bug
  // pattern #1 — a thrown RSC read trips the dashboard error boundary). Degrade
  // to an inline retry banner so the header + tabs still work.
  let pos: PoRow[] = [];
  let supplierMap = new Map<string, string>();
  let loadFailed = false;
  let activeWarehouse: string | null = null;
  try {
    const [poSvc, supplierSvc, warehouseFilter] = await Promise.all([
      PurchaseOrdersService.forCurrentUser(),
      SuppliersService.forCurrentUser(),
      getActiveWarehouseFilter(),
    ]);
    activeWarehouse = warehouseFilter ?? null;
    const [rawPos, suppliers] = await Promise.all([
      poSvc.list({ warehouseId: warehouseFilter ?? undefined }),
      supplierSvc.list(),
    ]);
    pos = rawPos as unknown as PoRow[];
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

  // ── Aggregates (computed from the FULL list so tab/search don't change them) ──
  const totalValueAll = pos.reduce((sum, p) => sum + Number(p.total ?? 0), 0);
  const openPos = pos.filter((p) => OPEN_STATUSES.has(p.status));
  const openCount = openPos.length;
  const committedValue = openPos.reduce((sum, p) => sum + Number(p.total ?? 0), 0);
  const openSupplierCount = new Set(
    openPos.map((p) => p.supplier_id).filter((s): s is string => Boolean(s)),
  ).size;

  const inbound = pos.filter((p) => INBOUND_STATUSES.has(p.status));
  const onWaterCount = inbound.length;
  const nextEta = inbound
    .filter((p) => p.expected_at)
    .sort(
      (a, b) => new Date(a.expected_at as string).getTime() - new Date(b.expected_at as string).getTime(),
    )[0];

  const now = Date.now();
  const leadDays = pos
    .filter(
      (p) =>
        p.status === 'received' &&
        p.received_at &&
        now - new Date(p.received_at).getTime() <= NINETY_DAYS_MS,
    )
    .map((p) => {
      // `ordered_at` is null for imported POs — fall back to `created_at` so the
      // lead-time stat isn't biased toward only manually-placed POs.
      const start = new Date((p.ordered_at ?? p.created_at) as string).getTime();
      const end = new Date(p.received_at as string).getTime();
      return (end - start) / DAY_MS;
    })
    .filter((d) => Number.isFinite(d) && d >= 0);
  const avgLead =
    leadDays.length > 0
      ? Math.round(leadDays.reduce((a, b) => a + b, 0) / leadDays.length)
      : null;

  // ── Table rows (filter by tab + search, in-memory) ──
  const ql = q.toLowerCase();
  const visible = pos.filter((p) => {
    const inTab = tab === 'all' || TAB_STATUSES[tab].includes(p.status);
    if (!inTab) return false;
    if (!ql) return true;
    const name = supplierName(p.supplier_id).toLowerCase();
    return p.po_number.toLowerCase().includes(ql) || name.includes(ql);
  });

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
            {pos.length} {pos.length === 1 ? 'PO' : 'POs'} · {formatCurrency(totalValueAll)} total value
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
          value={openCount}
          foot={`across ${openSupplierCount} ${openSupplierCount === 1 ? 'supplier' : 'suppliers'}`}
          icon={ClipboardList}
        />
        <StatCard
          label="Committed value"
          value={formatCurrency(committedValue)}
          foot="USD"
          icon={DollarSign}
        />
        <StatCard
          label="On the water"
          value={onWaterCount}
          foot={
            nextEta
              ? `${nextEta.po_number} · ETA ${formatDateShort(nextEta.expected_at)}`
              : onWaterCount > 0
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

        <PoSearch key={`${tab}:${q}`} status={tab} initialQuery={q} />
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
        ) : pos.length === 0 ? (
          <EmptyState
            icon={ClipboardList}
            title="No purchase orders yet"
            description="Draft a PO with line items, send it to a supplier, then receive against it to bump stock automatically."
            cta={{ label: 'Create your first PO', href: '/dashboard/purchase-orders/new' }}
          />
        ) : visible.length === 0 ? (
          <EmptyState
            icon={ClipboardList}
            title={q ? `No POs match “${q}”` : `Nothing in ${TAB_LABELS[tab].toLowerCase()}`}
            description={
              q
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
      </div>
    </div>
  );
}
