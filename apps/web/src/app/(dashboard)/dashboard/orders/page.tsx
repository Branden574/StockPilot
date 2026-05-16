import { ShoppingCart } from 'lucide-react';
import Link from 'next/link';

import { EmptyState } from '@/components/ui/empty-state';
import { OrderStatusBadge, summaryRequesterLabel } from '@/components/orders/status-badge';
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
import { hasPermission } from '@stockpilot/core';
import { requireOrgContext } from '@/lib/auth/session';
import {
  OrderRequestsService,
  type OrderRequestStatus,
  type OrderRequestSummary,
} from '@/server/services/order-requests';
import { formatNumber, formatRelative } from '@/lib/utils';

const PAGE_SIZE = 50;

type StatusTab =
  | 'all_active'
  | 'needs_approval'
  | 'picking'
  | 'packing'
  | 'staged'
  | 'in_transit'
  | 'completed'
  | 'denied_cancelled';

const TAB_LABELS: Record<StatusTab, string> = {
  all_active: 'All active',
  needs_approval: 'Needs approval',
  picking: 'Picking',
  packing: 'Packing',
  staged: 'Staged',
  in_transit: 'In transit',
  completed: 'Completed',
  denied_cancelled: 'Denied/Cancelled',
};

const TAB_FILTERS: Record<StatusTab, OrderRequestStatus | OrderRequestStatus[]> = {
  all_active: [
    'pending_approval',
    'approved',
    'pick_slip_generated',
    'picking_in_progress',
    'picking_complete',
    'packing_slip_generated',
    'staged_for_pickup',
    'staged_for_delivery',
    'in_transit',
    'signature_requested',
  ],
  needs_approval: 'pending_approval',
  picking: ['pick_slip_generated', 'picking_in_progress', 'picking_complete'],
  packing: 'packing_slip_generated',
  staged: ['staged_for_pickup', 'staged_for_delivery'],
  in_transit: ['in_transit', 'signature_requested'],
  completed: 'completed',
  denied_cancelled: ['denied', 'cancelled'],
};

const TAB_ORDER: StatusTab[] = [
  'all_active',
  'needs_approval',
  'picking',
  'packing',
  'staged',
  'in_transit',
  'completed',
  'denied_cancelled',
];

function isStatusTab(value: string | undefined): value is StatusTab {
  return TAB_ORDER.includes(value as StatusTab);
}

export default async function OrdersPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; page?: string }>;
}) {
  const params = await searchParams;
  const ctx = await requireOrgContext();
  const canApprove = hasPermission(ctx.role, 'orders:approve');

  const tab: StatusTab = isStatusTab(params.status) ? params.status : 'needs_approval';
  const page = clampPage(params.page);
  const offset = (page - 1) * PAGE_SIZE;

  const svc = await OrderRequestsService.forCurrentUser();

  let rows: OrderRequestSummary[] = [];
  if (canApprove) {
    rows = await svc.list({
      status: TAB_FILTERS[tab],
      limit: PAGE_SIZE + 1,
      offset,
    });
  } else {
    rows = await svc.myRequests();
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
        <Button asChild variant="gradient">
          <Link href="/dashboard/orders/new">+ Place order</Link>
        </Button>
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
        {visible.length === 0 ? (
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
                  <TableHead>Requester</TableHead>
                  <TableHead>Warehouse</TableHead>
                  <TableHead className="text-right">Lines</TableHead>
                  <TableHead className="text-right">Total qty</TableHead>
                  <TableHead>Status</TableHead>
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
