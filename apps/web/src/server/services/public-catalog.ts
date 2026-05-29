import 'server-only';

import { unstable_cache } from 'next/cache';

import { createAdminClient } from '@/lib/supabase/admin';

import type { CatalogItem } from '@/components/orders/v2/types';

/**
 * Public, books-only catalog loader for the `/r/[token]` order page.
 *
 * Mirrors the staff-side loadCatalogItemsUncached but filtered to
 * `item_type='book'` and gated by the caller already having validated
 * the (token → org → warehouse) chain.
 *
 * What ships in the shaped result:
 *   - id / sku / name / quantityOnHand / reservedQuantity / itemType
 *   - categoryId + name, charterId + name + code, rackLabel
 *   - lqip blur for each card (so cards never flash a stark placeholder)
 *   - imageUrl: ALWAYS null. Signed thumbnail URLs are fetched after
 *     first paint by /api/v1/public/catalog-thumbnails so the LCP
 *     isn't gated on N signed-URL mints.
 *
 * CACHE STRATEGY
 * --------------
 * Wrapped in unstable_cache(60s revalidate). Customers browsing the
 * order form might see availability counts up to ~60s stale; the
 * order-submit endpoint (/api/v1/public/order-requests) always
 * validates against fresh state, so any item that became unavailable
 * during the customer's session simply gets rejected at submit with
 * an explicit error message — they don't silently over-order stock.
 *
 * The 60s window matters most when a manager toggles an item's
 * status to archived/discontinued: that item could remain orderable
 * in cached catalogs for up to 60s after the toggle. Order submit
 * still validates fresh and would reject the line. Acceptable.
 *
 * TAG INVALIDATION
 * ----------------
 * Tag: `public-catalog:<warehouseId>`. Future server actions that
 * meaningfully change the catalog shape for a warehouse (item add/
 * archive/delete, warehouse toggle, stock movements at scale)
 * can call revalidateTag(`public-catalog:${warehouseId}`) to
 * force-refresh before the 60s window. Not wired everywhere yet —
 * the 60s window is currently the only invalidation path.
 */
export async function getPublicBookCatalog(
  orgId: string,
  warehouseId: string,
): Promise<CatalogItem[]> {
  return getPublicBookCatalogCached(orgId, warehouseId);
}

const getPublicBookCatalogCached = unstable_cache(
  async (orgId: string, warehouseId: string): Promise<CatalogItem[]> => {
    const admin = createAdminClient();

    // This catalog is serialized into the RSC payload of the anonymous
    // /r/[token] page, so it must NOT carry internal data the public UI
    // doesn't render. We deliberately do NOT select unit_cost, retail_price,
    // reorder_point, bin_location, or custom_fields, and we null
    // charterName/charterCode below — none are shown on the public card, and
    // shipping them leaked internal cost / stock-strategy / site data to
    // anyone holding the (widely-shared) public link.
    const { data: itemsData } = await admin
      .from('inventory_items')
      .select(
        'id, name, sku, quantity_on_hand, warehouse_id, item_type, category_id, charter_id',
      )
      .eq('organization_id', orgId)
      .eq('warehouse_id', warehouseId)
      .eq('item_type', 'book')
      .eq('status', 'active')
      .is('deleted_at', null)
      .order('name', { ascending: true })
      .limit(500);

    type ItemRow = {
      id: string;
      name: string;
      sku: string;
      quantity_on_hand: number | null;
      warehouse_id: string;
      item_type: string | null;
      category_id: string | null;
      charter_id: string | null;
    };

    const items = (itemsData ?? []) as ItemRow[];
    if (items.length === 0) return [];

    const itemIds = items.map((i) => i.id);
    const categoryIds = [
      ...new Set(items.map((i) => i.category_id).filter((v): v is string => Boolean(v))),
    ];

    // Reservations + category names (for aisle grouping) + LQIP blurs in
    // parallel. Signed thumbnail URLs are deferred to the client (same
    // pattern as staff). Charter names/codes are intentionally NOT fetched —
    // they aren't rendered on the public card and would leak the sites an
    // org services.
    const [rsRes, categoriesRes, lqipRes] = await Promise.all([
      admin
        .from('stock_reservations')
        .select('item_id, quantity')
        .eq('organization_id', orgId)
        .in('item_id', itemIds)
        .is('released_at', null),
      categoryIds.length > 0
        ? admin
            .from('categories')
            .select('id, name')
            .eq('organization_id', orgId)
            .in('id', categoryIds)
        : Promise.resolve({ data: [] as Array<{ id: string; name: string }> }),
      admin
        .from('item_images')
        .select('item_id, lqip, is_primary, sort_order')
        .eq('organization_id', orgId)
        .in('item_id', itemIds)
        .not('lqip', 'is', null)
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

    const lqipByItem = new Map<string, string>();
    for (const row of (lqipRes.data ?? []) as Array<{ item_id: string; lqip: string | null }>) {
      if (!lqipByItem.has(row.item_id) && row.lqip) {
        lqipByItem.set(row.item_id, row.lqip);
      }
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
      // charterId is kept (the cart is charter-scoped); the human-readable
      // charter name/code are NOT shipped to the anonymous client.
      charterId: it.charter_id ?? null,
      charterName: null,
      charterCode: null,
      // Internal-only fields the public card never renders — nulled so they
      // don't ride along in the RSC payload to anonymous visitors. (rackLabel
      // = warehouse bin location; price would have leaked unit_cost; the raw
      // reorderPoint leaked the restock threshold — the public availability
      // filter uses a fixed public threshold instead.)
      rackLabel: null,
      price: null,
      reorderPoint: 0,
      imageUrl: null,
      lqip: lqipByItem.get(it.id) ?? null,
    })) satisfies CatalogItem[];
  },
  // v2: bumped after the shape was trimmed (price/reorderPoint/bin/charter
  // dropped) so no stale full-data payloads survive the 60s cache window.
  ['public-book-catalog-v2'],
  { revalidate: 60, tags: ['public-catalog'] },
);
