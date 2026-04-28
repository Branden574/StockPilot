import { Boxes, DollarSign, MapPin, Package2, Tag, Truck } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { StockStatusBadge } from '@/components/inventory/stock-status-badge';
import { StockAdjustDialog } from '@/components/inventory/stock-adjust-dialog';
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
import { LocationsService } from '@/server/services/locations';
import { MovementsService } from '@/server/services/movements';
import { SuppliersService } from '@/server/services/suppliers';
import { formatCurrency, formatNumber, formatRelative } from '@/lib/utils';

export default async function ItemDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const inventorySvc = await InventoryService.forCurrentUser();
  const movementsSvc = await MovementsService.forCurrentUser();

  let item;
  try {
    item = await inventorySvc.get(id);
  } catch (e) {
    if (e instanceof ServiceError && e.code === 'not_found') notFound();
    throw e;
  }

  const [categories, locations, suppliers, movements] = await Promise.all([
    (await CategoriesService.forCurrentUser()).list(),
    (await LocationsService.forCurrentUser()).list(),
    (await SuppliersService.forCurrentUser()).list(),
    movementsSvc.list({ itemId: id, limit: 50 }),
  ]);

  const category = categories.find((c) => c.id === item.category_id);
  const location = locations.find((l) => l.id === item.primary_location_id);
  const supplier = suppliers.find((s) => s.id === item.supplier_id);

  const value = (item.quantity_on_hand as number) * (item.unit_cost as number);

  return (
    <div className="container mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <div className="mb-6">
        <Link href="/dashboard/inventory" className="text-sm text-muted-foreground hover:text-foreground">
          ← Back to inventory
        </Link>
      </div>

      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{item.name as string}</h1>
          <p className="mt-1 font-mono text-xs text-muted-foreground">{item.sku as string}</p>
        </div>
        <div className="flex gap-2">
          <Button asChild variant="outline">
            <Link href={`/dashboard/inventory/${id}/edit`}>Edit</Link>
          </Button>
          <StockAdjustDialog
            itemId={id}
            itemName={item.name as string}
            currentQuantity={item.quantity_on_hand as number}
          />
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
              <span className="text-xs text-muted-foreground">
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
              {item.bin_location && <span className="text-xs text-muted-foreground">{item.bin_location as string}</span>}
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
                  <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
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
            <Stat label="Reorder at" value={`${formatNumber(item.reorder_point as number)} ${item.unit_of_measure as string}`} />
            <Stat label="Reorder qty" value={`${formatNumber(item.reorder_quantity as number)} ${item.unit_of_measure as string}`} />
            <Stat label="Retail price" value={formatCurrency(item.retail_price as number)} />
            <Stat label="Status" value={(item.status as string).replace(/^./, (s) => s.toUpperCase())} />
          </CardContent>
        </Card>
      </div>

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
                  <TableCell colSpan={6} className="py-10 text-center text-sm text-muted-foreground">
                    No movements yet. Adjust stock above to create one.
                  </TableCell>
                </TableRow>
              )}
              {movements.map((m) => {
                const change = Number(m.quantity_change);
                return (
                  <TableRow key={m.id as string}>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatRelative(m.created_at as string)}
                    </TableCell>
                    <TableCell className="text-xs uppercase tracking-wider text-muted-foreground">
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
                    <TableCell className="text-right tabular-nums text-xs text-muted-foreground">
                      {formatNumber(Number(m.previous_quantity))}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatNumber(Number(m.new_quantity))}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
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
      <Icon className="mt-0.5 h-4 w-4 text-muted-foreground" />
      <div className="flex-1 space-y-0.5">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
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
