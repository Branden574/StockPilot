import type { WarehouseAccess } from './warehouse';

/**
 * Which cycle counts a member reads. One rule, in one place, for every
 * surface that shows a count: the count list (CycleCountsService.listPage,
 * behind the web list and GET /api/v1/cycle-counts), the count itself
 * (getDetailPage and get, behind the web count page, the count sheet and the
 * variance report) and the open counts the phone's sync sends
 * (app/api/v1/mobile/snapshot).
 *
 *   every       managers and above (their role sees every warehouse), and a
 *               member with every warehouse (the 0280 flag): every count of
 *               the organization.
 *   warehouses  anyone else: a count in a warehouse they can READ, and a count
 *               with no warehouse only when it is assigned to them.
 *   none        a member with no readable warehouse: no count.
 *
 * Reading follows the warehouses a member can read, so a read-only member
 * sees the counts of their warehouses; who may ENTER a number is decided
 * separately, by the write gates of the count service.
 *
 * A count's header has no warehouse when it covers the whole organization, or
 * when it is a selection whose items sit in more than one warehouse. Its lines
 * can then name items from warehouses the reader is not assigned to, so it is
 * shown only to the person a manager assigned it to (assigning is a manager's
 * act: cycle_counts:assign).
 *
 * This narrows what row level security already allows (organization members);
 * it never widens it. Who may read counts at all (the module and
 * cycle_counts:read or stock:adjust) is checked by each caller before this.
 */
export type CountReadScope =
  | { kind: 'every' }
  | { kind: 'none' }
  | { kind: 'warehouses'; warehouseIds: readonly string[]; assigneeId: string };

/**
 * The scope for one caller.
 *
 * `access` is getWarehouseAccess for the caller, or null when the caller's
 * role alone sees every warehouse (isManagerOrAbove) and the access was not
 * read. An answer built from a failed read (`unreadable`) must be refused by
 * the caller BEFORE this is asked: it holds no ids, which here would read as
 * a member with no warehouse.
 */
export function countReadScope(
  access: Pick<WarehouseAccess, 'hasAllAccess' | 'readableIds'> | null,
  userId: string,
): CountReadScope {
  if (access === null || access.hasAllAccess) return { kind: 'every' };
  if (access.readableIds.length === 0) return { kind: 'none' };
  return { kind: 'warehouses', warehouseIds: access.readableIds, assigneeId: userId };
}

/** Whether the scope shows this one count (its header's warehouse and assignee). */
export function mayReadCount(
  scope: CountReadScope,
  count: { warehouse_id?: string | null; assigned_to?: string | null },
): boolean {
  if (scope.kind === 'every') return true;
  if (scope.kind === 'none') return false;
  if (count.warehouse_id) return scope.warehouseIds.includes(count.warehouse_id);
  return Boolean(count.assigned_to) && count.assigned_to === scope.assigneeId;
}

/**
 * The scope as cycle_counts_page's `p_scope_warehouse_ids` (migration 0358):
 * null for every count, else the warehouses, to which the function itself
 * adds "no warehouse and assigned to the caller" from auth.uid(). A caller
 * with scope `none` does not call the function at all.
 */
export function countScopeWarehouseIds(scope: CountReadScope): string[] | null {
  if (scope.kind === 'every') return null;
  if (scope.kind === 'none') return [];
  return [...scope.warehouseIds];
}

/**
 * The scope as a PostgREST `or` filter on a cycle_counts read, or null when
 * every count is read and no filter applies. Scope `none` has no filter: that
 * read is not sent, and nothing rests on how an empty list would be read.
 *
 * The values are ids this server read (warehouse ids from the caller's
 * assignments, the caller's own verified user id), never request input.
 */
export function countReadFilter(scope: CountReadScope): string | null {
  if (scope.kind === 'every') return null;
  if (scope.kind === 'none') {
    throw new Error('countReadFilter: a member who reads no count has no filter; skip the read');
  }
  // in-list-bound: the caller's readable warehouses (an org's handful of sites)
  const inWarehouses = `warehouse_id.in.(${scope.warehouseIds.join(',')})`;
  return `${inWarehouses},and(warehouse_id.is.null,assigned_to.eq.${scope.assigneeId})`;
}
