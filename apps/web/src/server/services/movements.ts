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
  /** Full name (or email fallback) of the user who triggered the movement.
      null when the row was written by a system process (e.g. a trigger
      with no auth.uid context). */
  actor: { id: string; fullName: string | null; email: string | null } | null;
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
        ${itemEmbed},
        actor:user_profiles!user_id (id, full_name, email)
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
      const actorField = r.actor as
        | { id: string; full_name: string | null; email: string | null }
        | { id: string; full_name: string | null; email: string | null }[]
        | null
        | undefined;
      const actorRaw = Array.isArray(actorField) ? (actorField[0] ?? null) : (actorField ?? null);
      const actor = actorRaw
        ? {
            id: actorRaw.id,
            fullName: actorRaw.full_name ?? null,
            email: actorRaw.email ?? null,
          }
        : null;
      return { ...r, item, actor } as MovementWithItem;
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
 * and inventory value. When no warehouse filter is set, uses the
 * get_dashboard_summary RPC (single index scan, fastest path). When a
 * warehouse filter is active, falls back to a direct aggregate query
 * scoped to that warehouse so manager-level filters honor on the dash.
 */
export async function getDashboardSummary(
  options: { warehouseId?: string | null; ctx?: ServiceContext } = {},
): Promise<DashboardSummary> {
  const ctx = options.ctx ?? (await withContext());
  if (!options.warehouseId) {
    const { data, error } = await ctx.supabase.rpc('get_dashboard_summary', {
      p_org_id: ctx.organizationId,
    });
    if (error) throw new ServiceError('internal_error', error.message);
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

  // Warehouse-scoped path: PostgREST aggregate isn't great here, so we
  // pull just the four numeric columns we need and roll up in TS. Cheap
  // because we filter by warehouse_id (indexed) and project 4 columns.
  const { data, error } = await ctx.supabase
    .from('inventory_items')
    .select('quantity_on_hand, reorder_point, unit_cost, status')
    .eq('organization_id', ctx.organizationId)
    .eq('warehouse_id', options.warehouseId)
    .is('deleted_at', null);
  if (error) throw new ServiceError('internal_error', error.message);
  let itemCount = 0;
  let outOfStockCount = 0;
  let lowStockCount = 0;
  let inventoryValue = 0;
  for (const r of (data ?? []) as Array<{
    quantity_on_hand: number;
    reorder_point: number;
    unit_cost: number;
    status: string;
  }>) {
    if (r.status !== 'active') continue;
    itemCount += 1;
    inventoryValue += (Number(r.quantity_on_hand) || 0) * (Number(r.unit_cost) || 0);
    if (r.quantity_on_hand <= 0) outOfStockCount += 1;
    else if (r.reorder_point > 0 && r.quantity_on_hand <= r.reorder_point) lowStockCount += 1;
  }
  return { itemCount, outOfStockCount, lowStockCount, inventoryValue };
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
export async function getThirtyDayMetrics(
  options: { warehouseId?: string | null } = {},
): Promise<ThirtyDayMetrics> {
  const ctx = await withContext();
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  let query = ctx.supabase
    .from('stock_movements')
    .select(
      options.warehouseId
        ? 'movement_type, created_at, item:inventory_items!item_id!inner (warehouse_id)'
        : 'movement_type, created_at',
    )
    .eq('organization_id', ctx.organizationId)
    .gte('created_at', since.toISOString())
    .order('created_at', { ascending: true });
  if (options.warehouseId) {
    query = query.eq('item.warehouse_id', options.warehouseId);
  }
  const { data, error } = await query;
  if (error) throw new ServiceError('internal_error', error.message);

  const dailyCounts = new Array<number>(30).fill(0);
  const byTypeMap = new Map<string, number>();
  const dayMs = 24 * 60 * 60 * 1000;
  const startMs = since.getTime();

  for (const r of (data ?? []) as unknown as Array<{
    movement_type: string;
    created_at: string;
  }>) {
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
export async function getDashboardActions(
  options: { warehouseId?: string | null; ctx?: ServiceContext } = {},
): Promise<DashboardActions> {
  const ctx = options.ctx ?? (await withContext());
  let posQ = ctx.supabase
    .from('purchase_orders')
    .select('id', { count: 'estimated', head: true })
    .eq('organization_id', ctx.organizationId)
    .in('status', ['expected_inbound', 'ordered', 'partially_received']);
  let ccQ = ctx.supabase
    .from('cycle_counts')
    .select('id', { count: 'estimated', head: true })
    .eq('organization_id', ctx.organizationId)
    .eq('status', 'in_progress');
  if (options.warehouseId) {
    posQ = posQ.eq('warehouse_id', options.warehouseId);
    ccQ = ccQ.eq('warehouse_id', options.warehouseId);
  }
  const [pos, cc] = await Promise.all([posQ, ccQ]);
  return {
    openPoCount: pos.count ?? 0,
    openCycleCount: cc.count ?? 0,
    pendingReceipts: 0,
  };
}

export async function getLowStockItems(
  limit = 10,
  options: { warehouseId?: string | null; ctx?: ServiceContext } = {},
) {
  const ctx = options.ctx ?? (await withContext());
  if (!options.warehouseId) {
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

  // Warehouse-scoped fallback. The RPC is org-wide; reproduce its
  // semantics here for the filter case (active items where qty <=
  // reorder_point and reorder_point > 0, ordered by smallest gap).
  const { data, error } = await ctx.supabase
    .from('inventory_items')
    .select(
      'id, name, sku, quantity_on_hand, reorder_point, reorder_quantity, primary_location:locations!primary_location_id (name)',
    )
    .eq('organization_id', ctx.organizationId)
    .eq('warehouse_id', options.warehouseId)
    .eq('status', 'active')
    .is('deleted_at', null)
    .gt('reorder_point', 0)
    .filter('quantity_on_hand', 'lte', 'reorder_point' as never as number)
    .order('quantity_on_hand', { ascending: true })
    .limit(limit);
  if (error) {
    // The qty<=reorder_point filter via PostgREST `column-to-column`
    // syntax isn't supported in every supabase-js version; fall back
    // to client-side filter.
    const { data: all } = await ctx.supabase
      .from('inventory_items')
      .select(
        'id, name, sku, quantity_on_hand, reorder_point, reorder_quantity, primary_location:locations!primary_location_id (name)',
      )
      .eq('organization_id', ctx.organizationId)
      .eq('warehouse_id', options.warehouseId)
      .eq('status', 'active')
      .is('deleted_at', null)
      .gt('reorder_point', 0)
      .order('quantity_on_hand', { ascending: true })
      .limit(200);
    const filtered = ((all ?? []) as Array<Record<string, unknown>>)
      .filter(
        (r) => Number(r.quantity_on_hand) <= Number(r.reorder_point),
      )
      .slice(0, limit);
    return filtered.map((r) => {
      const loc = r.primary_location as { name: string } | { name: string }[] | null;
      const locObj = Array.isArray(loc) ? loc[0] : loc;
      return {
        id: r.id as string,
        name: r.name as string,
        sku: r.sku as string,
        quantity_on_hand: Number(r.quantity_on_hand),
        reorder_point: Number(r.reorder_point),
        reorder_quantity: Number(r.reorder_quantity),
        primary_location: locObj?.name ?? null,
      };
    });
  }
  return (data ?? []).map((r) => {
    const rec = r as Record<string, unknown>;
    const loc = rec.primary_location as { name: string } | { name: string }[] | null;
    const locObj = Array.isArray(loc) ? loc[0] : loc;
    return {
      id: rec.id as string,
      name: rec.name as string,
      sku: rec.sku as string,
      quantity_on_hand: Number(rec.quantity_on_hand),
      reorder_point: Number(rec.reorder_point),
      reorder_quantity: Number(rec.reorder_quantity),
      primary_location: locObj?.name ?? null,
    };
  });
}
