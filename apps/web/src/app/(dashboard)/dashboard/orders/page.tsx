import type { Metadata } from 'next';
import { Package, ShoppingCart, Truck } from 'lucide-react';
import Link from 'next/link';
import { formatOrderNumber } from '@stockpilot/core';

export const metadata: Metadata = { title: 'Orders' };

import { checkModuleAccess } from '@/lib/modules/module-gate';
import { ModuleNotEnabled } from '@/components/dashboard/module-not-enabled';
import { EmptyState } from '@/components/ui/empty-state';
import { OrderStatusBadge } from '@/components/orders/status-badge';
import { OrdersExportMenu } from '@/components/orders/orders-export-menu';
import { summaryRequesterLabel } from '@/components/orders/requester-label';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { can } from '@stockpilot/core';
import { requireOrgContext } from '@/lib/auth/session';
import {
  OrderRequestsService,
  type OrderRequestSummary,
} from '@/server/services/order-requests';
import { formatNumber, formatRelative } from '@/lib/utils';
import { PageTour } from '@/components/onboarding/page-tour';
import { ORDERS_TOUR } from '@/lib/onboarding/tours';
import {
  ORDER_EXPORT_STATUS_TABS as TAB_FILTERS,
  ORDER_EXPORT_TAB_LABELS as TAB_LABELS,
  isOrderStatusTab,
  type OrderStatusTab as StatusTab,
} from '@/lib/orders/export';

const PAGE_SIZE = 50;

const TAB_ORDER: StatusTab[] = [
  'all_active',
  'needs_approval',
  'picking',
  'packing',
  'staged',
  'in_transit',
  'backordered',
  'completed',
  'denied_cancelled',
];

// Vocabulary lives in lib/orders/export.ts (single source for the page tabs
// and BOTH export formats); TAB_ORDER stays here — it is UI presentation
// order, not vocabulary.

export default async function OrdersPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; page?: string }>;
}) {
  const moduleAccess = await checkModuleAccess('orders');
  if (!moduleAccess.enabled) {
    return <ModuleNotEnabled moduleId="orders" canManage={moduleAccess.canManage} />;
  }
  const params = await searchParams;
  const ctx = await requireOrgContext();
  const canApprove = can(ctx, 'orders:approve');

  const tab: StatusTab = isOrderStatusTab(params.status) ? params.status : 'needs_approval';
  const page = clampPage(params.page);
  const offset = (page - 1) * PAGE_SIZE;

  let rows: OrderRequestSummary[] = [];
  let loadFailed = false;
  try {
    const svc = await OrderRequestsService.forCurrentUser();
    if (canApprove) {
      rows = await svc.list({
        status: TAB_FILTERS[tab],
        limit: PAGE_SIZE + 1,
        offset,
      });
    } else {
      rows = await svc.myRequests();
    }
  } catch (error) {
    // Fail CLOSED: a read error must NEVER crash the whole orders page
    // (recurring bug pattern #1 — a thrown RSC read trips the dashboard
    // error boundary). Log the real error server-side (visible in Vercel
    // runtime logs, keyed near the digest) and degrade to an inline retry
    // banner so the rest of the page (tabs, export, "Place order") still works.
    console.error('[dashboard/orders] failed to load orders', {
      tab,
      page,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    loadFailed = true;
  }

  const hasNext = canApprove && rows.length > PAGE_SIZE;
  const visible = hasNext ? rows.slice(0, PAGE_SIZE) : rows;

  return (
    <div className="container mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-3 sm:gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {canApprove ? 'Order requests' : 'My requests'}
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            {canApprove
              ? 'Review incoming requests and move them through approval, packaging, and delivery.'
              : 'Track the orders you have placed.'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <PageTour tour={ORDERS_TOUR} />
          {/* Export the org-wide order history (CSV or PDF). Gated on
              orders:approve (manager+) — the same permission that lets this
              page show every org order; requesters without it only see
              their own requests and have nothing org-wide to export. Both
              links carry the active status tab so the file matches what's
              on screen. */}
          {canApprove && <OrdersExportMenu tab={tab} />}
          <Button asChild variant="gradient">
            <Link href="/dashboard/orders/new">+ Place order</Link>
          </Button>
        </div>
      </div>

      {canApprove && (
        <nav
          className="mt-6 flex flex-wrap gap-1 border-b border-border"
          aria-label="Status"
        >
          {TAB_ORDER.map((t) => {
            const isActive = t === tab;
            return (
              <Link
                key={t}
                href={`/dashboard/orders?status=${t}`}
                className={
                  'border-b-2 px-3 py-2 text-sm transition-colors ' +
                  (isActive
                    ? 'border-primary text-foreground font-medium'
                    : 'border-transparent text-muted-foreground hover:text-foreground')
                }
              >
                {TAB_LABELS[t]}
              </Link>
            );
          })}
        </nav>
      )}

      <div className="mt-6">
        {loadFailed ? (
          <div className="bg-card border-destructive/40 rounded-xl border p-6 text-center">
            <h2 className="text-destructive text-sm font-medium">We couldn&apos;t load orders</h2>
            <p className="text-muted-foreground mx-auto mt-1 max-w-md text-sm">
              Something went wrong loading this list. This is usually temporary — try again in a
              moment, and switch tabs above to view other stages.
            </p>
            <Button asChild variant="outline" className="mt-4">
              <Link href={`/dashboard/orders?status=${tab}`}>Try again</Link>
            </Button>
          </div>
        ) : visible.length === 0 ? (
          canApprove ? (
            <EmptyState
              icon={ShoppingCart}
              title={`Nothing in ${TAB_LABELS[tab].toLowerCase()}`}
              description="No requests are sitting in this stage. Switch tabs above to see other stages of the queue."
            />
          ) : (
            <EmptyState
              icon={ShoppingCart}
              title="No requests yet"
              description="Place your first order request and we'll route it to the right approver."
              cta={{ label: 'Place an order', href: '/dashboard/orders/new' }}
            />
          )
        ) : (
          <div className="bg-card overflow-x-auto rounded-xl border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-16">Order #</TableHead>
                  <TableHead>Requester</TableHead>
                  <TableHead>Warehouse</TableHead>
                  <TableHead className="text-right">Lines</TableHead>
                  <TableHead className="text-right">Total qty</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Picker</TableHead>
                  <TableHead>Driver</TableHead>
                  <TableHead>Requested</TableHead>
                  <TableHead className="text-right">Last update</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell>
                      <Link
                        href={`/dashboard/orders/${r.id}`}
                        className="font-mono text-sm font-medium tabular-nums hover:underline"
                      >
                        {formatOrderNumber(r.orderNumber) ?? '—'}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Link
                        href={`/dashboard/orders/${r.id}`}
                        className="text-sm font-medium hover:underline"
                      >
                        {summaryRequesterLabel(r)}
                      </Link>
                      {r.source === 'public_link' && (
                        <Badge variant="outline" className="ml-2 align-middle">
                          Public
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {r.warehouseName ?? '—'}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-sm">
                      {formatNumber(r.lineCount)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-sm">
                      {formatNumber(r.totalQuantity)}
                    </TableCell>
                    <TableCell>
                      <OrderStatusBadge status={r.status} />
                    </TableCell>
                    <TableCell className="text-xs">
                      <span className="border-border bg-muted/40 inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px]">
                        {r.fulfillmentType === 'pickup' ? (
                          <>
                            <Package className="h-3 w-3" />
                            Pickup
                          </>
                        ) : (
                          <>
                            <Truck className="h-3 w-3" />
                            Delivery
                          </>
                        )}
                      </span>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {r.assignedPickerName ?? '—'}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {r.fulfillmentType === 'delivery'
                        ? (r.assignedDeliveryUserName ?? '—')
                        : '—'}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {formatRelative(r.createdAt)}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-right text-xs">
                      {formatRelative(r.updatedAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      {canApprove && (
        <div className="mt-4 flex items-center justify-between">
          <Button asChild variant="outline" disabled={page <= 1}>
            <Link
              href={page <= 1 ? '#' : `/dashboard/orders?status=${tab}&page=${page - 1}`}
              aria-disabled={page <= 1}
              className={page <= 1 ? 'pointer-events-none opacity-50' : ''}
            >
              ← Newer
            </Link>
          </Button>
          <p className="text-muted-foreground text-xs tabular-nums">Page {page}</p>
          <Button asChild variant="outline" disabled={!hasNext}>
            <Link
              href={hasNext ? `/dashboard/orders?status=${tab}&page=${page + 1}` : '#'}
              aria-disabled={!hasNext}
              className={!hasNext ? 'pointer-events-none opacity-50' : ''}
            >
              Older →
            </Link>
          </Button>
        </div>
      )}
    </div>
  );
}

function clampPage(raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.min(Math.max(Math.floor(n), 1), 10_000);
}
