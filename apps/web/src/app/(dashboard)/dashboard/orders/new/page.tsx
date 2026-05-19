import Link from 'next/link';
import { redirect } from 'next/navigation';

import {
  OrderRequestForm,
  type OrderItemOption,
} from '@/components/orders/order-request-form';
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

  const items = await loadOrderableItems(ctx.organizationId, warehouseId);
  const chartersForWarehouse = await loadChartersForWarehouse(warehouseId);

  return (
    <div className="container mx-auto max-w-6xl px-4 py-8 sm:px-6">
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
          Pick a warehouse, add items to your cart, and submit. A manager will
          approve before stock is reserved.
        </p>
      </div>
      <OrderRequestForm
        warehouses={warehouses}
        warehouseId={warehouseId}
        items={items}
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

async function loadOrderableItems(
  organizationId: string,
  warehouseId: string,
): Promise<OrderItemOption[]> {
  const supabase = await createClient();

  // Active items in the chosen warehouse — keep the column set tight
  // since this list can be a few hundred rows for the order form.
  // Bundle phantom rows (is_bundle=true) are excluded so they don't
  // pollute the orderable list. custom_fields + bin_location drive
  // the per-row rack label + bulk-import thumbnail fallback.
  const { data: itemsData } = await supabase
    .from('inventory_items')
    .select(
      'id, name, sku, quantity_on_hand, warehouse_id, item_type, is_bundle, custom_fields, bin_location',
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
  }>;
  if (items.length === 0) return [];

  const itemIds = items.map((i) => i.id);

  // Reservations + image thumbs in parallel — independent reads.
  // ItemImagesService.primaryImagesForPdfRendering does the heavy
  // lifting for thumbs: prefers the pre-resized thumb_path (≈30-50 KB)
  // from migration 0122, falls back to a transformed 200px master via
  // Supabase's image-transformation service, falls back to
  // custom_fields.thumbnail_url for bulk-imported books that never had
  // an item_images row written. URLs are cached via unstable_cache
  // (25-day TTL) so subsequent page loads are near-instant.
  //
  // Service is named "ForPdfRendering" historically — same behavior
  // is what an order picker thumbnail needs, so we reuse it as-is.
  const imagesSvc = await ItemImagesService.forCurrentUser();
  const [rsRes, imageUrlByItem] = await Promise.all([
    supabase
      .from('stock_reservations')
      .select('item_id, quantity')
      .eq('organization_id', organizationId)
      .in('item_id', itemIds)
      .is('released_at', null),
    imagesSvc.primaryImagesForPdfRendering(itemIds, 200),
  ]);

  const reservedByItem = new Map<string, number>();
  for (const row of (rsRes.data ?? []) as Array<{ item_id: string; quantity: number }>) {
    reservedByItem.set(
      row.item_id,
      (reservedByItem.get(row.item_id) ?? 0) + Number(row.quantity),
    );
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
    name: it.name,
    sku: it.sku,
    warehouseId: it.warehouse_id,
    quantityOnHand: Number(it.quantity_on_hand) || 0,
    reservedQuantity: reservedByItem.get(it.id) ?? 0,
    itemType: it.item_type ?? null,
    rackLabel: rackLabelFor(it),
    imageUrl: imageUrlByItem.get(it.id) ?? null,
  }));
}
