import Link from 'next/link';
import { notFound } from 'next/navigation';

import { PoReceiveDialog } from '@/components/po/po-receive-dialog';
import { PoStatusBadge } from '@/components/po/po-status-badge';
import { PoActions } from '@/components/po/po-actions';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ServiceError } from '@/server/services/context';
import { InventoryService } from '@/server/services/inventory';
import { LocationsService } from '@/server/services/locations';
import { PurchaseOrdersService } from '@/server/services/purchase-orders';
import { SuppliersService } from '@/server/services/suppliers';
import { formatCurrency, formatRelative } from '@/lib/utils';

export default async function PoDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [poSvc, inventorySvc, suppliersSvc, locationsSvc] = await Promise.all([
    PurchaseOrdersService.forCurrentUser(),
    InventoryService.forCurrentUser(),
    SuppliersService.forCurrentUser(),
    LocationsService.forCurrentUser(),
  ]);

  let result;
  try {
    result = await poSvc.get(id);
  } catch (e) {
    if (e instanceof ServiceError && e.code === 'not_found') notFound();
    throw e;
  }

  const { po, lines } = result;

  const [inventory, suppliers, locations] = await Promise.all([
    inventorySvc.list({ limit: 1000, status: 'all' }),
    suppliersSvc.list(),
    locationsSvc.list(),
  ]);
  const itemsById = new Map(inventory.items.map((i) => [i.id, i]));

  const supplier = suppliers.find((s) => s.id === po.supplier_id);
  const location = locations.find((l) => l.id === po.destination_location_id);

  const status = po.status as string;
  const canReceive = status === 'ordered' || status === 'partially_received';

  const lineRows = lines.map((l) => {
    const item = itemsById.get(l.item_id as string);
    return {
      id: l.id as string,
      name: item?.name ?? 'Unknown item',
      sku: item?.sku ?? '',
      quantityOrdered: l.quantity_ordered as number,
      quantityReceived: l.quantity_received as number,
      unitCost: l.unit_cost as number,
      lineTotal: l.line_total as number,
    };
  });

  return (
    <div className="container mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <div className="mb-6">
        <Link
          href="/dashboard/purchase-orders"
          className="text-muted-foreground hover:text-foreground text-sm"
        >
          ← Back to purchase orders
        </Link>
      </div>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-mono text-2xl font-semibold tracking-tight">
            {po.po_number as string}
          </h1>
          <div className="mt-2 flex items-center gap-2">
            <PoStatusBadge status={status} />
            <span className="text-muted-foreground text-sm">
              · created {formatRelative(po.created_at as string)}
            </span>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <PoActions poId={id} status={status} />
          {canReceive && (
            <PoReceiveDialog poId={id} poNumber={po.po_number as string} lines={lineRows} />
          )}
        </div>
      </div>

      <div className="mt-8 grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Line items</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Item</TableHead>
                  <TableHead className="text-right">Ordered</TableHead>
                  <TableHead className="text-right">Received</TableHead>
                  <TableHead className="text-right">Unit cost</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {lineRows.map((l) => (
                  <TableRow key={l.id}>
                    <TableCell>
                      <p className="font-medium">{l.name}</p>
                      <p className="text-muted-foreground font-mono text-xs">{l.sku}</p>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{l.quantityOrdered}</TableCell>
                    <TableCell className="text-right tabular-nums">{l.quantityReceived}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatCurrency(l.unitCost)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatCurrency(l.lineTotal)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Summary</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <Row label="Supplier" value={(supplier?.name as string) ?? '—'} />
            <Row label="Destination" value={(location?.name as string) ?? '—'} />
            <Row
              label="Expected"
              value={po.expected_at ? new Date(po.expected_at as string).toLocaleDateString() : '—'}
            />
            <Row label="Subtotal" value={formatCurrency(po.subtotal as number)} />
            <Row label="Total" value={formatCurrency(po.total as number)} bold />
            {po.notes && (
              <div className="space-y-1 border-t pt-3">
                <p className="text-muted-foreground text-xs uppercase tracking-wider">Notes</p>
                <p className="whitespace-pre-wrap text-sm">{po.notes as string}</p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className={bold ? 'font-semibold tabular-nums' : 'tabular-nums'}>{value}</span>
    </div>
  );
}
