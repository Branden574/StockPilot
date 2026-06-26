import { Download } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { ItemThumb } from '@/components/items/item-thumb';
import { MakeRecurringButton } from '@/components/po/make-recurring-button';
import { PoReceiveDialog } from '@/components/po/po-receive-dialog';
import { PoNotesEditor } from '@/components/po/po-notes-editor';
import { PoRenameButton } from '@/components/po/po-rename-button';
import { PoSetDestination } from '@/components/po/po-set-destination';
import { PoStatusBadge } from '@/components/po/po-status-badge';
import { PoActions } from '@/components/po/po-actions';
import { ReceiptHistory } from '@/components/po/receipt-history';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { PoAccessDenied } from '@/components/po/po-access-denied';
import { requireOrgContext } from '@/lib/auth/session';
import { ServiceError } from '@/server/services/context';
import { InventoryService } from '@/server/services/inventory';
import { LocationsService } from '@/server/services/locations';
import { PurchaseOrdersService } from '@/server/services/purchase-orders';
import { ReceivingService } from '@/server/services/receiving';
import { SuppliersService } from '@/server/services/suppliers';
import { WarehousesService } from '@/server/services/warehouses';
import { formatCurrency, formatRelative } from '@/lib/utils';

import { can, isManagerOrAbove } from '@stockpilot/core';

export default async function PoDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  // Gate in-page BEFORE any service call. poSvc.get() asserts
  // purchase_orders:read and THROWS forbidden when revoked; a thrown RSC trips
  // the error boundary ("Something broke loading this page") because Next
  // renders this page concurrently with the section layout, so the layout's
  // gate can't catch it first. Checking here renders the clean denial instead.
  const ctx = await requireOrgContext();
  if (!can(ctx, 'purchase_orders:read')) {
    return <PoAccessDenied />;
  }

  const [poSvc, inventorySvc, suppliersSvc, locationsSvc, receivingSvc, warehousesSvc] = await Promise.all([
    PurchaseOrdersService.forCurrentUser(),
    InventoryService.forCurrentUser(),
    SuppliersService.forCurrentUser(),
    LocationsService.forCurrentUser(),
    ReceivingService.forCurrentUser(),
    WarehousesService.forCurrentUser(),
  ]);

  let result;
  try {
    result = await poSvc.get(id);
  } catch (e) {
    if (e instanceof ServiceError && e.code === 'not_found') notFound();
    throw e;
  }

  const { po, lines } = result;

  const [suppliers, locations, receiptData, warehouses] = await Promise.all([
    suppliersSvc.list(),
    locationsSvc.list({ excludeSystem: true }),
    receivingSvc.listForPurchaseOrder(id),
    warehousesSvc.list(),
  ]);

  // Load only the items actually referenced on this PO (lines + receipts)
  // instead of the whole inventory. Caps memory + DB scan to ~PO size.
  const lineItemIds = lines.map((l) => l.item_id as string).filter(Boolean);
  const receiptItemIds = receiptData.lines.map((l) => l.item_id as string).filter(Boolean);
  const referencedIds = Array.from(new Set([...lineItemIds, ...receiptItemIds]));
  // includeDeleted: this is historical display — a since-deleted (e.g. auto-
  // cleaned-up) item should still show its name on past lines/receipts.
  const referencedItems = await inventorySvc.byIds(referencedIds, { includeDeleted: true });
  const itemsById = new Map(referencedItems.map((i) => [i.id, i]));

  const supplier = suppliers.find((s) => s.id === po.supplier_id);
  const location = locations.find((l) => l.id === po.destination_location_id);

  // Receipts post against a warehouse. Derive it from the destination
  // location's warehouse_id. If the PO has no destination, the receive button
  // is disabled with a helpful tooltip.
  const warehouseId =
    (location?.warehouse_id as string | null | undefined) ?? null;

  const status = po.status as string;
  const canReceive =
    (status === 'ordered' ||
      status === 'expected_inbound' ||
      status === 'partially_received') &&
    warehouseId !== null;
  const canReverse = isManagerOrAbove(ctx.role);

  const lineRows = lines.map((l) => {
    const item = itemsById.get(l.item_id as string);
    return {
      id: l.id as string,
      itemId: l.item_id as string,
      name: item?.name ?? 'Unknown item',
      sku: item?.sku ?? '',
      quantityOrdered: l.quantity_ordered as number,
      quantityReceived: l.quantity_received as number,
      unitCost: l.unit_cost as number,
      lineTotal: l.line_total as number,
      trackingType: (item?.tracking_type ?? 'none') as 'none' | 'lot' | 'serial',
      imageUrl: (l.imageUrl as string | null | undefined) ?? null,
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
          <div className="flex items-center gap-1.5">
            <h1 className="font-mono text-2xl font-semibold tracking-tight">
              {po.po_number as string}
            </h1>
            {status !== 'cancelled' && (
              <PoRenameButton poId={id} currentNumber={po.po_number as string} />
            )}
          </div>
          <div className="mt-2 flex items-center gap-2">
            <PoStatusBadge status={status} />
            <span className="text-muted-foreground text-sm">
              · created {formatRelative(po.created_at as string)}
            </span>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline">
            <a href={`/api/purchase-orders/${id}/pdf`} target="_blank" rel="noopener noreferrer">
              <Download className="h-4 w-4" /> Download PDF
            </a>
          </Button>
          <MakeRecurringButton poId={id} />
          <PoActions poId={id} status={status} />
        </div>
      </div>

      {/*
        Show the destination-fix card whenever we can't resolve a warehouse to
        receive against — covering BOTH a missing destination AND a destination
        location that has no warehouse_id. The latter is the dead-end that hid
        the Receive button with no way out: the destination was set, so the old
        `!destination_location_id` gate never fired. */}
      {warehouseId === null &&
        (status === 'expected_inbound' ||
          status === 'ordered' ||
          status === 'partially_received' ||
          status === 'draft') && (
          <div className="mt-6">
            <PoSetDestination
              poId={id}
              warehouses={warehouses.map((w) => ({ id: w.id, name: w.name }))}
              hasUnreceivableDestination={po.destination_location_id != null}
            />
          </div>
        )}

      <div className="mt-8 grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
            <div>
              <CardTitle className="text-base">Line items</CardTitle>
              {canReceive && warehouseId && (
                <p className="text-muted-foreground mt-1 text-xs">
                  Items arrived? Use “Receive items” to record what was received.
                </p>
              )}
            </div>
            {canReceive && warehouseId && (
              <PoReceiveDialog
                poId={id}
                poNumber={po.po_number as string}
                warehouseId={warehouseId}
                lines={lineRows}
              />
            )}
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-12">Image</TableHead>
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
                      <ItemThumb
                        imageUrl={l.imageUrl}
                        alt={l.name}
                        size="sm"
                        itemId={l.itemId}
                      />
                    </TableCell>
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

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Receipts</CardTitle>
          </CardHeader>
          <CardContent>
            <ReceiptHistory
              receipts={receiptData.receipts}
              lines={receiptData.lines}
              items={Object.fromEntries(
                referencedItems.map((i) => [i.id, { name: i.name, sku: i.sku }]),
              )}
              canReverse={canReverse}
            />
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
            <PoNotesEditor poId={id} currentNotes={(po.notes as string | null) ?? null} />
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
