import { Plus, Send } from 'lucide-react';
import Link from 'next/link';

import { EmptyState } from '@/components/ui/empty-state';
import { ShipmentStatusBadge } from '@/components/shipments/shipment-status-badge';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ShipmentsService } from '@/server/services/shipments';
import { formatRelative } from '@/lib/utils';

export default async function ShipmentsPage() {
  const svc = await ShipmentsService.forCurrentUser();
  const shipments = await svc.list();

  return (
    <div className="container mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-3 sm:gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Shipments</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Outbound packing slips between warehouses. Print, deliver, and
            collect a signature on paper — Phase 2B will add the digital
            signature flow.
          </p>
        </div>
        <Button asChild variant="gradient">
          <Link href="/dashboard/shipments/new">
            <Plus className="h-4 w-4" /> New shipment
          </Link>
        </Button>
      </div>

      <div className="mt-8">
        {shipments.length === 0 ? (
          <EmptyState
            icon={Send}
            title="No shipments yet"
            description="Generate a packing slip from an order request and it'll show up here, ready to print, deliver, and collect a signature on."
            cta={{ label: 'New shipment', href: '/dashboard/shipments/new' }}
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
