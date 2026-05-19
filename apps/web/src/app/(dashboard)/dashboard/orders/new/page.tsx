import Link from 'next/link';
import { redirect } from 'next/navigation';

import { OrdersNewV2 } from '@/components/orders/v2/orders-new-v2';
import type { AisleSummary, CatalogItem } from '@/components/orders/v2/types';
import { hasPermission } from '@stockpilot/core';
import { requireOrgContext } from '@/lib/auth/session';
import { createClient } from '@/lib/supabase/server';
import { ItemImagesService } from '@/server/services/item-images';
import { WarehousesService } from '@/server/services/warehouses';

export default async function NewOrderPage({
  searchParams,
}: {
  searchParams: Promise<{ warehouseId?: string }>;
}) {
  const ctx = await requireOrgContext();
  if (!hasPermission(ctx.role, 'orders:request')) {
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
    loadCatalogItems(ctx.organizationId, warehouseId),
    loadChartersForWarehouse(warehouseId),
  ]);
  const aisles = buildAisles(items);

  return (
    <div className="container mx-auto max-w-7xl px-4 py-8 sm:px-6">
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
        <p className="text-muted-foreground mt-1 text-sm">
          Browse the catalog, add items to your cart, and submit. A manager will
          approve before stock is reserved.
        </p>
      </div>
      <OrdersNewV2
        warehouses={warehouses}
        warehouseId={warehouseId}
        items={items}
        aisles={aisles}
        chartersForWarehouse={chartersForWarehouse}
        viewerRole={ctx.role}
      />
    </div>
  );
}

async function loadChartersForWarehouse(
  warehouseId: string,
): Promise<Array<{ id: string; name: string; code: string | null }>> {
  const supabase = await createClient();
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
}

/**
 * Loads catalog items for the v2 picker. Returns CatalogItem[] with
 * everything the new card grid needs to render: thumbnail, price,
 * available-to-promise, rack label, category name. Bundles are
 * filtered out (phantom rows).
 *
 * Powers /dashboard/orders/new v2. The legacy OrderItemOption shape
 * is now obsolete — keep this single fetch path going forward.
 */
async function loadCatalogItems(
  organizationId: string,
  warehouseId: string,
): Promise<CatalogItem[]> {
  const supabase = await createClient();

  const { data: itemsData } = await supabase
    .from('inventory_items')
    .select(
      'id, name, sku, quantity_on_hand, warehouse_id, item_type, is_bundle, custom_fields, bin_location, category_id, retail_price, unit_cost, reorder_point',
    )
    .eq('organization_id', organizationId)
    .eq('warehouse_id', warehouseId)
    .eq('status', 'active')
    .is('deleted_at', null)
    .or('is_bundle.is.null,is_bundle.eq.false')
    .order('name', { ascending: true })
    .limit(500);

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
    retail_price: number | null;
    unit_cost: number | null;
    reorder_point: number | null;
  }>;
  if (items.length === 0) return [];

  const itemIds = items.map((i) => i.id);
  const categoryIds = [...new Set(items.map((i) => i.category_id).filter((v): v is string => Boolean(v)))];

  // Reservations + images + category names in parallel.
  const imagesSvc = await ItemImagesService.forCurrentUser();
  const [rsRes, imageUrlByItem, categoriesRes] = await Promise.all([
    supabase
      .from('stock_reservations')
      .select('item_id, quantity')
      .eq('organization_id', organizationId)
      .in('item_id', itemIds)
      .is('released_at', null),
    imagesSvc.primaryImagesForPdfRendering(itemIds, 200),
    categoryIds.length > 0
      ? supabase
          .from('categories')
          .select('id, name')
          .eq('organization_id', organizationId)
          .in('id', categoryIds)
      : Promise.resolve({ data: [] as Array<{ id: string; name: string }> }),
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
    rackLabel: rackLabelFor(it),
    imageUrl: imageUrlByItem.get(it.id) ?? null,
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
