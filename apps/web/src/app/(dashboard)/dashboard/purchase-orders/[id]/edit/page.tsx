import { redirect } from 'next/navigation';
import { notFound } from 'next/navigation';

import { PoForm, type InitialPoValues } from '@/components/po/po-form';
import { PageHeader, PageHeaderBackLink } from '@/components/patterns/page-header';
import { requireOrgContext } from '@/lib/auth/session';
import { purchaseOrderItemTypes } from '@/lib/purchase-orders/item-types';
import { createClient } from '@/lib/supabase/server';
import { ChartersService } from '@/server/services/charters';
import { InventoryService } from '@/server/services/inventory';
import {
  readUnofferedDestinations,
  readUnofferedSuppliers,
} from '@/server/services/lib/unoffered-choices';
import { LocationsService } from '@/server/services/locations';
import { PurchaseOrdersService } from '@/server/services/purchase-orders';
import { ServiceError } from '@/server/services/context';
import { loadSizeRunGroups } from '@/server/services/size-run-display';
import { SuppliersService } from '@/server/services/suppliers';

import { can } from '@stockpilot/core';

/** The page area (DESIGN-SPEC 4 and 5.3), the same box the PO list and the
 *  shell's loading skeleton draw. */
const PAGE = 'mx-auto flex w-full max-w-[1320px] flex-col gap-4 px-4 pb-16 pt-6 sm:px-8 sm:pt-7';

/** The form at a reading width with room for the line editor's five columns. */
const FORM_WIDTH = 'w-full max-w-[960px]';

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
    // expected:'any' (mig 0277): the PO item picker must ALSO offer items
    // still awaiting their first receipt — an existing draft line for an
    // expected item must keep resolving, and re-ordering one must reuse
    // the row instead of inviting a duplicate.
    //
    // itemTypes (PURCHASE_ORDER_ITEM_TYPES): without it list() falls back to
    // its `item_type = 'product'` default and an existing BOOK line resolves
    // to nothing — the line renders blank even though it carries a real
    // itemId. The picker's server search sends the same set.
    //
    // excludeBundles: a kit's pre-assembled stock is never ordered (the save
    // refuses it, 0366), so the picker never offers it. An old draft's kit
    // line still shows what it is: PoForm resolves a line missing from this
    // list by id, unfiltered, and labels it "Pre-assembled kit".
    inventorySvc.list({
      limit: 1000,
      expected: 'any',
      itemTypes: purchaseOrderItemTypes(),
      excludeBundles: true,
    }),
    suppliersSvc.listForLookups(),
    locationsSvc.list({ sitesOnly: true }),
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

  // The destinations and suppliers the form offers: sites linked to a
  // warehouse (a warehouse-less location makes the PO impossible to receive
  // against), and the active suppliers.
  let locationOptions = locations
    .filter((l) => Boolean((l as { warehouse_id?: string | null }).warehouse_id))
    .map((l) => ({ id: l.id as string, name: l.name as string }));
  let supplierOptions = suppliers.map((s) => ({ id: s.id as string, name: s.name as string }));

  // A draft can hold a destination or supplier the form does not offer: a
  // staging area or a location deleted since (production 2026-10-06: four
  // Demo Co purchase orders to Staging, three Learn4Life ones to deleted
  // locations, none of them drafts), or an archived supplier. The selects
  // showed those blank and the save sent them back unseen. The form now keeps
  // none of them and names each one (PoForm `unoffered`, small fixes slice 8),
  // so read what they are, in this organization through RLS. Labels only: a
  // failed read names nothing, never an error page.
  const currentDestinationId =
    (po as { destination_location_id?: string | null }).destination_location_id ?? null;
  const currentSupplierId = (po as { supplier_id?: string | null }).supplier_id ?? null;
  const unofferedDestinationId =
    currentDestinationId !== null && !locationOptions.some((l) => l.id === currentDestinationId)
      ? currentDestinationId
      : null;
  const unofferedSupplierId =
    currentSupplierId !== null && !supplierOptions.some((s) => s.id === currentSupplierId)
      ? currentSupplierId
      : null;
  const [unofferedDestinations, unofferedSuppliers] = await Promise.all([
    unofferedDestinationId
      ? createClient().then((client) =>
          readUnofferedDestinations(
            client,
            ctx.organizationId,
            [unofferedDestinationId],
            'purchase_orders.edit.unoffered_destination',
          ),
        )
      : null,
    unofferedSupplierId
      ? readUnofferedSuppliers(
          (ids) => suppliersSvc.namesByIds(ids),
          [unofferedSupplierId],
          'purchase_orders.edit.unoffered_supplier',
        )
      : null,
  ]);
  // A supplier still active that the select lacks only because the
  // Suppliers module is off is offered after all, so the draft keeps it. So
  // is a live site linked to a warehouse that the list did not return, so
  // the draft keeps its destination.
  if (unofferedSuppliers) supplierOptions = [...supplierOptions, ...unofferedSuppliers.fold];
  if (unofferedDestinations) locationOptions = [...locationOptions, ...unofferedDestinations.fold];
  const unoffered = {
    destination: unofferedDestinationId
      ? (unofferedDestinations?.unoffered.get(unofferedDestinationId) ?? null)
      : null,
    supplier: unofferedSupplierId
      ? (unofferedSuppliers?.unoffered.get(unofferedSupplierId) ?? null)
      : null,
  };

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

  // Size-run add mode (Task 16). No grouped items = no query.
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
    <div className={PAGE}>
      <PageHeader
        back={
          <PageHeaderBackLink href={`/dashboard/purchase-orders/${id}`}>
            ← Back to purchase order
          </PageHeaderBackLink>
        }
        // The PO number in mono, as the PO's own page titles it.
        title={
          <>
            Edit{' '}
            <span className="font-mono tracking-normal">
              {(po as { po_number?: string }).po_number ?? 'Purchase Order'}
            </span>
          </>
        }
        className={FORM_WIDTH}
      />
      <div className={FORM_WIDTH}>
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
          suppliers={supplierOptions}
          // Only warehouse-backed locations can be receiving destinations — a
          // warehouse-less location makes the PO impossible to receive against.
          locations={locationOptions}
          charters={charterOptions.map((c) => ({ id: c.id as string, name: c.name as string }))}
          poId={id}
          initial={initial}
          unoffered={unoffered}
        />
      </div>
    </div>
  );
}
