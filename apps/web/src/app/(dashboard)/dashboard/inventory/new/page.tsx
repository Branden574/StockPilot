import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { ItemForm } from '@/components/inventory/item-form';
import { PageHeader, PageHeaderBackLink } from '@/components/patterns/page-header';
import { forcedWarehouseId } from '@/lib/auth/warehouse';
import { requireOrgContext } from '@/lib/auth/session';
import { checkModuleAccess } from '@/lib/modules/module-gate';
import { createClient } from '@/lib/supabase/server';
import { getActiveWarehouseFilter } from '@/lib/warehouse-filter';
import { CategoriesService } from '@/server/services/categories';
import { ChartersService } from '@/server/services/charters';
import { CustomFieldsService } from '@/server/services/custom-fields';
import { InventoryService } from '@/server/services/inventory';
import { LocationsService } from '@/server/services/locations';
import { SuppliersService } from '@/server/services/suppliers';
import { TagsService } from '@/server/services/tags';
import { WarehousesService } from '@/server/services/warehouses';
import { WarehouseChartersService } from '@/server/services/warehouse-charters';

import { can, resolveTerminology, type TrackingMode } from '@stockpilot/core';
import { PageTour } from '@/components/onboarding/page-tour';
import { NEW_ITEM_TOUR } from '@/lib/onboarding/tours';

// A tab title of its own (CONFLICTS D16): the page used to inherit the
// dashboard's.
export const metadata: Metadata = { title: 'New item' };

/** The page area (DESIGN-SPEC 4 and 5.3), the same box every redesigned page
 *  draws; a form keeps to a reading width inside it. */
const PAGE = 'mx-auto flex w-full max-w-[1320px] flex-col gap-4 px-4 pb-16 pt-6 sm:px-8 sm:pt-7';
const FORM_WIDTH = 'w-full max-w-[960px]';

export default async function NewItemPage() {
  const ctx = await requireOrgContext();
  // Server-side gate: a viewer (or any role without items:create) typing
  // /dashboard/inventory/new directly into the URL bar still bounces to
  // the inventory list. Service-layer `assertPermission` also blocks
  // submit, but redirecting here means they never see the form to
  // begin with.
  if (!can(ctx, 'items:create')) {
    redirect('/dashboard/inventory');
  }
  const supabase = await createClient();

  const [
    categoriesSvc,
    locationsSvc,
    suppliersSvc,
    tagsSvc,
    warehousesSvc,
    chartersSvc,
    whChartersSvc,
    inventorySvc,
    customFieldsSvc,
    forced,
    activeFilter,
    orgRow,
  ] = await Promise.all([
    CategoriesService.forCurrentUser(),
    LocationsService.forCurrentUser(),
    SuppliersService.forCurrentUser(),
    TagsService.forCurrentUser(),
    WarehousesService.forCurrentUser(),
    ChartersService.forCurrentUser(),
    WarehouseChartersService.forCurrentUser(),
    InventoryService.forCurrentUser(),
    CustomFieldsService.forCurrentUser(),
    forcedWarehouseId(),
    getActiveWarehouseFilter(),
    supabase.from('organizations').select('terminology').eq('id', ctx.organizationId).maybeSingle(),
  ]);

  const [
    categories,
    locations,
    suppliers,
    tags,
    warehouses,
    charters,
    warehouseCharters,
    recent,
    customFieldDefs,
    sizeScaleValueRows,
    sizeScaleRows,
  ] = await Promise.all([
    categoriesSvc.list(),
    locationsSvc.list({ sitesOnly: true }),
    suppliersSvc.listForLookups(),
    tagsSvc.list(),
    warehousesSvc.listNames(),
    chartersSvc.list(),
    whChartersSvc.listPairs(),
    // Default warehouse + primary location to the user's most-recent
    // item so the form pre-fills the picker for users who always add
    // to the same warehouse. Scoped to product items (the books tab
    // has its own page + scoped lookup).
    inventorySvc.getRecentDefaults('product'),
    customFieldsSvc.listDefinitions('item'),
    // Sports Task 11: every size_scale_values row this user can see (system
    // scales + this org's own, per RLS) — a small, cheap read (a few hundred
    // rows at most) grouped client-side into the form's `sizeScales` prop.
    supabase
      .from('size_scale_values')
      .select('size_scale_id, value, is_half')
      .order('size_scale_id', { ascending: true })
      .order('sort_order', { ascending: true }),
    // Each scale's size system (US_MENS for a shoe scale, none for apparel).
    // The server fills an omitted size system from the category's scale, so
    // the form needs it to know whether "Size system" still has to be picked.
    // Same RLS scope as the values above; a handful of rows.
    supabase.from('size_scales').select('id, size_system'),
  ]);

  const { enabled: lotSerialEnabled } = await checkModuleAccess('lot_serial');
  const { enabled: sportsEnabled } = await checkModuleAccess('sports');

  // A failed read leaves this EMPTY, which the form reads as "unknown": it
  // then leaves the size-system check to the server rather than asking more.
  const sizeScaleSystems: Record<string, string | null> = {};
  for (const row of sizeScaleRows.data ?? []) {
    sizeScaleSystems[row.id as string] = (row.size_system as string | null) ?? null;
  }

  const sizeScales: Record<string, Array<{ value: string; isHalf: boolean }>> = {};
  for (const row of sizeScaleValueRows.data ?? []) {
    const key = row.size_scale_id as string;
    (sizeScales[key] ??= []).push({
      value: row.value as string,
      isHalf: Boolean(row.is_half),
    });
  }

  // Resolve effective defaults. Precedence:
  //   1. forcedWarehouseId — warehouse-scoped users are locked here.
  //   2. activeFilter — manager/admin sidebar warehouse dropdown.
  //   3. recent.warehouseId — most-recent product this user created.
  //   4. null — show the placeholder.
  const warehouseIds = new Set(warehouses.map((w) => w.id));
  const locationIds = new Set(locations.map((l) => l.id));
  const defaultWarehouseId =
    forced ??
    (activeFilter && warehouseIds.has(activeFilter) ? activeFilter : null) ??
    (recent?.warehouseId && warehouseIds.has(recent.warehouseId) ? recent.warehouseId : null);
  // Only carry the recent primary location forward when its parent
  // warehouse matches the chosen default — picking a bin in another
  // warehouse would just confuse the user.
  const defaultPrimaryLocationId =
    recent?.primaryLocationId &&
    locationIds.has(recent.primaryLocationId) &&
    recent.warehouseId === defaultWarehouseId
      ? recent.primaryLocationId
      : null;

  const terminology = resolveTerminology(
    (orgRow.data?.terminology as Partial<{
      charter_singular: string;
      warehouse_singular: string;
    }> | null) ?? null,
  );

  const canImport = can(ctx, 'items:import');

  return (
    <div className={PAGE}>
      <PageHeader
        className={FORM_WIDTH}
        back={
          <PageHeaderBackLink href="/dashboard/inventory">← Back to inventory</PageHeaderBackLink>
        }
        title="New item"
        // CONFLICTS D7: the old line still promised CSV import "in Phase 5";
        // the import has shipped, so the line points to it for anyone the
        // import page lets in (it redirects without items:import).
        subline={
          <>
            Add a single item.
            {canImport ? (
              <>
                {' To add many at once, '}
                <Link
                  href="/dashboard/inventory/import"
                  className="text-foreground hover:text-accent underline underline-offset-2"
                >
                  import a CSV
                </Link>
                .
              </>
            ) : null}
          </>
        }
        tour={<PageTour tour={NEW_ITEM_TOUR} />}
      />
      {/* One form card at a reading width (the shared form pattern). */}
      <section
        aria-labelledby="new-item-details"
        className={`border-border bg-card text-card-foreground rounded-lg border ${FORM_WIDTH}`}
      >
        <div className="border-border border-b px-[18px] py-3.5">
          <h2 id="new-item-details" className="text-[13.5px] font-medium leading-5">
            Item details
          </h2>
        </div>
        <div className="p-[18px]">
          <ItemForm
            defaults={{
              warehouseId: defaultWarehouseId,
              primaryLocationId: defaultPrimaryLocationId,
            }}
            categories={categories.map((c) => ({
              id: c.id as string,
              name: c.name as string,
              supports_sizes: Boolean(c.supports_sizes),
              parent_id: (c.parent_id as string | null) ?? null,
              tracking_mode: (c.tracking_mode as TrackingMode | null) ?? null,
              sports_subcategory_key: (c.sports_subcategory_key as string | null) ?? null,
              default_unit_of_measure: (c.default_unit_of_measure as string | null) ?? null,
              size_scale_id: (c.size_scale_id as string | null) ?? null,
              // A custom subcategory's own profile; the form reads it through
              // the server's rule (core resolveSubcategoryProfile).
              tracking_profile: c.tracking_profile ?? null,
            }))}
            sizeScales={sizeScales}
            sizeScaleSystems={sizeScaleSystems}
            sportsEnabled={sportsEnabled}
            // Gates the tracking-mode override control only. The server
            // re-checks `sports:manage` on every save (resolveModeOverride).
            canManageSports={can(ctx, 'sports:manage')}
            locations={locations.map((l) => ({ id: l.id as string, name: l.name as string }))}
            suppliers={suppliers.map((s) => ({ id: s.id as string, name: s.name as string }))}
            tags={tags.map((t) => ({ id: t.id, name: t.name, color: t.color }))}
            warehouses={warehouses.map((w) => ({ id: w.id, name: w.name }))}
            charters={charters.map((c) => ({ id: c.id, name: c.name }))}
            warehouseCharters={warehouseCharters}
            forcedWarehouseId={forced}
            warehouseLabel={terminology.warehouse_singular}
            charterLabel={terminology.charter_singular}
            customFieldDefs={customFieldDefs}
            lotSerialEnabled={lotSerialEnabled}
          />
        </div>
      </section>
    </div>
  );
}
