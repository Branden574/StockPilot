import 'server-only';

import { audit } from './audit';
import {
  assertPermission,
  ServiceError,
  withContext,
  type ServiceContext,
} from './context';

// Tags are hard-deleted (no deleted_at column in the schema), so they
// can't be recovered — exclude from this surface. The other four
// tables all carry a deleted_at column from 0002_inventory.sql.
export type RecoveryEntity =
  | 'inventory_items'
  | 'categories'
  | 'locations'
  | 'suppliers';

export interface DeletedRow {
  id: string;
  /** Primary display name. Always present (falls back to '(unnamed)'). */
  name: string;
  /** SKU for inventory items, undefined for other entity types. */
  sku?: string | null;
  /** ISO timestamp of the soft-delete. */
  deleted_at: string;
  /**
   * Display name of the user who soft-deleted the row, when known.
   * Sourced from user_profiles via the deleted_by FK. Falls back to
   * the user's email if full_name is null. Null when the column was
   * never set (legacy rows, or items where the inventory service
   * doesn't yet emit deleted_by — see migration 0072 header).
   */
  deleted_by_name: string | null;
}

const ENTITY_TABLE: Record<RecoveryEntity, string> = {
  inventory_items: 'inventory_items',
  categories: 'categories',
  locations: 'locations',
  suppliers: 'suppliers',
};

/**
 * Audit log records `metadata.entity_type` as the singular form
 * ('item', 'category', ...). Map recovery entity names to that value
 * so the "View history" deep-link on each recovery row hits the right
 * filter on the audit page.
 */
export const RECOVERY_AUDIT_ENTITY_TYPE: Record<RecoveryEntity, string> = {
  inventory_items: 'inventory_item',
  categories: 'category',
  locations: 'location',
  suppliers: 'supplier',
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
    // Embed the deleted_by FK so we get the actor's display name in one
    // round trip. PostgREST's `deleter:deleted_by (...)` syntax follows
    // the FK declared in migration 0072.
    const baseCols = entity === 'inventory_items' ? 'id, name, sku, deleted_at' : 'id, name, deleted_at';
    const selectCols = `${baseCols}, deleter:deleted_by (id, full_name, email)`;
    const { data, error } = await this.ctx.supabase
      .from(table)
      .select(selectCols)
      .eq('organization_id', this.ctx.organizationId)
      .not('deleted_at', 'is', null)
      .order('deleted_at', { ascending: false })
      .limit(limit);
    if (error) throw new ServiceError('internal_error', error.message);
    return ((data ?? []) as unknown as Array<Record<string, unknown>>).map((r) => {
      // PostgREST returns embedded one-to-one rows as either an object
      // or a single-element array depending on the SDK version; normalize.
      const rawDeleter = r.deleter as
        | { full_name: string | null; email: string | null }
        | Array<{ full_name: string | null; email: string | null }>
        | null;
      const deleter = Array.isArray(rawDeleter) ? (rawDeleter[0] ?? null) : rawDeleter;
      const deletedByName =
        deleter && (deleter.full_name?.trim() || deleter.email?.trim())
          ? (deleter.full_name?.trim() || deleter.email?.trim()) ?? null
          : null;
      return {
        id: r.id as string,
        name: ((r.name as string | null) ?? '').trim() || '(unnamed)',
        sku: entity === 'inventory_items' ? ((r.sku as string | null) ?? null) : undefined,
        deleted_at: r.deleted_at as string,
        deleted_by_name: deletedByName,
      };
    });
  }

  async restore(entity: RecoveryEntity, id: string): Promise<void> {
    assertPermission(this.ctx, 'items:delete');
    const table = ENTITY_TABLE[entity];
    const { error } = await this.ctx.supabase
      .from(table)
      .update({ deleted_at: null, deleted_by: null })
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
