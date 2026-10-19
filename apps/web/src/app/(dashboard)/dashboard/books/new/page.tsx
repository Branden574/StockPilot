import type { Metadata } from 'next';
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

import { can, resolveTerminology } from '@stockpilot/core';

// A tab title of its own (CONFLICTS D16): the page used to inherit the
// dashboard's.
export const metadata: Metadata = { title: 'New book' };

/** The page area (DESIGN-SPEC 4 and 5.3), the same box every redesigned page
 *  draws; a form keeps to a reading width inside it. */
const PAGE = 'mx-auto flex w-full max-w-[1320px] flex-col gap-4 px-4 pb-16 pt-6 sm:px-8 sm:pt-7';
const FORM_WIDTH = 'w-full max-w-[960px]';

/** The longest ISBN the item schema takes (its barcode field). */
const ISBN_MAX = 128;

/**
 * The ISBN a link hands this page (`?isbn=`, the Books scan shortcut's "Create
 * new book" when a scanned ISBN has no match): trimmed, and dropped when it is
 * blank, repeated or longer than the field takes. CONFLICTS D3: the shortcut
 * sent it and the page never read it, so the person typed it in again. Kept in
 * this file (not exported: a page may export only what Next reads).
 */
function isbnFromSearchParam(raw: string | string[] | undefined): string {
  if (typeof raw !== 'string') return '';
  const isbn = raw.trim();
  return isbn.length > 0 && isbn.length <= ISBN_MAX ? isbn : '';
}

export default async function NewBookPage({
  searchParams,
}: {
  searchParams: Promise<{ isbn?: string | string[] }>;
}) {
  const ctx = await requireOrgContext();
  // Same server-side gate as /dashboard/inventory/new. Viewers and
  // any other role without items:create get bounced back to the books
  // list instead of seeing an empty form they can't submit.
  if (!can(ctx, 'items:create')) {
    redirect('/dashboard/books');
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
    supabase
      .from('organizations')
      .select('terminology')
      .eq('id', ctx.organizationId)
      .maybeSingle(),
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
  ] = await Promise.all([
    categoriesSvc.list(),
    locationsSvc.list({ sitesOnly: true }),
    suppliersSvc.listForLookups(),
    tagsSvc.list(),
    warehousesSvc.listNames(),
    chartersSvc.list(),
    whChartersSvc.listPairs(),
    // Default warehouse + primary location to the user's most-recent
    // book so the form pre-fills the picker. Scoped to itemType='book'
    // so this doesn't bleed defaults from the products tab.
    inventorySvc.getRecentDefaults('book'),
    customFieldsSvc.listDefinitions('item'),
  ]);

  const { enabled: lotSerialEnabled } = await checkModuleAccess('lot_serial');

  // Same defaults resolution as /dashboard/inventory/new — see that
  // file for the precedence rationale.
  const warehouseIds = new Set(warehouses.map((w) => w.id));
  const locationIds = new Set(locations.map((l) => l.id));
  const defaultWarehouseId =
    forced ??
    (activeFilter && warehouseIds.has(activeFilter) ? activeFilter : null) ??
    (recent?.warehouseId && warehouseIds.has(recent.warehouseId)
      ? recent.warehouseId
      : null);
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

  const isbn = isbnFromSearchParam((await searchParams).isbn);

  return (
    <div className={PAGE}>
      <PageHeader
        className={FORM_WIDTH}
        back={<PageHeaderBackLink href="/dashboard/books">← Back to books</PageHeaderBackLink>}
        title="New book"
        subline="Books are tracked alongside regular inventory but live on their own tab. Title, ISBN, author, qty."
      />
      {/* One form card at a reading width (the shared form pattern). */}
      <section
        aria-labelledby="new-book-details"
        className={`border-border bg-card text-card-foreground rounded-lg border ${FORM_WIDTH}`}
      >
        <div className="border-border border-b px-[18px] py-3.5">
          <h2 id="new-book-details" className="text-[13.5px] font-medium leading-5">
            Book details
          </h2>
        </div>
        <div className="p-[18px]">
          <ItemForm
            itemType="book"
            defaults={{
              warehouseId: defaultWarehouseId,
              primaryLocationId: defaultPrimaryLocationId,
              // The scanned ISBN, when a link brought one (CONFLICTS D3).
              ...(isbn ? { barcode: isbn } : {}),
            }}
            categories={categories.map((c) => ({ id: c.id as string, name: c.name as string }))}
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
