import Link from 'next/link';
import { redirect } from 'next/navigation';

import {
  OrderRequestForm,
  type OrderItemOption,
} from '@/components/orders/order-request-form';
import { hasPermission } from '@stockpilot/core';
import { requireOrgContext } from '@/lib/auth/session';
import { createClient } from '@/lib/supabase/server';
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

  // Reservations + uploaded-image rows in parallel — they're
  // independent reads so two-round-trip cost stays one network hop.
  const [rsRes, imgRes] = await Promise.all([
    supabase
      .from('stock_reservations')
      .select('item_id, quantity')
      .eq('organization_id', organizationId)
      .in('item_id', itemIds)
      .is('released_at', null),
    supabase
      .from('item_images')
      .select('item_id, storage_path, is_primary, sort_order')
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

  // Pick one primary storage_path per item (the order_by above puts
  // is_primary=true first, then lowest sort_order).
  const pathByItem = new Map<string, string>();
  for (const r of (imgRes.data ?? []) as Array<{ item_id: string; storage_path: string }>) {
    if (!pathByItem.has(r.item_id)) pathByItem.set(r.item_id, r.storage_path);
  }
  const urlByPath = new Map<string, string>();
  if (pathByItem.size > 0) {
    // 1h TTL — enough to ride out the form session (browse + add to
    // cart + submit) without baking long-lived item-photo URLs into
    // the page that linger in screenshots / shared links.
    const { data: signed } = await supabase.storage
      .from('item-images')
      .createSignedUrls([...pathByItem.values()], 60 * 60);
    for (const entry of signed ?? []) {
      if (entry.signedUrl && entry.path) urlByPath.set(entry.path, entry.signedUrl);
    }
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

  function imageUrlFor(it: typeof items[number]): string | null {
    const path = pathByItem.get(it.id);
    const uploaded = path ? urlByPath.get(path) ?? null : null;
    if (uploaded) return uploaded;
    // Bulk-imported books (ISBN importer at apps/web/src/server/actions/
    // books-bulk-import.ts:79) stash the cover URL on custom_fields
    // instead of inserting an item_images row. Length-cap is the same
    // sanity bound used elsewhere in the codebase.
    const cf = it.custom_fields ?? {};
    const thumb = (cf as { thumbnail_url?: unknown }).thumbnail_url;
    if (typeof thumb === 'string' && thumb.length > 0 && thumb.length < 2000) {
      return thumb;
    }
    return null;
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
    imageUrl: imageUrlFor(it),
  }));
}
