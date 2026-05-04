import 'server-only';

import { getWarehouseAccess } from '@/lib/auth/warehouse';

import { ServiceError, withContext, type ServiceContext } from './context';

export interface MovementWithItem {
  id: string;
  movement_type: string;
  quantity_change: number;
  previous_quantity: number;
  new_quantity: number;
  from_location_id: string | null;
  to_location_id: string | null;
  reason: string | null;
  notes: string | null;
  created_at: string;
  item_id: string;
  user_id: string | null;
  item: { id: string; name: string; sku: string } | null;
}

export class MovementsService {
  constructor(private readonly ctx: ServiceContext) {}

  static async forCurrentUser() {
    return new MovementsService(await withContext());
  }

  /**
   * Lists recent movements with the parent inventory item embedded via the
   * existing FK in a single PostgREST round trip — eliminates the separate
   * IN(...) lookup that the dashboard + movements pages used to do.
   */
  async list(params: { itemId?: string; warehouseId?: string; limit?: number } = {}) {
    const limit = Math.min(params.limit ?? 100, 500);
    const access = await getWarehouseAccess();

    // Use `!inner` on the embed so we can filter parent rows by the item's
    // warehouse_id without a second round trip.
    const needsScope = !access.hasAllAccess || !!params.warehouseId;
    const itemEmbed = needsScope
      ? 'item:inventory_items!item_id!inner (id, name, sku, warehouse_id)'
      : 'item:inventory_items!item_id (id, name, sku, warehouse_id)';

    let query = this.ctx.supabase
      .from('stock_movements')
      .select(
        `
        id, movement_type, quantity_change, previous_quantity, new_quantity,
        from_location_id, to_location_id, reason, notes, created_at,
        item_id, user_id,
        ${itemEmbed}
      `,
      )
      .eq('organization_id', this.ctx.organizationId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (!access.hasAllAccess) {
      if (access.readableIds.length === 0) return [];
      query = query.in('item.warehouse_id', access.readableIds);
    } else if (params.warehouseId) {
      query = query.eq('item.warehouse_id', params.warehouseId);
    }

    if (params.itemId) query = query.eq('item_id', params.itemId);

    const { data, error } = await query;
    if (error) throw new ServiceError('internal_error', error.message);

    // PostgREST returns the related row as an array when the relation is
    // ambiguous; flatten to a single object.
    return (data ?? []).map((row) => {
      const r = row as Record<string, unknown>;
      const itemField = r.item as
        | { id: string; name: string; sku: string }
        | { id: string; name: string; sku: string }[]
        | null
        | undefined;
      const item = Array.isArray(itemField) ? (itemField[0] ?? null) : (itemField ?? null);
      return { ...r, item } as MovementWithItem;
    });
  }
}

export interface DashboardSummary {
  itemCount: number;
  outOfStockCount: number;
  lowStockCount: number;
  inventoryValue: number;
}

/**
 * One round trip — combines item count, out-of-stock count, low-stock count,
 * and inventory value into a single index scan over inventory_items.
 * See migration 0006_perf.sql for the get_dashboard_summary RPC.
 */
export async function getDashboardSummary(): Promise<DashboardSummary> {
  const ctx = await withContext();
  const { data, error } = await ctx.supabase.rpc('get_dashboard_summary', {
    p_org_id: ctx.organizationId,
  });
  if (error) throw new ServiceError('internal_error', error.message);

  // Postgres `returns table` shows up as an array of one row.
  const row = (Array.isArray(data) ? data[0] : data) as
    | { item_count: number; out_of_stock_count: number; low_stock_count: number; inventory_value: number }
    | null
    | undefined;

  return {
    itemCount: row?.item_count ?? 0,
    outOfStockCount: row?.out_of_stock_count ?? 0,
    lowStockCount: row?.low_stock_count ?? 0,
    inventoryValue: typeof row?.inventory_value === 'number' ? row.inventory_value : 0,
  };
}

export async function getLowStockItems(limit = 10) {
  const ctx = await withContext();
  const { data, error } = await ctx.supabase.rpc('low_stock_items', {
    p_org_id: ctx.organizationId,
    p_limit: limit,
  });
  if (error) throw new ServiceError('internal_error', error.message);
  return (data ?? []) as Array<{
    id: string;
    name: string;
    sku: string;
    quantity_on_hand: number;
    reorder_point: number;
    reorder_quantity: number;
    primary_location: string | null;
  }>;
}
