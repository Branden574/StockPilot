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
      />
    </div>
  );
}

async function loadOrderableItems(
  organizationId: string,
  warehouseId: string,
): Promise<OrderItemOption[]> {
  const supabase = await createClient();

  // Active items in the chosen warehouse — keep the column set tight
  // since this list can be a few hundred rows for the order form.
  const { data: itemsData } = await supabase
    .from('inventory_items')
    .select('id, name, sku, quantity_on_hand, warehouse_id')
    .eq('organization_id', organizationId)
    .eq('warehouse_id', warehouseId)
    .eq('status', 'active')
    .is('deleted_at', null)
    .order('name', { ascending: true })
    .limit(500);

  const items = (itemsData ?? []) as Array<{
    id: string;
    name: string;
    sku: string;
    quantity_on_hand: number;
    warehouse_id: string;
  }>;
  if (items.length === 0) return [];

  const itemIds = items.map((i) => i.id);

  // Active reservations for the same items so we can compute
  // available-to-promise per row.
  const { data: rsData } = await supabase
    .from('stock_reservations')
    .select('item_id, quantity')
    .eq('organization_id', organizationId)
    .in('item_id', itemIds)
    .is('released_at', null);

  const reservedByItem = new Map<string, number>();
  for (const row of (rsData ?? []) as Array<{ item_id: string; quantity: number }>) {
    reservedByItem.set(
      row.item_id,
      (reservedByItem.get(row.item_id) ?? 0) + Number(row.quantity),
    );
  }

  return items.map((it) => ({
    id: it.id,
    name: it.name,
    sku: it.sku,
    warehouseId: it.warehouse_id,
    quantityOnHand: Number(it.quantity_on_hand) || 0,
    reservedQuantity: reservedByItem.get(it.id) ?? 0,
  }));
}
