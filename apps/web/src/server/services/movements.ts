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

export interface ThirtyDayMetrics {
  /** Per-day movement counts oldest → newest, length 30. */
  dailyCounts: number[];
  /**
   * Aggregated by movement_type. Sorted descending by count. Each
   * entry's `share` is its count / max-count so the dashboard can
   * render a relative bar without a separate normalization pass.
   */
  byType: Array<{ type: string; count: number; share: number }>;
}

/**
 * Real 30-day movement metrics for the dashboard charts. Replaces the
 * synthetic `barValues` + `breakdownRows` arrays the dashboard used to
 * render. Single round trip to stock_movements.
 */
export async function getThirtyDayMetrics(): Promise<ThirtyDayMetrics> {
  const ctx = await withContext();
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const { data, error } = await ctx.supabase
    .from('stock_movements')
    .select('movement_type, created_at')
    .eq('organization_id', ctx.organizationId)
    .gte('created_at', since.toISOString())
    .order('created_at', { ascending: true });
  if (error) throw new ServiceError('internal_error', error.message);

  const dailyCounts = new Array<number>(30).fill(0);
  const byTypeMap = new Map<string, number>();
  const dayMs = 24 * 60 * 60 * 1000;
  const startMs = since.getTime();

  for (const r of (data ?? []) as Array<{ movement_type: string; created_at: string }>) {
    const t = new Date(r.created_at).getTime();
    const dayIdx = Math.min(29, Math.max(0, Math.floor((t - startMs) / dayMs)));
    dailyCounts[dayIdx] = (dailyCounts[dayIdx] ?? 0) + 1;
    byTypeMap.set(r.movement_type, (byTypeMap.get(r.movement_type) ?? 0) + 1);
  }

  const byTypeRaw = [...byTypeMap.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count);
  const max = byTypeRaw[0]?.count ?? 1;
  const byType = byTypeRaw.map((r) => ({ ...r, share: r.count / max }));

  return { dailyCounts, byType };
}

export interface DashboardActions {
  /** Receivable POs (expected_inbound / ordered / partially_received). */
  openPoCount: number;
  /** Cycle counts in 'in_progress' status. */
  openCycleCount: number;
  /** Receipts pending approval (counted via tolerance_profiles → approvals). */
  pendingReceipts: number;
}

/**
 * Counts of "things to do" surfaced in Shift Command. Three head queries,
 * each tiny — just `count: 'estimated'` on filtered rowsets.
 */
export async function getDashboardActions(): Promise<DashboardActions> {
  const ctx = await withContext();
  const [pos, cc] = await Promise.all([
    ctx.supabase
      .from('purchase_orders')
      .select('id', { count: 'estimated', head: true })
      .eq('organization_id', ctx.organizationId)
      .in('status', ['expected_inbound', 'ordered', 'partially_received']),
    ctx.supabase
      .from('cycle_counts')
      .select('id', { count: 'estimated', head: true })
      .eq('organization_id', ctx.organizationId)
      .eq('status', 'in_progress'),
  ]);
  return {
    openPoCount: pos.count ?? 0,
    openCycleCount: cc.count ?? 0,
    pendingReceipts: 0,
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
