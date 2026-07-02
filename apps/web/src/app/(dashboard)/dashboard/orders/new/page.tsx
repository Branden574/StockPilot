import { unstable_cache } from 'next/cache';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { OrdersStorefront } from '@/components/orders/storefront/orders-storefront';
import type { StorefrontCatalogData } from '@/components/orders/storefront/orders-storefront';
import type { AisleSummary, CatalogItem } from '@/components/orders/v2/types';
import { can } from '@stockpilot/core';
import { requireOrgContext } from '@/lib/auth/session';
import { createAdminClient } from '@/lib/supabase/admin';
import { cachedCatalogThumbUrl } from '@/server/services/item-images';
import { WarehousesService } from '@/server/services/warehouses';

export default async function NewOrderPage({
  searchParams,
}: {
  searchParams: Promise<{ warehouseId?: string }>;
}) {
  const ctx = await requireOrgContext();
  if (!can(ctx, 'orders:request')) {
    redirect('/dashboard');
  }

  const params = await searchParams;
  const warehousesSvc = await WarehousesService.forCurrentUser();
  const warehouses = (await warehousesSvc.list()).map((w) => ({
    id: w.id,
    name: w.name,
  }));

  if (warehouses.length === 0) {
    return (
      <div className="container mx-auto max-w-3xl px-4 py-8 sm:px-6">
        <div className="mb-6">
          <Link
            href="/dashboard/orders"
            className="text-muted-foreground hover:text-foreground text-sm"
          >
            ← Back to orders
          </Link>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">
            Place an order
          </h1>
        </div>
        <div className="bg-card rounded-xl border p-6 text-sm text-muted-foreground">
          No active warehouses are configured. Ask an admin to add one before
          placing an order request.
        </div>
      </div>
    );
  }

  const requestedId = params.warehouseId;
  const fallbackId = warehouses[0]?.id;
  if (!fallbackId) {
    // Should be unreachable due to the empty-warehouses early return
    // above, but the type system doesn't know that.
    throw new Error('No warehouses available');
  }
  const warehouseId =
    warehouses.find((w) => w.id === requestedId)?.id ?? fallbackId;

  // STREAMING: the catalog bundle is deliberately NOT awaited. The
  // shell (head + setup bar) only needs warehouses/charters/viewer, so
  // it flushes immediately; the client suspends just the grid + cart
  // rail on this promise and React streams the resolved payload in.
  const catalogPromise = loadCatalogBundle(ctx.organizationId, warehouseId, ctx.userId);
  const chartersForWarehouse = await loadChartersForWarehouse(warehouseId);

  // The storefront owns its own page head (back link, H1, flow
  // indicator) and dark-scoped frame — no dashboard container here.
  // Viewer identity for the "Requesting for → Myself" cell comes from
  // requireOrgContext, which already reads user_profiles
  // (full_name/email) in this same request.
  return (
    <OrdersStorefront
      warehouses={warehouses}
      warehouseId={warehouseId}
      catalogPromise={catalogPromise}
      chartersForWarehouse={chartersForWarehouse}
      viewerRole={ctx.role}
      viewerName={ctx.fullName}
      viewerEmail={ctx.email}
    />
  );
}

/**
 * Catalog items + thumbnail media merged into the streamed payload.
 *
 * PAYLOAD DIET: an item that has a resolved thumbnail URL ships with
 * `lqip: null` — the blur-up only matters while no real image URL
 * exists, and 350 inline ~1-2KB base64 blurs were the single heaviest
 * chunk of the RSC payload (hundreds of KB serialized, parsed, and
 * hydrated on every visit). Items whose URL failed to sign keep their
 * lqip so cards still blur-up instead of flashing the glyph.
 */
async function loadCatalogBundle(
  organizationId: string,
  warehouseId: string,
  userId: string,
): Promise<StorefrontCatalogData> {
  const [items, mediaMap] = await Promise.all([
    loadCatalogItems(organizationId, warehouseId, userId),
    loadCatalogThumbMapCached(organizationId, warehouseId),
  ]);

  const merged = items.map((it) => {
    const media = mediaMap[it.id];
    if (!media) return it;
    return {
      ...it,
      imageUrl: media.url,
      lqip: media.url ? null : media.lqip,
    };
  });

  return { items: merged, aisles: buildAisles(merged) };
}

/**
 * Warehouse-scoped thumbnail-URL map, cached INDEPENDENTLY of the 30s
 * catalog loader. Signing ~350 URLs inside every catalog recompute
 * made one visitor per 30s window pay the whole fan-out in TTFB (~3s
 * skeleton). Decoupled cadences: stock stays fresh at 30s, the
 * expensive URL map recomputes at most every 4 hours — safe because
 * the signed URLs are 30-day valid and the per-path signers inside
 * cachedCatalogThumbUrl are themselves 25-day cached (so even the 4h
 * recompute is mostly warm reads). Thumbnails aren't access-scoped
 * (any org member who can open the picker may see product photos), so
 * no accessKey in the cache key.
 *
 * Also carries each item's LQIP blur: image rows change on the same
 * cadence as their thumbnails, so pulling the blurs out of the 30s
 * stock loader saves that loader an entire item_images query (~700KB
 * of base64 transfer per recompute for a 350-item catalog).
 */
interface CatalogItemMedia {
  url: string | null;
  lqip: string | null;
}

// v2 (FIX 5): value shape changed from Record<string, string> to
// Record<string, CatalogItemMedia> — key bumped so stale v1 entries
// can't be read as the new shape for up to 4h.
const loadCatalogThumbMapCached = unstable_cache(
  async (
    organizationId: string,
    warehouseId: string,
  ): Promise<Record<string, CatalogItemMedia>> => {
    const supabase = createAdminClient();
    // Mirror the catalog loader's item scoping with an inner join on
    // inventory_items so only this warehouse's images get signed.
    const { data } = await supabase
      .from('item_images')
      .select(
        'item_id, lqip, thumb_path, storage_path, is_primary, sort_order, item:inventory_items!inner(warehouse_id)',
      )
      .eq('organization_id', organizationId)
      .eq('item.warehouse_id', warehouseId)
      .order('is_primary', { ascending: false })
      .order('sort_order', { ascending: true });

    // First row per item wins (is_primary DESC + sort_order ASC).
    const rowByItem = new Map<
      string,
      { lqip: string | null; thumbPath: string | null; storagePath: string | null }
    >();
    for (const row of (data ?? []) as Array<{
      item_id: string;
      lqip: string | null;
      thumb_path: string | null;
      storage_path: string | null;
    }>) {
      if (!rowByItem.has(row.item_id)) {
        rowByItem.set(row.item_id, {
          lqip: row.lqip ?? null,
          thumbPath: row.thumb_path ?? null,
          storagePath: row.storage_path ?? null,
        });
      }
    }

    const media: Record<string, CatalogItemMedia> = {};
    await Promise.all(
      [...rowByItem.entries()].map(async ([itemId, row]) => {
        const url = await cachedCatalogThumbUrl(row.storagePath, row.thumbPath);
        if (url || row.lqip) media[itemId] = { url, lqip: row.lqip };
      }),
    );
    return media;
  },
  ['orders-new-thumbmap-v2'],
  { revalidate: 4 * 60 * 60, tags: ['orders-new-thumbmap'] },
);

/**
 * Charters per warehouse change rarely — cache for 5 minutes. Same
 * admin-client + page-perimeter argument as the catalog cache.
 */
const loadChartersForWarehouseCached = unstable_cache(
  async (
    warehouseId: string,
  ): Promise<Array<{ id: string; name: string; code: string | null }>> => {
    const supabase = createAdminClient();
    const { data: pairs } = await supabase
      .from('warehouse_charters')
      .select('charter:charters!inner (id, name, code, status)')
      .eq('warehouse_id', warehouseId);
    return (pairs ?? []).flatMap((p) => {
      const c = Array.isArray((p as { charter?: unknown }).charter)
        ? ((p as { charter: unknown[] }).charter[0] as Record<string, unknown>)
        : ((p as { charter: unknown }).charter as Record<string, unknown> | null);
      return c && (c.status as string) === 'active'
        ? [
            {
              id: c.id as string,
              name: c.name as string,
              code: (c.code as string | null) ?? null,
            },
          ]
        : [];
    });
  },
  ['orders-new-v2-charters-v1'],
  { revalidate: 300, tags: ['orders-new-v2-charters'] },
);

async function loadChartersForWarehouse(
  warehouseId: string,
): Promise<Array<{ id: string; name: string; code: string | null }>> {
  return loadChartersForWarehouseCached(warehouseId);
}

/**
 * Returns a stable string that uniquely identifies a user's
 * category-access pattern. Used as a cache-key component so a
 * restricted viewer's payload doesn't get served to other users
 * (or vice versa). Truth table mirrors
 * `user_can_see_item_category` from migration 0128:
 *
 *   role = manager/admin/owner/staff               → 'ALL'
 *   role = viewer + 0 grants                        → 'ALL' (unrestricted default)
 *   role = viewer + N grants                        → 'v:c1,c2,c3...' (sorted)
 *   no membership                                   → 'NONE'
 */
async function loadAccessibleCategoryKey(
  organizationId: string,
  userId: string,
): Promise<string> {
  const admin = createAdminClient();
  const { data: member } = await admin
    .from('organization_members')
    .select('role')
    .eq('user_id', userId)
    .eq('organization_id', organizationId)
    .maybeSingle();
  const role = (member as { role?: string } | null)?.role;
  if (!role) return 'NONE';
  if (role !== 'viewer') return 'ALL';

  const { data: rows } = await admin
    .from('user_category_assignments')
    .select('category_id')
    .eq('user_id', userId)
    .eq('organization_id', organizationId);
  const ids = ((rows ?? []) as Array<{ category_id: string }>)
    .map((r) => r.category_id)
    .sort();
  if (ids.length === 0) return 'ALL';
  return 'v:' + ids.join(',');
}

/**
 * Loads catalog items for the v2 picker. Returns CatalogItem[] with
 * everything the new card grid needs to render: thumbnail, price,
 * available-to-promise, rack label, category name. Bundles are
 * filtered out (phantom rows).
 *
 * Wrapped in unstable_cache (60s TTL, keyed by orgId + warehouseId +
 * accessKey). The accessKey is critical: without it a manager's
 * full-catalog payload would be served to a restricted viewer
 * hitting the same warehouse (RLS is bypassed in here because the
 * admin client is used to dodge cookies). Bumped to v2 prefix when
 * the access-key component was added — cold cache forced.
 *
 * Admin client is used inside the cache so the cached value doesn't
 * capture per-user cookies. The page-level perimeter (requireOrgContext
 * + warehousesSvc.list scoping) guarantees only warehouseIds the user
 * is authorized to see ever get passed in.
 *
 * TTL tradeoff (FIX 5): 30s → 60s halves the cache-miss rate for the
 * heaviest per-request work. The cost is availability numbers being up
 * to a minute stale on cards — acceptable because they're advisory:
 * the submit path re-validates against live stock/reservations, and
 * the cap warnings in the cart handle any drift.
 */
const loadCatalogItemsCached = unstable_cache(
  async (
    organizationId: string,
    warehouseId: string,
    accessKey: string,
  ): Promise<CatalogItem[]> => {
    return loadCatalogItemsUncached(organizationId, warehouseId, accessKey);
  },
  ['orders-new-v2-catalog-v2'],
  { revalidate: 60, tags: ['orders-new-v2-catalog'] },
);

async function loadCatalogItems(
  organizationId: string,
  warehouseId: string,
  userId: string,
): Promise<CatalogItem[]> {
  const accessKey = await loadAccessibleCategoryKey(organizationId, userId);
  return loadCatalogItemsCached(organizationId, warehouseId, accessKey);
}

async function loadCatalogItemsUncached(
  organizationId: string,
  warehouseId: string,
  accessKey: string,
): Promise<CatalogItem[]> {
  const supabase = createAdminClient();

  // Parse the allow-list (if any) from the access key. NONE = no
  // memberships, return empty payload defensively. ALL = unrestricted,
  // skip the filter entirely.
  let allowedCategoryIds: Set<string> | null = null;
  if (accessKey === 'NONE') return [];
  if (accessKey.startsWith('v:')) {
    allowedCategoryIds = new Set(accessKey.slice(2).split(',').filter(Boolean));
  }

  let itemsQuery = supabase
    .from('inventory_items')
    .select(
      'id, name, sku, quantity_on_hand, warehouse_id, item_type, is_bundle, custom_fields, bin_location, category_id, charter_id, retail_price, unit_cost, reorder_point',
    )
    .eq('organization_id', organizationId)
    .eq('warehouse_id', warehouseId)
    .eq('status', 'active')
    // Rental items (canopies, supplies for school events) are a
    // separate inventory class — they circulate via /dashboard/rentals,
    // not the order request flow. Never show them in the order picker.
    .eq('is_rental', false)
    .is('deleted_at', null)
    .or('is_bundle.is.null,is_bundle.eq.false')
    .order('name', { ascending: true })
    .limit(500);

  // Defense-in-depth: filter by the user's category allow-list at the
  // admin-client query level too. Restricted viewers never see
  // null-category items (matches the RLS truth table). Unrestricted
  // (ALL) callers skip this filter entirely.
  if (allowedCategoryIds !== null) {
    if (allowedCategoryIds.size === 0) return [];
    itemsQuery = itemsQuery.in('category_id', [...allowedCategoryIds]);
  }

  const { data: itemsData } = await itemsQuery;

  const items = (itemsData ?? []) as Array<{
    id: string;
    name: string;
    sku: string;
    quantity_on_hand: number;
    warehouse_id: string;
    item_type: string | null;
    custom_fields: Record<string, unknown> | null;
    bin_location: string | null;
    category_id: string | null;
    charter_id: string | null;
    retail_price: number | null;
    unit_cost: number | null;
    reorder_point: number | null;
  }>;
  if (items.length === 0) return [];

  const itemIds = items.map((i) => i.id);
  const categoryIds = [...new Set(items.map((i) => i.category_id).filter((v): v is string => Boolean(v)))];
  const charterIds = [...new Set(items.map((i) => i.charter_id).filter((v): v is string => Boolean(v)))];

  // Reservations + category names + charter names in parallel. NO
  // media work happens in here (FIX 5): thumbnail URL signing lived in
  // this loader briefly and put ~350 nested cache lookups in TTFB for
  // one visitor per cache window, and the LQIP query alone transferred
  // ~700KB of base64 per recompute. Both now come from
  // loadCatalogThumbMapCached (4h cadence) and are merged in the page
  // component — this loader is pure stock/catalog reads.
  const [rsRes, categoriesRes, chartersRes] = await Promise.all([
    supabase
      .from('stock_reservations')
      .select('item_id, quantity')
      .eq('organization_id', organizationId)
      .in('item_id', itemIds)
      .is('released_at', null),
    categoryIds.length > 0
      ? supabase
          .from('categories')
          .select('id, name')
          .eq('organization_id', organizationId)
          .in('id', categoryIds)
      : Promise.resolve({ data: [] as Array<{ id: string; name: string }> }),
    charterIds.length > 0
      ? supabase
          .from('charters')
          .select('id, name, code')
          .eq('organization_id', organizationId)
          .in('id', charterIds)
      : Promise.resolve({
          data: [] as Array<{ id: string; name: string; code: string | null }>,
        }),
  ]);

  const reservedByItem = new Map<string, number>();
  for (const row of (rsRes.data ?? []) as Array<{ item_id: string; quantity: number }>) {
    reservedByItem.set(
      row.item_id,
      (reservedByItem.get(row.item_id) ?? 0) + Number(row.quantity),
    );
  }

  const categoryNameById = new Map<string, string>();
  for (const c of (categoriesRes.data ?? []) as Array<{ id: string; name: string }>) {
    categoryNameById.set(c.id, c.name);
  }

  const charterById = new Map<string, { name: string; code: string | null }>();
  for (const c of (chartersRes.data ?? []) as Array<{
    id: string;
    name: string;
    code: string | null;
  }>) {
    charterById.set(c.id, { name: c.name, code: c.code ?? null });
  }

  function rackLabelFor(it: typeof items[number]): string | null {
    if (it.bin_location && it.bin_location.trim()) return it.bin_location.trim();
    const cf = it.custom_fields ?? {};
    const num = (it.item_type === 'book'
      ? (cf as { book_rack_number?: unknown }).book_rack_number
      : (cf as { rack_number?: unknown }).rack_number) as string | undefined;
    const row = (it.item_type === 'book'
      ? (cf as { book_rack_row?: unknown }).book_rack_row
      : (cf as { rack_row?: unknown }).rack_row) as string | undefined;
    if (!num) return null;
    return row ? `${num}-${row}` : String(num);
  }

  return items.map((it) => ({
    id: it.id,
    sku: it.sku,
    name: it.name,
    warehouseId: it.warehouse_id,
    quantityOnHand: Number(it.quantity_on_hand) || 0,
    reservedQuantity: reservedByItem.get(it.id) ?? 0,
    itemType: it.item_type ?? null,
    categoryId: it.category_id ?? null,
    categoryName: it.category_id ? categoryNameById.get(it.category_id) ?? null : null,
    charterId: it.charter_id ?? null,
    charterName: it.charter_id ? charterById.get(it.charter_id)?.name ?? null : null,
    charterCode: it.charter_id ? charterById.get(it.charter_id)?.code ?? null : null,
    rackLabel: rackLabelFor(it),
    // Both merged in loadCatalogBundle from loadCatalogThumbMapCached —
    // media lives on a 4h cadence, not this 60s stock loader.
    imageUrl: null,
    lqip: null,
    // Price: retail first, then cost, then null. The v2 picker shows
    // "—" for null, and the cart estimated total excludes them.
    price:
      typeof it.retail_price === 'number'
        ? it.retail_price
        : typeof it.unit_cost === 'number'
        ? it.unit_cost
        : null,
    reorderPoint: Number(it.reorder_point) || 0,
  }));
}

/**
 * Derives the aisle summary list from the loaded catalog items.
 * Named aisles are sorted alphabetically; the synthetic "Uncategorized"
 * bucket appears last if any items have no category.
 */
function buildAisles(items: CatalogItem[]): AisleSummary[] {
  const countById = new Map<string, number>();
  let uncategorizedCount = 0;
  const nameById = new Map<string, string>();

  for (const it of items) {
    if (it.categoryId === null) {
      uncategorizedCount++;
    } else {
      countById.set(it.categoryId, (countById.get(it.categoryId) ?? 0) + 1);
      if (it.categoryName) nameById.set(it.categoryId, it.categoryName);
    }
  }

  const named: AisleSummary[] = Array.from(countById.entries())
    .map(([id, itemCount]) => ({
      id,
      name: nameById.get(id) ?? id,
      itemCount,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (uncategorizedCount > 0) {
    named.push({ id: null, name: 'Uncategorized', itemCount: uncategorizedCount });
  }

  return named;
}
