import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';

import { ItemForm } from '@/components/inventory/item-form';
import { PageHeader, PageHeaderBackLink } from '@/components/patterns/page-header';
import { forcedWarehouseId } from '@/lib/auth/warehouse';
import { requireOrgContext } from '@/lib/auth/session';
import { checkModuleAccess } from '@/lib/modules/module-gate';
import { safeReturnPath } from '@/lib/safe-return-path';
import { createClient } from '@/lib/supabase/server';
import { notFoundUnlessUuid } from '@/server/lib/path-id';
import { CategoriesService } from '@/server/services/categories';
import { ChartersService } from '@/server/services/charters';
import { ServiceError } from '@/server/services/context';
import { CustomFieldsService } from '@/server/services/custom-fields';
import { InventoryService } from '@/server/services/inventory';
import { ItemGroupingService } from '@/server/services/item-grouping';
import { LocationsService } from '@/server/services/locations';
import { SuppliersService } from '@/server/services/suppliers';
import { TagsService } from '@/server/services/tags';
import { WarehousesService } from '@/server/services/warehouses';
import { WarehouseChartersService } from '@/server/services/warehouse-charters';

import { can, resolveTerminology } from '@stockpilot/core';

// A tab title of its own (CONFLICTS D16): a fixed word, as the record pages
// have, so the title costs no read of its own.
export const metadata: Metadata = { title: 'Edit item' };

/** The page area (DESIGN-SPEC 4 and 5.3), the same box every redesigned page
 *  draws; a form keeps to a reading width inside it. */
const PAGE = 'mx-auto flex w-full max-w-[1320px] flex-col gap-4 px-4 pb-16 pt-6 sm:px-8 sm:pt-7';
const FORM_WIDTH = 'w-full max-w-[960px]';

export default async function EditItemPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ return?: string }>;
}) {
  const { id } = await params;
  // A malformed id (a mistyped or cut-off link) is Page not found before
  // anything is read with it, and before the items:update redirect (B63).
  notFoundUnlessUuid(id);
  const { return: returnParam } = await searchParams;
  const ctx = await requireOrgContext();
  // Viewers (or any role without items:update) can't edit existing items.
  // Bounce them back to the detail page instead of letting them see the
  // form. The service layer also throws on submit; this just avoids
  // wasting their time.
  if (!can(ctx, 'items:update')) {
    redirect(`/dashboard/inventory/${id}`);
  }
  const supabase = await createClient();

  const [
    inventorySvc,
    categoriesSvc,
    locationsSvc,
    suppliersSvc,
    tagsSvc,
    warehousesSvc,
    chartersSvc,
    whChartersSvc,
    customFieldsSvc,
    forced,
    orgRow,
  ] = await Promise.all([
    InventoryService.forCurrentUser(),
    CategoriesService.forCurrentUser(),
    LocationsService.forCurrentUser(),
    SuppliersService.forCurrentUser(),
    TagsService.forCurrentUser(),
    WarehousesService.forCurrentUser(),
    ChartersService.forCurrentUser(),
    WarehouseChartersService.forCurrentUser(),
    CustomFieldsService.forCurrentUser(),
    forcedWarehouseId(),
    supabase
      .from('organizations')
      .select('terminology')
      .eq('id', ctx.organizationId)
      .maybeSingle(),
  ]);

  let item;
  try {
    item = await inventorySvc.get(id);
  } catch (e) {
    if (e instanceof ServiceError && e.code === 'not_found') notFound();
    throw e;
  }

  // Ungroup (0399): how many OTHER records the editor can see share this
  // record's SKU, for the form's banner (saving a shared field changes them
  // all). Its own read, off the critical path; a failed read says nothing.
  const skuSiblingsRead = ItemGroupingService.forCurrentUser()
    .then((svc) => svc.countSkuSiblings(id, (item.sku as string | null) ?? null))
    .catch(() => null);

  const [
    categories,
    locations,
    suppliers,
    tags,
    itemTags,
    warehouses,
    charters,
    warehouseCharters,
    customFieldDefs,
  ] = await Promise.all([
    categoriesSvc.list(),
    locationsSvc.list({ sitesOnly: true }),
    suppliersSvc.listForLookups(),
    tagsSvc.list(),
    tagsSvc.listForItem(id),
    warehousesSvc.listNames(),
    chartersSvc.list(),
    whChartersSvc.listPairs(),
    customFieldsSvc.listDefinitions('item'),
  ]);

  const { enabled: lotSerialEnabled } = await checkModuleAccess('lot_serial');
  const skuSiblings = await skuSiblingsRead;

  const terminology = resolveTerminology(
    (orgRow.data?.terminology as Partial<{
      charter_singular: string;
      warehouse_singular: string;
    }> | null) ?? null,
  );

  // backHref is the target for both the breadcrumb back-link and the
  // post-save navigation in ItemForm. Because we always resolve to a
  // non-empty value (the detail page is the fallback), ItemForm's
  // `router.refresh()` branch is never reached from this page —
  // post-save on the edit page always navigates somewhere, which is
  // the intended UX: the user gets a visible confirmation by landing
  // on the detail page or the list they came from.
  const backHref = safeReturnPath(returnParam) ?? `/dashboard/inventory/${id}`;

  return (
    <div className={PAGE}>
      <PageHeader
        className={FORM_WIDTH}
        back={<PageHeaderBackLink href={backHref}>← Back to item</PageHeaderBackLink>}
        title="Edit item"
      />
      {/* One form card at a reading width (the shared form pattern), titled
          with the record's name. */}
      <section
        aria-labelledby="edit-record-name"
        className={`border-border bg-card text-card-foreground rounded-lg border ${FORM_WIDTH}`}
      >
        <div className="border-border border-b px-[18px] py-3.5">
          <h2
            id="edit-record-name"
            className="text-[13.5px] font-medium leading-5 [overflow-wrap:anywhere]"
          >
            {item.name as string}
          </h2>
        </div>
        <div className="p-[18px]">
          <ItemForm
            defaults={{
              id,
              name: item.name as string,
              sku: item.sku as string,
              barcode: (item.barcode as string | null) ?? '',
              modelNumber: (item.model_number as string | null) ?? '',
              description: (item.description as string | null) ?? '',
              categoryId: (item.category_id as string | null) ?? null,
              supplierId: (item.supplier_id as string | null) ?? null,
              primaryLocationId: (item.primary_location_id as string | null) ?? null,
              warehouseId: (item.warehouse_id as string | null) ?? null,
              charterId: (item.charter_id as string | null) ?? null,
              unitCost: item.unit_cost as number,
              retailPrice: item.retail_price as number,
              quantityOnHand: item.quantity_on_hand as number,
              reorderPoint: item.reorder_point as number,
              reorderQuantity: item.reorder_quantity as number,
              unitOfMeasure: item.unit_of_measure as string,
              binLocation: (item.bin_location as string | null) ?? '',
              trackingType:
                ((item.tracking_type as
                  | 'none'
                  | 'lot'
                  | 'serial'
                  | 'serial_optional'
                  | null
                  | undefined) ?? 'none') as
                  | 'none'
                  | 'lot'
                  | 'serial'
                  | 'serial_optional',
              shelfLifeDays: (item.shelf_life_days as number | null | undefined) ?? null,
              expiryPolicy:
                ((item.expiry_policy as 'none' | 'warn' | 'block' | null | undefined) ?? 'warn') as
                  | 'none'
                  | 'warn'
                  | 'block',
              status: item.status as 'active' | 'archived' | 'discontinued',
              customFields: (item.custom_fields as Record<string, unknown>) ?? {},
              // The row's OWN size. Migration 0303 backfilled variant_size onto
              // every historical sized item, and InventoryService.update()
              // dual-writes variant_size + custom_fields.size and recomputes
              // variant_key — but with this default missing the form seeded ''
              // for every edit, zod's emptyToUndefined dropped it from the
              // patch, and the whole dual-write was unreachable from the only
              // web surface that edits one item. `variantSizeOriginal` is
              // deliberately NOT threaded: it is the VERBATIM source record
              // (0298), and update() only re-records it when the size actually
              // moves, so re-submitting an unchanged size cannot normalize the
              // audit trail away.
              variantSize: (item.variant_size as string | null) ?? '',
              // Carry the row's actual item_type into the form so a
              // book that lands on the inventory edit URL still shows
              // the book-specific fields (ISBN label, grade, rack,
              // crate, author). Bug fix 2026-05-06.
              itemType:
                ((item.item_type as 'product' | 'book' | 'asset' | 'consumable' | null | undefined) ??
                  'product') as 'product' | 'book' | 'asset' | 'consumable',
            }}
            categories={categories.map((c) => ({
              id: c.id as string,
              name: c.name as string,
              supports_sizes: Boolean(c.supports_sizes),
            }))}
            locations={locations.map((l) => ({ id: l.id as string, name: l.name as string }))}
            suppliers={suppliers.map((s) => ({ id: s.id as string, name: s.name as string }))}
            tags={tags.map((t) => ({ id: t.id, name: t.name, color: t.color }))}
            initialTagIds={itemTags.map((t) => t.id)}
            warehouses={warehouses.map((w) => ({ id: w.id, name: w.name }))}
            charters={charters.map((c) => ({ id: c.id, name: c.name }))}
            warehouseCharters={warehouseCharters}
            forcedWarehouseId={forced}
            warehouseLabel={terminology.warehouse_singular}
            charterLabel={terminology.charter_singular}
            returnHref={backHref}
            customFieldDefs={customFieldDefs}
            lotSerialEnabled={lotSerialEnabled}
            canManagePublicVisibility={can(ctx, 'public_links:manage')}
            sharedSkuOthers={skuSiblings ?? 0}
            sharedSkuKeeps={
              (item as { is_bundle?: boolean | null }).is_bundle === true
                ? 'kit'
                : (item as { group_id?: string | null }).group_id != null
                  ? 'family'
                  : null
            }
            itemPageHref={`/dashboard/inventory/${id}`}
            initialPublicVisibility={
              ((item as { public_visibility?: string | null }).public_visibility ??
                'internal_only') as 'internal_only' | 'public' | 'hidden'
            }
            initialPublicDisplayName={
              (item as { public_display_name?: string | null }).public_display_name ?? null
            }
            initialPublicDescription={
              (item as { public_description?: string | null }).public_description ?? null
            }
          />
        </div>
      </section>
    </div>
  );
}
