import { unstable_cache } from 'next/cache';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { OrdersStorefront } from '@/components/orders/storefront/orders-storefront';
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

  const [items, chartersForWarehouse] = await Promise.all([
    loadCatalogItems(ctx.organizationId, warehouseId, ctx.userId),
    loadChartersForWarehouse(warehouseId),
  ]);
  const aisles = buildAisles(items);

  // The storefront owns its own page head (back link, H1, flow
  // indicator) and dark-scoped frame — no dashboard container here.
  // Viewer identity for the "Requesting for → Myself" cell comes from
  // requireOrgContext, which already reads user_profiles
  // (full_name/email) in this same request.
  return (
    <OrdersStorefront
      warehouses={warehouses}
      warehouseId={warehouseId}
      items={items}
      aisles={aisles}
      chartersForWarehouse={chartersForWarehouse}
      viewerRole={ctx.role}
      viewerName={ctx.fullName}
      viewerEmail={ctx.email}
    />
  );
}

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
 * Wrapped in unstable_cache (30s TTL, keyed by orgId + warehouseId +
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
  { revalidate: 30, tags: ['orders-new-v2-catalog'] },
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

  // Reservations + category names + charter names + primary-image rows
  // in parallel. Thumbnail URLs ARE embedded server-side now: the
  // signers in item-images.ts are unstable_cache'd per path for 25
  // days, so after first population this is a warm cache read — not
  // the per-request signing burst that originally motivated the
  // deferred /api/orders/catalog-thumbnails fetch (which left cards
  // photo-less for ~10s on cold loads). This loader is itself
  // unstable_cache'd (30s) and the signed URLs stay valid for 30 days,
  // so embedding them in the cached payload is safe. LQIP blurs still
  // ship inline as instant placeholders while the real thumbs download.
  const [rsRes, categoriesRes, chartersRes, imagesRes] = await Promise.all([
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
    supabase
      .from('item_images')
      .select('item_id, lqip, thumb_path, storage_path, is_primary, sort_order')
      .eq('organization_id', organizationId)
      .in('item_id', itemIds)
      .order('is_primary', { ascending: false })
      .order('sort_order', { ascending: true }),
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

  // Pick one image row per item (the query is_primary DESC + sort_order
  // ASC so the first row per item is the canonical primary image). The
  // row carries the lqip blur (may be null) plus the storage paths for
  // server-side thumbnail signing.
  const imageRowByItem = new Map<
    string,
    { lqip: string | null; thumbPath: string | null; storagePath: string | null }
  >();
  for (const row of (imagesRes.data ?? []) as Array<{
    item_id: string;
    lqip: string | null;
    thumb_path: string | null;
    storage_path: string | null;
  }>) {
    if (!imageRowByItem.has(row.item_id)) {
      imageRowByItem.set(row.item_id, {
        lqip: row.lqip ?? null,
        thumbPath: row.thumb_path ?? null,
        storagePath: row.storage_path ?? null,
      });
    }
  }

  // Resolve one thumbnail URL per item with an image. The signers are
  // 25-day-cached per path, so this fan-out is memoized after the
  // first population.
  const thumbUrlByItem = new Map<string, string | null>();
  await Promise.all(
    [...imageRowByItem.entries()].map(async ([itemId, row]) => {
      thumbUrlByItem.set(
        itemId,
        await cachedCatalogThumbUrl(row.storagePath, row.thumbPath),
      );
    }),
  );

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
    // Server-resolved via the 25-day cached signers (see fan-out above).
    imageUrl: thumbUrlByItem.get(it.id) ?? null,
    lqip: imageRowByItem.get(it.id)?.lqip ?? null,
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
