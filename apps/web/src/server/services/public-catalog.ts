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

    const { data: itemsData } = await admin
      .from('inventory_items')
      .select(
        'id, name, sku, quantity_on_hand, warehouse_id, item_type, custom_fields, bin_location, category_id, charter_id, retail_price, unit_cost, reorder_point',
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
      custom_fields: Record<string, unknown> | null;
      bin_location: string | null;
      category_id: string | null;
      charter_id: string | null;
      retail_price: number | null;
      unit_cost: number | null;
      reorder_point: number | null;
    };

    const items = (itemsData ?? []) as ItemRow[];
    if (items.length === 0) return [];

    const itemIds = items.map((i) => i.id);
    const categoryIds = [
      ...new Set(items.map((i) => i.category_id).filter((v): v is string => Boolean(v))),
    ];
    const charterIds = [
      ...new Set(items.map((i) => i.charter_id).filter((v): v is string => Boolean(v))),
    ];

    // Reservations + category names + charter names + LQIP blurs in
    // parallel. Signed thumbnail URLs are deferred to the client (same
    // pattern as staff).
    const [rsRes, categoriesRes, chartersRes, lqipRes] = await Promise.all([
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
      charterIds.length > 0
        ? admin
            .from('charters')
            .select('id, name, code')
            .eq('organization_id', orgId)
            .in('id', charterIds)
        : Promise.resolve({
            data: [] as Array<{ id: string; name: string; code: string | null }>,
          }),
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

    const charterById = new Map<string, { name: string; code: string | null }>();
    for (const c of (chartersRes.data ?? []) as Array<{
      id: string;
      name: string;
      code: string | null;
    }>) {
      charterById.set(c.id, { name: c.name, code: c.code ?? null });
    }

    const lqipByItem = new Map<string, string>();
    for (const row of (lqipRes.data ?? []) as Array<{ item_id: string; lqip: string | null }>) {
      if (!lqipByItem.has(row.item_id) && row.lqip) {
        lqipByItem.set(row.item_id, row.lqip);
      }
    }

    function rackLabelFor(it: ItemRow): string | null {
      if (it.bin_location && it.bin_location.trim()) return it.bin_location.trim();
      const cf = it.custom_fields ?? {};
      const num = (cf as { book_rack_number?: unknown }).book_rack_number as
        | string
        | undefined;
      const row = (cf as { book_rack_row?: unknown }).book_rack_row as
        | string
        | undefined;
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
      imageUrl: null,
      lqip: lqipByItem.get(it.id) ?? null,
      price:
        typeof it.retail_price === 'number'
          ? it.retail_price
          : typeof it.unit_cost === 'number'
          ? it.unit_cost
          : null,
      reorderPoint: Number(it.reorder_point) || 0,
    })) satisfies CatalogItem[];
  },
  ['public-book-catalog-v1'],
  { revalidate: 60, tags: ['public-catalog'] },
);
