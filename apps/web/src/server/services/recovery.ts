import 'server-only';

import { audit } from './audit';
import {
  assertPermission,
  ServiceError,
  withContext,
  type ServiceContext,
} from './context';

export type RecoveryEntity =
  | 'inventory_items'
  | 'categories'
  | 'locations'
  | 'suppliers'
  | 'tags';

export interface DeletedRow {
  id: string;
  /** Display label for the row — for items it's name+sku, for others it's name. */
  label: string;
  deleted_at: string;
}

const ENTITY_TABLE: Record<RecoveryEntity, string> = {
  inventory_items: 'inventory_items',
  categories: 'categories',
  locations: 'locations',
  suppliers: 'suppliers',
  tags: 'tags',
};

/**
 * Soft-delete recovery: surfaces rows where `deleted_at IS NOT NULL`
 * across the five soft-delete-capable tables, and lets admins restore
 * them via a single call. Gated on `items:delete` because restoring a
 * soft-deleted row is functionally an admin-tier action: undoes a
 * destructive change.
 *
 * Up to `limit` rows per entity (default 200) — older deletes scroll
 * off, which is fine since the most recent deletes are what you
 * usually want to recover.
 */
export class RecoveryService {
  constructor(private readonly ctx: ServiceContext) {}

  static async forCurrentUser() {
    return new RecoveryService(await withContext());
  }

  async listDeleted(entity: RecoveryEntity, limit = 200): Promise<DeletedRow[]> {
    assertPermission(this.ctx, 'items:delete');
    const table = ENTITY_TABLE[entity];
    const selectCols =
      entity === 'inventory_items'
        ? 'id, name, sku, deleted_at'
        : 'id, name, deleted_at';
    const { data, error } = await this.ctx.supabase
      .from(table)
      .select(selectCols)
      .eq('organization_id', this.ctx.organizationId)
      .not('deleted_at', 'is', null)
      .order('deleted_at', { ascending: false })
      .limit(limit);
    if (error) throw new ServiceError('internal_error', error.message);
    return ((data ?? []) as unknown as Array<Record<string, unknown>>).map((r) => ({
      id: r.id as string,
      label:
        entity === 'inventory_items'
          ? `${r.name ?? ''}${r.sku ? ` (${r.sku})` : ''}`
          : ((r.name as string | null) ?? '(unnamed)'),
      deleted_at: r.deleted_at as string,
    }));
  }

  async restore(entity: RecoveryEntity, id: string): Promise<void> {
    assertPermission(this.ctx, 'items:delete');
    const table = ENTITY_TABLE[entity];
    const { error } = await this.ctx.supabase
      .from(table)
      .update({ deleted_at: null })
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .not('deleted_at', 'is', null);
    if (error) throw new ServiceError('internal_error', error.message);
    void audit(
      {
        event: 'recovery.restored',
        entityType: entity,
        entityId: id,
      },
      this.ctx,
    );
  }
}
