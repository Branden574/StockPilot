import 'server-only';

import { ServiceError, withContext, type ServiceContext } from './context';

export class MovementsService {
  constructor(private readonly ctx: ServiceContext) {}

  static async forCurrentUser() {
    return new MovementsService(await withContext());
  }

  async list(params: { itemId?: string; limit?: number } = {}) {
    const limit = Math.min(params.limit ?? 100, 500);
    let query = this.ctx.supabase
      .from('stock_movements')
      .select(
        `
        id, movement_type, quantity_change, previous_quantity, new_quantity,
        from_location_id, to_location_id, reason, notes, created_at,
        item_id, user_id
      `,
      )
      .eq('organization_id', this.ctx.organizationId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (params.itemId) query = query.eq('item_id', params.itemId);

    const { data, error } = await query;
    if (error) throw new ServiceError('internal_error', error.message);
    return data ?? [];
  }
}

export async function getDashboardSummary() {
  const ctx = await withContext();
  const { supabase, organizationId } = ctx;

  const [{ count: itemCount }, { count: outOfStockCount }, valueRpc, lowRpc] = await Promise.all([
    supabase
      .from('inventory_items')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', organizationId)
      .eq('status', 'active')
      .is('deleted_at', null),
    supabase
      .from('inventory_items')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', organizationId)
      .eq('status', 'active')
      .lte('quantity_on_hand', 0)
      .is('deleted_at', null),
    supabase.rpc('inventory_value', { p_org_id: organizationId }),
    supabase.rpc('low_stock_count', { p_org_id: organizationId }),
  ]);

  return {
    itemCount: itemCount ?? 0,
    outOfStockCount: outOfStockCount ?? 0,
    inventoryValue: typeof valueRpc.data === 'number' ? valueRpc.data : 0,
    lowStockCount: typeof lowRpc.data === 'number' ? lowRpc.data : 0,
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
