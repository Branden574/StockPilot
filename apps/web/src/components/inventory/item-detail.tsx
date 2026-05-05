import { Boxes, DollarSign, MapPin, Package2, Printer, Tag, Truck } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { BarcodeDisplay } from '@/components/inventory/barcode-display';
import { ImageUploader } from '@/components/inventory/image-uploader';
import { StockStatusBadge } from '@/components/inventory/stock-status-badge';
import { StockAdjustDialog } from '@/components/inventory/stock-adjust-dialog';
import { StockTransferDialog } from '@/components/inventory/stock-transfer-dialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { CategoriesService } from '@/server/services/categories';
import { ServiceError } from '@/server/services/context';
import { InventoryService } from '@/server/services/inventory';
import { ItemImagesService } from '@/server/services/item-images';
import { LocationsService } from '@/server/services/locations';
import { MovementsService } from '@/server/services/movements';
import { SuppliersService } from '@/server/services/suppliers';
import { formatCurrency, formatNumber, formatRelative } from '@/lib/utils';

interface ItemDetailProps {
  id: string;
  backHref: string;
  backLabel: string;
}

export async function ItemDetail({ id, backHref, backLabel }: ItemDetailProps) {
  const [inventorySvc, movementsSvc, imagesSvc, categoriesSvc, locationsSvc, suppliersSvc] =
    await Promise.all([
      InventoryService.forCurrentUser(),
      MovementsService.forCurrentUser(),
      ItemImagesService.forCurrentUser(),
      CategoriesService.forCurrentUser(),
      LocationsService.forCurrentUser(),
      SuppliersService.forCurrentUser(),
    ]);

  let item;
  try {
    item = await inventorySvc.get(id);
  } catch (e) {
    if (e instanceof ServiceError && e.code === 'not_found') notFound();
    throw e;
  }

  const [categories, locations, suppliers, movements, imageRows] = await Promise.all([
    categoriesSvc.list(),
    locationsSvc.list(),
    suppliersSvc.list(),
    movementsSvc.list({ itemId: id, limit: 50 }),
    imagesSvc.list(id),
  ]);
  const signed = await imagesSvc.signedUrls(imageRows.map((r) => r.storage_path as string));
  const images = imageRows.map((r) => ({
    id: r.id as string,
    url: signed.get(r.storage_path as string) ?? '',
    isPrimary: Boolean(r.is_primary),
  }));

  const category = categories.find((c) => c.id === item.category_id);
  const location = locations.find((l) => l.id === item.primary_location_id);
  const supplier = suppliers.find((s) => s.id === item.supplier_id);

  const value = (item.quantity_on_hand as number) * (item.unit_cost as number);

  return (
    <div className="container mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <div className="mb-6">
        <Link href={backHref} className="text-muted-foreground hover:text-foreground text-sm">
          ← {backLabel}
        </Link>
      </div>

      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{item.name as string}</h1>
          <p className="text-muted-foreground mt-1 font-mono text-xs">{item.sku as string}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline">
            <Link href={`/dashboard/inventory/${id}/edit`}>Edit</Link>
          </Button>
          <BarcodeDisplay
            itemId={id}
            itemName={item.name as string}
            sku={item.sku as string}
            barcode={(item.barcode as string | null) ?? null}
          />
          <Button asChild variant="outline">
            <Link href={`/dashboard/inventory/labels?items=${id}`}>
              <Printer className="h-4 w-4" /> Print label
            </Link>
          </Button>
          <StockAdjustDialog
            itemId={id}
            itemName={item.name as string}
            currentQuantity={item.quantity_on_hand as number}
          />
          {locations.length >= 2 && (
            <StockTransferDialog
              itemId={id}
              itemName={item.name as string}
              currentQuantity={item.quantity_on_hand as number}
              currentLocationId={(item.primary_location_id as string | null) ?? null}
              locations={locations.map((l) => ({
                id: l.id as string,
                name: l.name as string,
                warehouse_id: (l.warehouse_id as string | null) ?? null,
              }))}
            />
          )}
        </div>
      </div>

      <div className="mt-8 grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            <DetailRow icon={Boxes} label="On hand">
              <span className="text-base font-semibold tabular-nums">
                {formatNumber(item.quantity_on_hand as number)} {item.unit_of_measure as string}
              </span>
              <StockStatusBadge
                quantity={item.quantity_on_hand as number}
                reorderPoint={item.reorder_point as number}
                itemStatus={item.status as 'active' | 'archived' | 'discontinued'}
              />
            </DetailRow>
            <DetailRow icon={DollarSign} label="Value">
              <span className="text-base tabular-nums">{formatCurrency(value)}</span>
              <span className="text-muted-foreground text-xs">
                @ {formatCurrency(item.unit_cost as number)} unit cost
              </span>
            </DetailRow>
            <Separator />
            <DetailRow icon={Tag} label="Category">
              {category ? (
                <span>{category.name as string}</span>
              ) : (
                <span className="text-muted-foreground">Uncategorized</span>
              )}
            </DetailRow>
            <DetailRow icon={MapPin} label="Location">
              {location ? (
                <span>{location.name as string}</span>
              ) : (
                <span className="text-muted-foreground">Not set</span>
              )}
              {item.bin_location && (
                <span className="text-muted-foreground text-xs">{item.bin_location as string}</span>
              )}
            </DetailRow>
            <DetailRow icon={Truck} label="Supplier">
              {supplier ? (
                <span>{supplier.name as string}</span>
              ) : (
                <span className="text-muted-foreground">No supplier</span>
              )}
            </DetailRow>
            {(item.description as string | null) && (
              <>
                <Separator />
                <div className="space-y-1.5">
                  <p className="text-muted-foreground text-xs font-semibold uppercase tracking-wider">
                    Description
                  </p>
                  <p className="whitespace-pre-wrap text-sm">{item.description as string}</p>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Reorder</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <Stat
              label="Reorder at"
              value={`${formatNumber(item.reorder_point as number)} ${item.unit_of_measure as string}`}
            />
            <Stat
              label="Reorder qty"
              value={`${formatNumber(item.reorder_quantity as number)} ${item.unit_of_measure as string}`}
            />
            <Stat label="Retail price" value={formatCurrency(item.retail_price as number)} />
            <Stat
              label="Status"
              value={(item.status as string).replace(/^./, (s) => s.toUpperCase())}
            />
          </CardContent>
        </Card>
      </div>

      <Card className="mt-8">
        <CardHeader>
          <CardTitle className="text-base">Images</CardTitle>
        </CardHeader>
        <CardContent>
          <ImageUploader itemId={id} initialImages={images} />
        </CardContent>
      </Card>

      <Card className="mt-8">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Package2 className="h-4 w-4" /> Movement history
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Type</TableHead>
                <TableHead className="text-right">Δ</TableHead>
                <TableHead className="text-right">Before</TableHead>
                <TableHead className="text-right">After</TableHead>
                <TableHead>Note</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {movements.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={6}
                    className="text-muted-foreground py-10 text-center text-sm"
                  >
                    No movements yet. Adjust stock above to create one.
                  </TableCell>
                </TableRow>
              )}
              {movements.map((m) => {
                const change = Number(m.quantity_change);
                return (
                  <TableRow key={m.id as string}>
                    <TableCell className="text-muted-foreground text-xs">
                      {formatRelative(m.created_at as string)}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs uppercase tracking-wider">
                      {m.movement_type as string}
                    </TableCell>
                    <TableCell
                      className={
                        'text-right font-mono tabular-nums ' +
                        (change > 0 ? 'text-success' : change < 0 ? 'text-destructive' : '')
                      }
                    >
                      {change > 0 ? '+' : ''}
                      {formatNumber(change)}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-right text-xs tabular-nums">
                      {formatNumber(Number(m.previous_quantity))}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatNumber(Number(m.new_quantity))}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {(m.reason as string | null) ?? (m.notes as string | null) ?? '—'}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

function DetailRow({
  icon: Icon,
  label,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-3">
      <Icon className="text-muted-foreground mt-0.5 h-4 w-4" />
      <div className="flex-1 space-y-0.5">
        <p className="text-muted-foreground text-xs font-semibold uppercase tracking-wider">
          {label}
        </p>
        <div className="flex flex-wrap items-center gap-2">{children}</div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium tabular-nums">{value}</span>
    </div>
  );
}
