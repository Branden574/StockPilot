import Link from 'next/link';
import { redirect } from 'next/navigation';
import { notFound } from 'next/navigation';

import { PoForm, type InitialPoValues } from '@/components/po/po-form';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { requireOrgContext } from '@/lib/auth/session';
import { ChartersService } from '@/server/services/charters';
import { InventoryService } from '@/server/services/inventory';
import { LocationsService } from '@/server/services/locations';
import { PurchaseOrdersService } from '@/server/services/purchase-orders';
import { ServiceError } from '@/server/services/context';
import { SuppliersService } from '@/server/services/suppliers';

import { can } from '@stockpilot/core';

export default async function EditPoPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const ctx = await requireOrgContext();
  if (!can(ctx, 'purchase_orders:manage')) {
    redirect('/dashboard');
  }

  const [poSvc, inventorySvc, suppliersSvc, locationsSvc, chartersSvc] = await Promise.all([
    PurchaseOrdersService.forCurrentUser(),
    InventoryService.forCurrentUser(),
    SuppliersService.forCurrentUser(),
    LocationsService.forCurrentUser(),
    ChartersService.forCurrentUser(),
  ]);

  let result;
  try {
    result = await poSvc.get(id);
  } catch (e) {
    if (e instanceof ServiceError && e.code === 'not_found') notFound();
    throw e;
  }

  const { po, lines } = result;

  // Only draft POs can be edited.
  if ((po as { status?: string }).status !== 'draft') {
    redirect(`/dashboard/purchase-orders/${id}`);
  }

  const [inventory, suppliers, locations, charters] = await Promise.all([
    inventorySvc.list({ limit: 1000 }),
    suppliersSvc.list(),
    locationsSvc.list({ excludeSystem: true }),
    chartersSvc.list(),
  ]);

  // The picker normally lists active charters only. If this PO is billed to a
  // charter that has since been archived, fold it back in so the picker shows
  // the current value (instead of appearing blank) and the user can keep it.
  const currentCharterId = (po as { charter_id?: string | null }).charter_id ?? null;
  let charterOptions = charters;
  if (currentCharterId && !charters.some((c) => (c.id as string) === currentCharterId)) {
    const withArchived = await chartersSvc.list({ includeArchived: true });
    const current = withArchived.find((c) => (c.id as string) === currentCharterId);
    if (current) charterOptions = [...charters, current];
  }

  // Map PO's existing lines to the form's Line shape.
  // Lines from the service have item_id (snake_case); the form expects itemId.
  const initialLines = lines.map((l) => ({
    itemId: (l.item_id as string | null) ?? undefined,
    quantityOrdered: l.quantity_ordered as number,
    unitCost: l.unit_cost as number,
  }));

  // Convert the stored expected_at ISO string to a date-input value (YYYY-MM-DD).
  const storedExpectedAt = (po as { expected_at?: string | null }).expected_at ?? null;
  const expectedAtDateInput = storedExpectedAt
    ? new Date(storedExpectedAt).toISOString().slice(0, 10)
    : '';

  const initial: InitialPoValues = {
    supplierId: (po as { supplier_id?: string | null }).supplier_id ?? '',
    locationId: (po as { destination_location_id?: string | null }).destination_location_id ?? '',
    charterId: (po as { charter_id?: string | null }).charter_id ?? '',
    expectedAt: expectedAtDateInput,
    notes: (po as { notes?: string | null }).notes ?? '',
    poNumber: (po as { po_number?: string }).po_number ?? '',
    lines: initialLines,
  };

  return (
    <div className="container mx-auto max-w-4xl px-4 py-8 sm:px-6">
      <div className="mb-6">
        <Link
          href={`/dashboard/purchase-orders/${id}`}
          className="text-muted-foreground hover:text-foreground text-sm"
        >
          ← Back to purchase order
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">
          Edit {(po as { po_number?: string }).po_number ?? 'Purchase Order'}
        </h1>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>PO details</CardTitle>
        </CardHeader>
        <CardContent>
          <PoForm
            items={inventory.items.map((i) => ({
              id: i.id,
              name: i.name,
              sku: i.sku,
              unit_cost: i.unit_cost,
            }))}
            suppliers={suppliers.map((s) => ({ id: s.id as string, name: s.name as string }))}
            // Only warehouse-backed locations can be receiving destinations — a
            // warehouse-less location makes the PO impossible to receive against.
            locations={locations
              .filter((l) => Boolean((l as { warehouse_id?: string | null }).warehouse_id))
              .map((l) => ({ id: l.id as string, name: l.name as string }))}
            charters={charterOptions.map((c) => ({ id: c.id as string, name: c.name as string }))}
            poId={id}
            initial={initial}
          />
        </CardContent>
      </Card>
    </div>
  );
}
