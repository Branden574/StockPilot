import { Undo2 } from 'lucide-react';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { ModuleNotEnabled } from '@/components/dashboard/module-not-enabled';
import {
  ReturnStatusBadge,
  returnReasonLabel,
} from '@/components/returns/return-status-badge';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { requireOrgContext } from '@/lib/auth/session';
import { checkModuleAccess } from '@/lib/modules/module-gate';
import { formatRelative } from '@/lib/utils';
import { RMAService, type ReturnStatus } from '@/server/services/returns';

import { hasPermission } from '@stockpilot/core';

const STATUS_FILTERS: Array<{ value: ReturnStatus | 'all'; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'requested', label: 'Requested' },
  { value: 'approved', label: 'Approved' },
  { value: 'received', label: 'Received' },
  { value: 'closed', label: 'Closed' },
  { value: 'denied', label: 'Denied' },
  { value: 'cancelled', label: 'Cancelled' },
];

const ALL_STATUSES = new Set<ReturnStatus>([
  'requested',
  'approved',
  'received',
  'closed',
  'denied',
  'cancelled',
]);

export default async function ReturnsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const moduleAccess = await checkModuleAccess('returns');
  if (!moduleAccess.enabled) {
    return <ModuleNotEnabled moduleId="returns" canManage={moduleAccess.canManage} />;
  }
  // Returns move inventory (restock/scrap) on close — gated on returns:manage
  // (manager+). The service enforces the same gate; this is the page-level
  // bounce so a viewer never sees the list shell.
  const ctx = await requireOrgContext();
  if (!hasPermission(ctx.role, 'returns:manage')) {
    redirect('/dashboard');
  }

  const { status: statusParam } = await searchParams;
  const activeStatus =
    statusParam && ALL_STATUSES.has(statusParam as ReturnStatus)
      ? (statusParam as ReturnStatus)
      : 'all';

  const svc = await RMAService.forCurrentUser();
  const returns = await svc.list(
    activeStatus === 'all' ? {} : { status: activeStatus },
  );

  return (
    <div className="container mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-3 sm:gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Returns</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Manage RMAs against completed orders. Approving and receiving a
            return moves stock back in (restock) or writes it off (scrap) when
            the return is closed.
          </p>
        </div>
      </div>

      <div className="mt-6 flex flex-wrap gap-2">
        {STATUS_FILTERS.map((f) => {
          const isActive = activeStatus === f.value;
          const href =
            f.value === 'all' ? '/dashboard/returns' : `/dashboard/returns?status=${f.value}`;
          return (
            <Link
              key={f.value}
              href={href}
              className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                isActive
                  ? 'border-foreground bg-foreground text-background'
                  : 'border-border text-muted-foreground hover:text-foreground'
              }`}
            >
              {f.label}
            </Link>
          );
        })}
      </div>

      <div className="mt-6">
        {returns.length === 0 ? (
          <EmptyState
            icon={Undo2}
            title="No returns yet"
            description="Open a completed order and start a return to restock or scrap fulfilled lines. Returns you create will show up here."
          />
        ) : (
          <div className="bg-card overflow-x-auto rounded-xl border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Return #</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Order</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead className="text-right">Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {returns.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell>
                      <Link
                        href={`/dashboard/returns/${r.id}`}
                        className="font-mono text-xs font-medium hover:underline"
                      >
                        {r.return_number ?? r.id.slice(0, 8)}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <ReturnStatusBadge status={r.status} />
                    </TableCell>
                    <TableCell>
                      <Link
                        href={`/dashboard/orders/${r.order_request_id}`}
                        className="text-muted-foreground text-xs hover:underline"
                      >
                        {r.order_request_id.slice(0, 8)}
                      </Link>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {returnReasonLabel(r.reason_code)}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="capitalize">
                        {r.source}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-right text-xs">
                      {formatRelative(r.created_at)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </div>
  );
}
