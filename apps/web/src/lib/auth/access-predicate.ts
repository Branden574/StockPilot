import type { Role } from '@stockpilot/core';
import { isManagerOrAbove } from '@stockpilot/core';

/**
 * TypeScript mirror of the Postgres `user_can_access_inventory` function
 * defined in migration 0008. Centralizing the rule in one TS spot lets
 * us:
 *   • write fast unit tests without spinning up Postgres
 *   • use the same rule in client-side UI filters (e.g., the item form
 *     blocking a manager from picking a (warehouse, charter) pair they
 *     don't have write access to)
 *
 * The DB function remains the security source of truth. This is a
 * faithful mirror — keep them in sync.
 */
export interface UserAssignment {
  warehouse_id: string;
  /** null = "all charters at this warehouse" */
  charter_id: string | null;
}

export interface AccessQuery {
  role: Role;
  /** All assignments for the user (only used for non-manager roles). */
  assignments: UserAssignment[];
  /** The item's warehouse. */
  warehouseId: string;
  /** The item's charter (null = generic stock). */
  charterId: string | null;
  op: 'read' | 'write';
}

export function userCanAccessInventory(q: AccessQuery): boolean {
  // Manager+ → full access in their org.
  if (isManagerOrAbove(q.role)) return true;

  // Viewer cannot write, ever.
  if (q.op === 'write' && q.role === 'viewer') return false;

  return q.assignments.some((a) => {
    if (a.warehouse_id !== q.warehouseId) return false;
    if (a.charter_id === null) return true; // assigned to all charters at this wh
    if (q.charterId === null) return true; // generic stock — anyone with wh access
    return a.charter_id === q.charterId;
  });
}
