import 'server-only';

import { audit } from './audit';
import { assertPermission, ServiceError, withContext, type ServiceContext } from './context';

export interface WarehouseCharterPair {
  warehouse_id: string;
  charter_id: string;
}

export class WarehouseChartersService {
  constructor(private readonly ctx: ServiceContext) {}

  static async forCurrentUser() {
    return new WarehouseChartersService(await withContext());
  }

  /**
   * Lists every (warehouse, charter) pairing in the current org. Used by the
   * item form to filter charter options once a warehouse is picked. Pairs are
   * already constrained by RLS to the user's visible orgs.
   */
  async listPairs(): Promise<WarehouseCharterPair[]> {
    const { data, error } = await this.ctx.supabase
      .from('warehouse_charters')
      .select('warehouse_id, charter_id')
      .eq('organization_id', this.ctx.organizationId);
    if (error) throw new ServiceError('internal_error', error.message);
    return (data ?? []) as WarehouseCharterPair[];
  }

  /**
   * Replaces the full charter list a warehouse services. Sends an audit event
   * with the diff (added / removed). Admin-only.
   */
  async setForWarehouse(warehouseId: string, charterIds: string[]) {
    assertPermission(this.ctx, 'organization:update');

    const { data: current } = await this.ctx.supabase
      .from('warehouse_charters')
      .select('charter_id')
      .eq('organization_id', this.ctx.organizationId)
      .eq('warehouse_id', warehouseId);

    const existing = new Set(((current ?? []) as Array<{ charter_id: string }>).map((r) => r.charter_id));
    const desired = new Set(charterIds);

    const toAdd = [...desired].filter((id) => !existing.has(id));
    const toRemove = [...existing].filter((id) => !desired.has(id));

    if (toAdd.length > 0) {
      const { error: insErr } = await this.ctx.supabase.from('warehouse_charters').insert(
        toAdd.map((charter_id) => ({
          organization_id: this.ctx.organizationId,
          warehouse_id: warehouseId,
          charter_id,
        })),
      );
      if (insErr) throw new ServiceError('internal_error', insErr.message);
    }

    if (toRemove.length > 0) {
      // Block removal if any inventory_items reference the (warehouse, charter)
      // pair — the FK would reject anyway, but a friendly error is better.
      const { count } = await this.ctx.supabase
        .from('inventory_items')
        .select('id', { count: 'exact', head: true })
        .eq('organization_id', this.ctx.organizationId)
        .eq('warehouse_id', warehouseId)
        .in('charter_id', toRemove)
        .is('deleted_at', null);
      if ((count ?? 0) > 0) {
        throw new ServiceError(
          'conflict',
          `Cannot remove charter — ${count} item(s) at this warehouse are still tagged to it. Move or archive them first.`,
        );
      }
      const { error: delErr } = await this.ctx.supabase
        .from('warehouse_charters')
        .delete()
        .eq('organization_id', this.ctx.organizationId)
        .eq('warehouse_id', warehouseId)
        .in('charter_id', toRemove);
      if (delErr) throw new ServiceError('internal_error', delErr.message);
    }

    await audit(
      {
        event: 'warehouse_charters.updated',
        entityType: 'warehouse',
        entityId: warehouseId,
        before: { charterIds: [...existing] },
        after: { charterIds: [...desired] },
      },
      this.ctx,
    );
  }
}
