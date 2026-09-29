/**
 * Stub answers that model how PostgREST serves `inventory_items` and
 * `item_images` to a SCOPED caller under row level security. Built for the
 * item-level image authorization tests (2026-09-28): the bug they pin lived
 * exactly in the gap between these two tables' policies.
 *
 *   - `inventory_items`: only the rows the caller can read. Mirrors
 *     inventory_items_select (0229): the caller's org; a warehouse the caller
 *     reads whole, or, through a charter-scoped assignment, that warehouse's
 *     generic items (charter_id null) plus the assigned charter's; and (for a
 *     category-restricted viewer) one of the caller's categories.
 *   - `item_images`: EVERY row of the caller's org, because item_images_select
 *     (0003, 0140) is org-member wide. The one exception is what PostgREST does
 *     with an embed: `inventory_items!…!inner(…)` runs under the same RLS, and
 *     `!inner` drops each image row whose item the caller cannot read. A LEFT
 *     embed (no `!inner`) filters nothing, as in PostgREST.
 *
 * Both answers then apply the query's own filters, order and window through
 * `servedLikePostgrest`, so a missing `.eq('organization_id', …)` or `.in()`
 * still fails a test.
 */
import { callArgs, servedLikePostgrest, type MockCall, type QueryResult } from './supabase-mock';

export interface ScopedCaller {
  organizationId: string;
  /**
   * Warehouses the caller reads WHOLE (rls_inv_read_full_warehouse_ids: an
   * assignment with no charter). 'all' = manager and above (every warehouse
   * of the org).
   */
  warehouseIds: readonly string[] | 'all';
  /**
   * Charter-scoped assignments (user_warehouse_assignments.charter_id set):
   * in that warehouse the caller reads the generic items (charter_id null)
   * and the items of that charter, no others (rls_inv_read_assigned_
   * warehouse_ids + rls_inv_read_warehouse_charter_ids).
   */
  charterAssignments?: ReadonlyArray<{ warehouseId: string; charterId: string }>;
  /** 'all' = not category-restricted (every role but a restricted viewer). */
  categoryIds: readonly string[] | 'all';
}

export interface WorldItem {
  id: string;
  organization_id: string;
  warehouse_id: string;
  category_id: string | null;
  charter_id?: string | null;
  custom_fields?: Record<string, unknown> | null;
}

export interface WorldImage {
  id: string;
  organization_id: string;
  item_id: string;
  storage_path: string;
  thumb_path?: string | null;
  lqip?: string | null;
  is_primary: boolean;
  sort_order: number;
}

/** True when inventory_items_select would show `caller` this item. */
export function callerCanReadItem(caller: ScopedCaller, item: WorldItem): boolean {
  if (item.organization_id !== caller.organizationId) return false;
  const wholeWarehouse =
    caller.warehouseIds === 'all' || caller.warehouseIds.includes(item.warehouse_id);
  const throughCharter = (caller.charterAssignments ?? []).some(
    (a) =>
      a.warehouseId === item.warehouse_id &&
      ((item.charter_id ?? null) === null || item.charter_id === a.charterId),
  );
  if (!wholeWarehouse && !throughCharter) return false;
  if (caller.categoryIds !== 'all') {
    return item.category_id !== null && caller.categoryIds.includes(item.category_id);
  }
  return true;
}

/** Matches an embed of inventory_items joined with `!inner`, with or without
 *  an alias or a column hint: `item:inventory_items!item_id!inner(id)`. */
const INNER_ITEM_EMBED = /(?:^|[\s,])(?:\w+:)?inventory_items(?:![\w]+)*!inner\(/;

export function itemReadScopeResults(
  caller: ScopedCaller,
  world: { items: readonly WorldItem[]; images: readonly WorldImage[] },
): Record<string, (call: MockCall) => QueryResult> {
  const readable = new Set(
    world.items.filter((i) => callerCanReadItem(caller, i)).map((i) => i.id),
  );
  return {
    'inventory_items.select': (call) =>
      servedLikePostgrest(
        world.items
          .filter((i) => readable.has(i.id))
          .map((i) => ({ ...i, custom_fields: i.custom_fields ?? null })),
      )(call),
    'item_images.select': (call) => {
      const select = String(callArgs(call, 'select')?.[0] ?? '');
      const orgRows = world.images.filter((r) => r.organization_id === caller.organizationId);
      const rows = INNER_ITEM_EMBED.test(select)
        ? orgRows.filter((r) => readable.has(r.item_id))
        : orgRows;
      return servedLikePostgrest(
        rows.map((r) => ({ thumb_path: null, lqip: null, ...r })),
      )(call);
    },
  };
}
