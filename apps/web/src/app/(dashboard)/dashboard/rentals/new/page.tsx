import Link from 'next/link';
import { redirect } from 'next/navigation';

import { RentalCreateForm } from '@/components/rentals/rental-create-form';
import type { AisleSummary, CatalogItem } from '@/components/orders/v2/types';
import { requireOrgContext } from '@/lib/auth/session';
import { createAdminClient } from '@/lib/supabase/admin';
import { TeamService } from '@/server/services/team';
import { WarehousesService } from '@/server/services/warehouses';
import { can } from '@stockpilot/core';

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

  const [warehousesSvc, teamSvc] = await Promise.all([
    WarehousesService.forCurrentUser(),
    TeamService.forCurrentUser(),
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
  const supabase = createAdminClient();
  const { data: rentalItemsData } = await supabase
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
    .limit(500);

  // Get reservations for these items
  const rentalItemIds = ((rentalItemsData ?? []) as Array<{ id: string }>).map((r) => r.id);

  let reservedByItem = new Map<string, number>();
  if (rentalItemIds.length > 0) {
    const { data: reservations } = await supabase
      .from('stock_reservations')
      .select('item_id, quantity')
      .eq('organization_id', ctx.organizationId)
      .in('item_id', rentalItemIds)
      .is('released_at', null);
    for (const r of (reservations ?? []) as Array<{ item_id: string; quantity: number }>) {
      reservedByItem.set(r.item_id, (reservedByItem.get(r.item_id) ?? 0) + r.quantity);
    }
  }

  // Get category names
  const categoryIds = [
    ...new Set(
      ((rentalItemsData ?? []) as Array<{ category_id: string | null }>)
        .map((r) => r.category_id)
        .filter(Boolean) as string[],
    ),
  ];
  let categoryNames = new Map<string, string>();
  if (categoryIds.length > 0) {
    const { data: cats } = await supabase
      .from('categories')
      .select('id, name')
      .in('id', categoryIds);
    categoryNames = new Map(
      ((cats ?? []) as Array<{ id: string; name: string }>).map((c) => [c.id, c.name]),
    );
  }

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
    const cf = it.custom_fields ?? {};
    const rackNum = (cf.rack_number as string | null) ?? null;
    const rackRow = (cf.rack_row as string | null) ?? null;
    const rackLabel = rackNum
      ? rackRow
        ? `${rackNum}-${rackRow}`
        : rackNum
      : (it.bin_location ?? null);

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
      imageUrl: null,
      lqip: null,
      price: it.retail_price ?? it.unit_cost ?? null,
      reorderPoint: it.reorder_point,
    };
  });

  const aisles = buildAisles(items);

  // Load members for the borrower picker
  const teamMembers = await teamSvc.listMembers();
  const members = teamMembers
    .filter((m) => m.user !== null)
    .map((m) => ({
      userId: m.user_id,
      displayName: m.user?.full_name ?? m.user?.email ?? 'Unknown',
      email: m.user?.email ?? null,
    }));

  return (
    <div className="container mx-auto max-w-7xl px-4 py-8 sm:px-6">
      <div className="mb-6">
        <Link href="/dashboard/rentals" className="text-muted-foreground hover:text-foreground text-sm">
          ← Back to rentals
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">New rental</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Select a borrower, pick the items to check out, and set a return date.
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
