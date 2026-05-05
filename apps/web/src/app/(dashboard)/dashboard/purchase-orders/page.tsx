import { ClipboardList } from 'lucide-react';
import Link from 'next/link';

import { EmptyState } from '@/components/dashboard/empty-state';
import { PoStatusBadge } from '@/components/po/po-status-badge';
import { Button } from '@/components/ui/button';
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
import { formatCurrency, formatRelative } from '@/lib/utils';

export default async function PurchaseOrdersPage() {
  const [poSvc, supplierSvc, warehouseFilter] = await Promise.all([
    PurchaseOrdersService.forCurrentUser(),
    SuppliersService.forCurrentUser(),
    getActiveWarehouseFilter(),
  ]);

  const [pos, suppliers] = await Promise.all([
    poSvc.list({ warehouseId: warehouseFilter ?? undefined }),
    supplierSvc.list(),
  ]);
  const supplierMap = new Map(suppliers.map((s) => [s.id as string, s.name as string]));

  return (
    <div className="container mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-3 sm:gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Purchase orders</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Draft POs, send to suppliers, then receive against them to bump stock automatically.
          </p>
        </div>
        <Button asChild variant="gradient">
          <Link href="/dashboard/purchase-orders/new">+ New PO</Link>
        </Button>
      </div>

      <div className="mt-8">
        {pos.length === 0 ? (
          <EmptyState
            icon={ClipboardList}
            title="No purchase orders yet"
            description="Draft a PO with line items, send it to a supplier, then receive against it."
            action={
              <Button asChild variant="gradient">
                <Link href="/dashboard/purchase-orders/new">Create your first PO</Link>
              </Button>
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
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead className="text-right">Expected</TableHead>
                  <TableHead className="text-right">Updated</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pos.map((po) => (
                  <TableRow key={po.id as string}>
                    <TableCell>
                      <Link
                        href={`/dashboard/purchase-orders/${po.id}`}
                        className="font-mono text-sm font-medium hover:underline"
                      >
                        {po.po_number as string}
                      </Link>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {po.supplier_id ? (supplierMap.get(po.supplier_id as string) ?? '—') : '—'}
                    </TableCell>
                    <TableCell>
                      <PoStatusBadge status={po.status as string} />
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatCurrency(po.total as number)}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-right text-xs">
                      {po.expected_at ? formatRelative(po.expected_at as string) : '—'}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-right text-xs">
                      {formatRelative(po.updated_at as string)}
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
