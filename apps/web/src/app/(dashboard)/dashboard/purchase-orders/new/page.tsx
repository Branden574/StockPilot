import Link from 'next/link';
import { redirect } from 'next/navigation';

import { PoForm } from '@/components/po/po-form';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { requireOrgContext } from '@/lib/auth/session';
import { purchaseOrderItemTypes } from '@/lib/purchase-orders/item-types';
import { ChartersService } from '@/server/services/charters';
import { InventoryService } from '@/server/services/inventory';
import { LocationsService } from '@/server/services/locations';
import { loadSizeRunGroups } from '@/server/services/size-run-display';
import { SuppliersService } from '@/server/services/suppliers';

import { can } from '@stockpilot/core';

export default async function NewPoPage() {
  // Submit asserts purchase_orders:manage. Without this gate
  // viewers/staff would land on the form, fill it out, and only
  // discover the permission gap when they click Create.
  const ctx = await requireOrgContext();
  if (!can(ctx, 'purchase_orders:manage')) {
    redirect('/dashboard');
  }
  const [inventorySvc, suppliersSvc, locationsSvc, chartersSvc] = await Promise.all([
    InventoryService.forCurrentUser(),
    SuppliersService.forCurrentUser(),
    LocationsService.forCurrentUser(),
    ChartersService.forCurrentUser(),
  ]);
  const [inventory, suppliers, locations, charters] = await Promise.all([
    // expected:'any' (mig 0277): the PO item picker must ALSO offer items
    // still awaiting their first receipt — re-ordering an expected SKU has
    // to reuse the existing row, or the picker invites a duplicate item.
    //
    // itemTypes (PURCHASE_ORDER_ITEM_TYPES): without it list() falls back to
    // its `item_type = 'product'` default and NO book ever reaches this form,
    // even though books are demonstrably purchasable. The picker's server
    // search sends the same set, so the two can never disagree.
    inventorySvc.list({ limit: 1000, expected: 'any', itemTypes: purchaseOrderItemTypes() }),
    suppliersSvc.list(),
    locationsSvc.list({ sitesOnly: true }),
    chartersSvc.list(),
  ]);

  // Size-run add mode (Task 16). No grouped items = no query, which is every
  // catalog in every org that has not opted into product groups.
  const groupIds = Array.from(
    new Set(inventory.items.map((i) => i.group_id).filter((v): v is string => Boolean(v))),
  );
  // groupItems is the UNCAPPED, group-scoped read (review fix): `inventory`
  // above is list()'s capped 1000-row page, so a >1000-item org could have a
  // group whose 1001st+ variant never made it into `inventory.items`. The
  // size-run picker sources its variants from here instead, so a group's size
  // count is correct regardless of catalog size.
  const [productGroups, groupItemRows] = await Promise.all([
    loadSizeRunGroups(groupIds),
    groupIds.length > 0 ? inventorySvc.listGroupVariants(groupIds) : Promise.resolve([]),
  ]);

  return (
    <div className="container mx-auto max-w-4xl px-4 py-8 sm:px-6">
      <div className="mb-6">
        <Link
          href="/dashboard/purchase-orders"
          className="text-muted-foreground hover:text-foreground text-sm"
        >
          ← Back to purchase orders
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">New purchase order</h1>
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
              groupId: i.group_id,
              variantSize: i.variant_size,
              // Drives the "Book" marker + ISBN on a picker row. For a book,
              // barcode IS the ISBN.
              itemType: i.item_type,
              barcode: i.barcode,
            }))}
            productGroups={productGroups}
            groupItems={groupItemRows.map((i) => ({
              id: i.id,
              name: i.name,
              sku: i.sku,
              unit_cost: i.unit_cost,
              groupId: i.group_id,
              variantSize: i.variant_size,
            }))}
            suppliers={suppliers.map((s) => ({ id: s.id as string, name: s.name as string }))}
            // Only warehouse-backed locations can be receiving destinations — a
            // warehouse-less location makes the PO impossible to receive against.
            locations={locations
              .filter((l) => Boolean((l as { warehouse_id?: string | null }).warehouse_id))
              .map((l) => ({ id: l.id as string, name: l.name as string }))}
            charters={charters.map((c) => ({ id: c.id as string, name: c.name as string }))}
          />
        </CardContent>
      </Card>
    </div>
  );
}
