import 'server-only';

import { isManagerOrAbove, type RecountUnavailableReason } from '@stockpilot/core';

import { assertWarehouseAccess, ForbiddenError, getWarehouseAccess } from '@/lib/auth/warehouse';

import { assertModuleEnabled, assertPermission, ServiceError, type ServiceContext } from '../context';
import { fetchAllRowsByIds } from './fetch-by-ids';

/**
 * STARTING A CYCLE COUNT: the checks every way of starting one runs, ONCE.
 *
 * Two entry points create counts: CycleCountsService.start() (the Start a
 * count screens and POST /api/v1/cycle-counts) and ExceptionRecountService
 * (a recount from the Exception Center, F1-2). They must refuse the same
 * people, check the same warehouses and validate the same assignee, so these
 * checks live here and both call them, in this order (pattern #26: two copies
 * of an authorization rule drift):
 *
 *   1. assertCountStartFloors  the cycle_counts module; cycle_counts:assign and
 *                              stock:adjust; the manager role.
 *   2. assertAcceptedMember    the assignee, when one is asked for, BEFORE
 *                              anything is created (SP-123).
 *   3. gateCountItems          write access to every warehouse the countable
 *                              items sit in, and the header warehouse.
 *
 * The manager role matches the database floor: the cycle_counts INSERT policy
 * and start_targeted_recount both require has_org_role(..., 'manager'), and
 * cycle_counts:assign can be granted to a lower role by an override (0207).
 * Checked here, that caller gets a clean `forbidden` instead of an RLS failure
 * reported as an internal error (pattern #4).
 */

/** Step 1. Throws before any database round trip. */
export function assertCountStartFloors(ctx: ServiceContext): void {
  assertModuleEnabled(ctx, 'cycle_counts');
  assertPermission(ctx, 'cycle_counts:assign');
  assertPermission(ctx, 'stock:adjust');
  if (!isManagerOrAbove(ctx.role)) {
    throw new ServiceError('forbidden', 'Only a manager can start a count.');
  }
}

/**
 * Why this caller could NOT start a count, or null when they could: exactly
 * step 1, as a reason, for the hints a list shows (Recount, Count this item),
 * so a manager in an org with Cycle Counts turned off is told that, not
 * "only a manager". Every other refusal is the permission rule (a session
 * short of a required MFA check cannot read the exceptions in the first
 * place). The action itself still runs the full preflight, and the database
 * re-checks.
 */
export function countStartBlock(ctx: ServiceContext): RecountUnavailableReason | null {
  try {
    assertCountStartFloors(ctx);
    return null;
  } catch (e) {
    return e instanceof ServiceError && e.code === 'module_disabled' ? 'module_disabled' : 'not_permitted';
  }
}

/** countStartBlock as a yes/no. */
export function canStartCount(ctx: ServiceContext): boolean {
  return countStartBlock(ctx) === null;
}

/**
 * Step 2 (also used by CycleCountsService.assign). Cross-org tampering check:
 * an assignee must be an accepted member of THIS organization, otherwise a
 * caller could route a count to a user id they happen to know but who is not
 * on the team. RLS on organization_members scopes the read to the caller's
 * orgs, and the org filter pins it to this one.
 *
 * assign_cycle_count (0282) re-checks the same thing and raises
 * invalid_assignee; this pre-check exists for the clean message and so a start
 * can refuse a bad assignee BEFORE it snapshots a whole count (SP-123).
 */
export async function assertAcceptedMember(ctx: ServiceContext, userId: string): Promise<void> {
  const { data: member, error } = await ctx.supabase
    .from('organization_members')
    .select('id')
    .eq('organization_id', ctx.organizationId)
    .eq('user_id', userId)
    .not('accepted_at', 'is', null)
    .maybeSingle();
  if (error) throw new ServiceError('internal_error', error.message);
  if (!member) {
    throw new ServiceError('validation_error', 'That user is not an active member of this organization.');
  }
}

/** What gateCountItems found. */
export interface CountItemsGate {
  /** The requested items that can be counted, as the caller reads them: in
   *  this org, active, not deleted, not rental equipment, not a kit phantom
   *  (start_cycle_count's own predicate, 0369 D8). */
  items: Array<{ id: string; warehouse_id: string | null }>;
  /** The warehouse every countable item shares, else null (they span
   *  warehouses, or one has none). A selection count is labelled with it. */
  headerWarehouseId: string | null;
}

/**
 * Step 3. Reads the requested items under the caller's RLS with the same
 * predicate the snapshot re-selects with (so the gated set and the counted set
 * are the same items), then requires WRITE access to every distinct warehouse
 * among them. An item with no warehouse needs full (manager+) access, since it
 * is pinned to no assignment. Items that cannot be counted are not gated: they
 * are never counted.
 *
 * PAGINATED and BATCHED: a group expansion has no cap, a plain selection is
 * capped at 1000, and one `.in()` past ~215 uuids fails outright. A failed
 * batch throws, so no count starts on a partial, ungated set.
 *
 * Throws ForbiddenError (from the warehouse helpers) when a warehouse is not
 * writable. An empty result is not an error here: each caller decides what
 * "nothing countable" means.
 */
export async function gateCountItems(ctx: ServiceContext, itemIds: readonly string[]): Promise<CountItemsGate> {
  const ids = Array.from(new Set(itemIds));
  const items = await fetchAllRowsByIds<{ id: string; warehouse_id: string | null }>(
    ids,
    (batch) => (from, to) =>
      ctx.supabase
        .from('inventory_items')
        .select('id, warehouse_id')
        .eq('organization_id', ctx.organizationId)
        .is('deleted_at', null)
        .eq('status', 'active')
        // Rental equipment and kit phantoms are never counted (0369, D8).
        .eq('is_rental', false)
        .eq('is_bundle', false)
        .in('id', batch)
        .order('id', { ascending: true })
        .range(from, to),
  );

  const distinctWh = new Set<string>();
  let hasNullWh = false;
  for (const it of items) {
    if (it.warehouse_id) distinctWh.add(it.warehouse_id);
    else hasNullWh = true;
  }
  if (hasNullWh) {
    const access = await getWarehouseAccess(ctx);
    if (!access.hasAllAccess) {
      throw new ForbiddenError('You cannot count items that have no warehouse.');
    }
  }
  for (const wh of distinctWh) {
    await assertWarehouseAccess(wh, 'write', ctx);
  }
  return {
    items,
    headerWarehouseId: distinctWh.size === 1 && !hasNullWh ? (Array.from(distinctWh)[0] as string) : null,
  };
}
