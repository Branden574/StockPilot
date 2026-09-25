import Link from 'next/link';
import { redirect } from 'next/navigation';

import { RentalCreateForm } from '@/components/rentals/rental-create-form';
import type { AisleSummary, CatalogItem } from '@/components/orders/v2/types';
import { requireOrgContext } from '@/lib/auth/session';
import { createAdminClient } from '@/lib/supabase/admin';
import {
  loadCatalogThumbMapCached,
  type CatalogItemMedia,
} from '@/server/loaders/orders-new-catalog';
import { InventoryService } from '@/server/services/inventory';
import { fetchAllRowsByIds, reportDegradedRead } from '@/server/services/lib/fetch-by-ids';
import { RentalsService } from '@/server/services/rentals';
import { WarehousesService } from '@/server/services/warehouses';
import { fetchRackHoldingsByItem } from '@/server/services/rack-holdings';
import { can, resolvePlacement } from '@stockpilot/core';

/**
 * An external book cover kept on the item (bulk-imported books have no
 * item_images row). The same rule ItemImagesService.primaryMasterUrlsForItems
 * applies when the deferred photo request resolves one.
 */
function coverUrlFrom(customFields: Record<string, unknown> | null): string | null {
  const url = customFields?.thumbnail_url;
  return typeof url === 'string' && url.length > 0 && url.length < 2000 ? url : null;
}

function buildAisles(items: CatalogItem[]): AisleSummary[] {
  const byId = new Map<string | null, { name: string; count: number }>();
  for (const it of items) {
    const key = it.categoryId ?? null;
    const name = it.categoryName ?? 'Uncategorized';
    const existing = byId.get(key);
    if (existing) {
      existing.count++;
    } else {
      byId.set(key, { name, count: 1 });
    }
  }

  const named: AisleSummary[] = [];
  let uncat: AisleSummary | null = null;

  for (const [id, { name, count }] of byId.entries()) {
    if (id === null) {
      uncat = { id: null, name: 'Uncategorized', itemCount: count };
    } else {
      named.push({ id, name, itemCount: count });
    }
  }

  named.sort((a, b) => a.name.localeCompare(b.name));
  return uncat ? [...named, uncat] : named;
}

export default async function NewRentalPage({
  searchParams,
}: {
  searchParams: Promise<{ warehouseId?: string }>;
}) {
  const ctx = await requireOrgContext();
  if (!can(ctx, 'rentals:create')) {
    redirect('/dashboard/rentals');
  }

  const params = await searchParams;

  const [warehousesSvc, rentalsSvc] = await Promise.all([
    WarehousesService.forCurrentUser(),
    RentalsService.forCurrentUser(),
  ]);

  const warehouses = (await warehousesSvc.listNames()).map((w) => ({
    id: w.id,
    name: w.name,
  }));

  if (warehouses.length === 0) {
    return (
      <div className="container mx-auto max-w-3xl px-4 py-8 sm:px-6">
        <div className="mb-6">
          <Link href="/dashboard/rentals" className="text-muted-foreground hover:text-foreground text-sm">
            ← Back to rentals
          </Link>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">New rental</h1>
        </div>
        <div className="bg-card rounded-xl border p-6 text-sm text-muted-foreground">
          No active warehouses are configured. Ask an admin to add one.
        </div>
      </div>
    );
  }

  const requestedId = params.warehouseId;
  const fallbackId = warehouses[0]?.id ?? '';
  const warehouseId =
    warehouses.find((w) => w.id === requestedId)?.id ?? fallbackId;

  // Load rental items (is_rental=true) for the selected warehouse
  // We use the admin client here so we can do a direct .eq('is_rental', true) query
  // similar to how orders/new page loads its catalog.
  //
  // Three reads that need only the warehouse run together: the rental items,
  // the team members for the borrower picker, and the item PHOTOS.
  //
  // PHOTOS arrive in this page's HTML. They used to come only from a request
  // the browser made after the page loaded, and that request resolved a
  // signed URL for EVERY orderable item in the warehouse (up to 500) to show
  // a handful of rentals: about five seconds before any rental photo
  // appeared (L4L, 2026-09-25). The photos now come from the orders
  // storefront's warehouse thumbnail map (server/loaders/orders-new-catalog.ts):
  // one cached entry per warehouse, signed in ONE batched storage call and
  // not per item, kept warm by the prewarm cron for the busiest
  // organizations, and shared with the Orders page. A warm visit makes no
  // storage call at all. The map is up to 4 hours old and nothing refreshes it
  // when a photo changes, so the form's deferred request (rental items only)
  // reads the photos fresh and corrects any card whose photo was added,
  // replaced or removed since the map was built, or whose map failed.
  const supabase = createAdminClient();
  const [
    { data: rentalItemsData, error: rentalItemsError },
    mediaByItemId,
    members,
  ] = await Promise.all([
    supabase
      .from('inventory_items')
      .select(
        'id, name, sku, quantity_on_hand, warehouse_id, item_type, custom_fields, bin_location, category_id, retail_price, unit_cost, reorder_point',
      )
      .eq('organization_id', ctx.organizationId)
      .eq('warehouse_id', warehouseId)
      .eq('status', 'active')
      .eq('is_rental', true)
      .is('deleted_at', null)
      .order('name', { ascending: true })
      .limit(500),
    // A failed map is not cached (the loader throws); this visit shows the
    // cards without photos and the form's deferred request fills them.
    loadCatalogThumbMapCached(ctx.organizationId, warehouseId).catch((err: unknown) => {
      console.warn(
        `[rentals/new] thumb map unavailable: ${err instanceof Error ? err.message : String(err)}`,
      );
      return {} as Record<string, CatalogItemMedia>;
    }),
    // The borrower picker's team members: the same query the phone's picker
    // reads through GET /api/v1/rentals/borrowers (accepted members only, the
    // ones create_rental accepts).
    rentalsSvc.listBorrowerMembers(),
  ]);
  // An ignored error here was an empty catalog: "no rental items" for a
  // warehouse that has them. The error boundary offers a retry instead.
  if (rentalItemsError) {
    throw new Error(`[rentals/new] rental items read failed: ${rentalItemsError.message}`);
  }

  // Get reservations for these items
  const rentalItemIds = ((rentalItemsData ?? []) as Array<{ id: string }>).map((r) => r.id);

  // Category names are labels only: a failed batch shows the aisles as
  // uncategorized, reported, rather than failing the page.
  const categoryIds = [
    ...new Set(
      ((rentalItemsData ?? []) as Array<{ category_id: string | null }>)
        .map((r) => r.category_id)
        .filter(Boolean) as string[],
    ),
  ];

  // The three reads below need only the item ids, so they run together
  // rather than one after another (each is its own trip to the database).
  const [rackHoldingsByItemId, reservedByItem, categoryNames] = await Promise.all([
    // Rack/crate HOLDINGS for the catalog, scoped to the warehouse the page is
    // showing. WHERE THE STOCK IS, as against what each row's custom_fields
    // remember — without this the card label preferred the item's rack pair
    // over everything, and a put-away into a position-less crate (mig 0335)
    // leaves that pair naming the rack the stock has left.
    fetchRackHoldingsByItem(
      { supabase, organizationId: ctx.organizationId },
      rentalItemIds,
      warehouseId,
    ),
    // Reservations decide what is available to rent. Up to 500 items: one
    // `.in()` of them all fails past ~215 locally and ~395 in production, and
    // with its error ignored that was "nothing reserved", so an item already
    // out on another rental looked available. The service batches and pages
    // the read and THROWS on a failed batch. (Every org member can read the
    // org's reservations, so the caller's own client sees what the admin
    // client did.)
    InventoryService.forCurrentUser().then((svc) =>
      svc.reservedQuantityByItemIds(rentalItemIds),
    ),
    fetchAllRowsByIds<{ id: string; name: string }>(
      categoryIds,
      (batch) => (from, to) =>
        supabase
          .from('categories')
          .select('id, name')
          .eq('organization_id', ctx.organizationId)
          .in('id', batch)
          .order('id', { ascending: true })
          .range(from, to),
    ).then(
      (cats) => new Map(cats.map((c) => [c.id, c.name])),
      (err: unknown) => {
        reportDegradedRead('rentals.new.category_names', err, { categories: categoryIds.length });
        return new Map<string, string>();
      },
    ),
  ]);

  const items: CatalogItem[] = ((rentalItemsData ?? []) as Array<{
    id: string;
    name: string;
    sku: string;
    quantity_on_hand: number;
    warehouse_id: string;
    item_type: string | null;
    custom_fields: Record<string, unknown> | null;
    bin_location: string | null;
    category_id: string | null;
    retail_price: number | null;
    unit_cost: number | null;
    reorder_point: number;
  }>).map((it) => {
    // The card's walk-to label. The rack pair used to be lifted off
    // custom_fields and preferred over bin_location right here — the exact
    // INVERSION of the sibling orders catalog loader (server/loaders/
    // orders-new-catalog.ts), and the reason this page could send someone to
    // rack 38-A for stock sitting in "Blue Shelf". The precedence is now
    // resolvePlacement's; this only picks the compact rendering the card has
    // room for (bare "38-A", not "Rack 38-A").
    const res = resolvePlacement({
      itemType: it.item_type,
      customFields: it.custom_fields,
      binLocation: it.bin_location,
      holdings: rackHoldingsByItemId.get(it.id),
    });
    const rackLabel =
      res.source === 'holdings'
        ? res.holdings.map((h) => h.name).sort((a, b) => a.localeCompare(b)).join(', ')
        : res.source === 'structured'
          ? res.rackLabel
          : res.source === 'bin'
            ? res.binLocation
            : null;
    const media = mediaByItemId[it.id];

    return {
      id: it.id,
      sku: it.sku,
      name: it.name,
      warehouseId: it.warehouse_id,
      quantityOnHand: it.quantity_on_hand,
      reservedQuantity: reservedByItem.get(it.id) ?? 0,
      itemType: it.item_type,
      categoryId: it.category_id,
      categoryName: it.category_id ? (categoryNames.get(it.category_id) ?? null) : null,
      // Rentals don't track charter assignment — they circulate across
      // every charter the warehouse services. Leave the charter
      // fields null so the item card hides the charter ribbon.
      charterId: null,
      charterName: null,
      charterCode: null,
      rackLabel,
      // The item's uploaded photo from the warehouse map, else its book
      // cover; the blur-up only while there is no photo URL (the storefront's
      // payload rule, loadCatalogBundle).
      imageUrl: media?.url ?? coverUrlFrom(it.custom_fields),
      lqip: media?.url ? null : (media?.lqip ?? null),
      price: it.retail_price ?? it.unit_cost ?? null,
      reorderPoint: it.reorder_point,
    };
  });

  const aisles = buildAisles(items);

  return (
    <div className="container mx-auto max-w-7xl px-4 py-8 sm:px-6">
      <div className="mb-6">
        <Link href="/dashboard/rentals" className="text-muted-foreground hover:text-foreground text-sm">
          ← Back to rentals
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">New rental</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Choose a borrower (a team member or anyone else), pick the items to check out,
          and set a return date.
        </p>
      </div>

      <RentalCreateForm
        warehouses={warehouses}
        warehouseId={warehouseId}
        items={items}
        aisles={aisles}
        members={members}
        viewerRole={ctx.role}
      />
    </div>
  );
}
