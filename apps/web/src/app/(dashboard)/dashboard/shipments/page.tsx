import { Send } from 'lucide-react';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { EmptyState } from '@/components/ui/empty-state';
import { ShipmentsDeprecatedBanner } from '@/components/shipments/shipments-deprecated-banner';
import { ShipmentStatusBadge } from '@/components/shipments/shipment-status-badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { requireOrgContext } from '@/lib/auth/session';
import { ShipmentsService } from '@/server/services/shipments';
import { formatRelative } from '@/lib/utils';

import { hasPermission } from '@stockpilot/core';

export default async function ShipmentsPage() {
  // Shipments is a manager+ surface (purchase_orders:manage covers
  // create / mark shipped / mark delivered). Viewers don't get the
  // list view either — bounced to dashboard.
  const ctx = await requireOrgContext();
  const canManage = hasPermission(ctx.role, 'purchase_orders:manage');
  if (!canManage) {
    redirect('/dashboard');
  }
  const svc = await ShipmentsService.forCurrentUser();
  const shipments = await svc.list();

  return (
    <div className="container mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <ShipmentsDeprecatedBanner />
      <div className="mt-6 flex flex-wrap items-end justify-between gap-3 sm:gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Shipments</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Historical outbound packing slips. Read-only — new outbound work
            lives under Orders.
          </p>
        </div>
      </div>

      <div className="mt-8">
        {shipments.length === 0 ? (
          <EmptyState
            icon={Send}
            title="No shipments"
            description="Historical shipments will appear here. New outbound work is tracked under Orders."
            cta={{ label: 'Go to Orders', href: '/dashboard/orders' }}
          />
        ) : (
          <div className="bg-card overflow-x-auto rounded-xl border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>WO #</TableHead>
                  <TableHead>Ship date</TableHead>
                  <TableHead>From</TableHead>
                  <TableHead>To</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Updated</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {shipments.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell>
                      <Link
                        href={`/dashboard/shipments/${s.id}`}
                        className="font-mono text-sm font-medium hover:underline"
                      >
                        {s.workOrderNumber}
                      </Link>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm tabular-nums">
                      {s.shipDate}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {s.sourceWarehouseName ?? '—'}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {s.destinationCharterName ? (
                        <span className="flex items-center gap-1.5">
                          <span>{s.destinationCharterName}</span>
                          {s.destinationCharterCode ? (
                            <span className="text-muted-foreground/70 font-mono text-[11px]">
                              {s.destinationCharterCode}
                            </span>
                          ) : null}
                        </span>
                      ) : (
                        '—'
                      )}
                    </TableCell>
                    <TableCell>
                      <ShipmentStatusBadge status={s.status} />
                    </TableCell>
                    <TableCell className="text-muted-foreground text-right text-xs">
                      {formatRelative(s.updatedAt)}
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
