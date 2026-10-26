/**
 * Which of an order's warehouses the viewer works in, on the phone's order
 * screen (security slice E, migration 0405).
 *
 * An approver acts on an order only in a warehouse they may write to: the six
 * order functions ask it since 0405 (approve, approve partial, close, resume,
 * reopen, an approver's cancel), the service asks it first, and hold, the
 * needed-by date, the pick slip, picking, staging and delivery asked it
 * before. The screen used to offer a staff approver of warehouse A Approve,
 * Deny, Cancel, Add items, the line edits and Claim or Release on warehouse
 * B's order, each refused after the tap ("This order is in a warehouse you
 * don't work in, so you can't change it. Ask a manager."). It now reads the
 * viewer's warehouses with the order and offers none of them there, as the
 * web order page does.
 *
 * WHO IS READ. Owners, admins and managers work in every warehouse by role:
 * no read. Below manager, the read is made for someone who approves orders
 * (their controls show at every status) and for someone who can pick when the
 * order is in picking (Claim and Release): the web page's own reads. Staff
 * through readDestinationWarehouseScope (their assignment rows, what the
 * server's write check reads); a viewer through the same assignment read,
 * because a viewer writes nowhere but the line edits ask READ access
 * (loadEditableOrderHeader), which a viewer has where assigned.
 *
 * A FAILED READ OFFERS AS BEFORE. The phone's precedent for this screen (the
 * needed-by sheet, neededBySheetOpening): an access read that failed decides
 * nothing, the controls show as they did before slice E, and the server
 * answers in its one sentence (or "Your warehouse access couldn't be checked
 * just now, so nothing was changed. Try again." when its own read fails). The
 * server decides every action either way; this only decides what is offered.
 *
 * Pure apart from the read (the screen passes `supabase`), so vitest pins it.
 */

import type { Role } from '@stockpilot/core';

import {
  readAssignedWarehouseIds,
  readDestinationWarehouseScope,
  seesEveryHolding,
  type AssignmentReadClient,
} from './holdings-elsewhere';

/** The viewer's warehouses as this load read them. */
export interface OrderWarehouseScope {
  /** Warehouses whose orders they may change (write). null: every warehouse. */
  writableIds: readonly string[] | null;
  /** Warehouses whose orders' lines they may change (read). null: every warehouse. */
  readableIds: readonly string[] | null;
  /** The read failed: nothing is decided from it (offered as before). */
  unreadable: boolean;
}

/** The statuses whose Claim and Release ask the order's warehouse. */
const PICKING_STATUSES: ReadonlySet<string> = new Set(['pick_slip_generated', 'picking_in_progress']);

/**
 * Whether this load reads the viewer's warehouses: below manager, for someone
 * who approves orders (any status), or who can pick when the order is in
 * picking. An unknown role (still loading) is not read: nothing that needs it
 * is offered to an unknown role, and the load runs again once it is known.
 */
export function needsOrderWarehouseScope(input: {
  role: Role | string | null | undefined;
  canApproveOrders: boolean;
  canPick: boolean;
  status: string | null | undefined;
}): boolean {
  if (typeof input.role !== 'string' || input.role === '' || seesEveryHolding(input.role)) return false;
  if (input.canApproveOrders) return true;
  return input.canPick && PICKING_STATUSES.has(input.status ?? '');
}

/** Read the viewer's warehouses for the order screen. Never throws. */
export async function readOrderWarehouseScope(
  client: AssignmentReadClient,
  input: {
    role: Role | string | null | undefined;
    organizationId: string;
    userId: string | null | undefined;
  },
): Promise<OrderWarehouseScope> {
  if (input.role === 'viewer') {
    const read = await readAssignedWarehouseIds(client, input);
    return { writableIds: [], readableIds: read.ids, unreadable: read.unreadable };
  }
  const scope = await readDestinationWarehouseScope(client, input);
  return { writableIds: scope.writableIds, readableIds: scope.writableIds, unreadable: scope.unreadable };
}

/** What the viewer may do to THIS order, by its warehouse. */
export interface OrderWarehouseAccess {
  /** Change the order: every approver action, an approver's Cancel, Hold,
   *  the needed-by date, Claim and Release. */
  writes: boolean;
  /** Change its lines: Add items and the line edits (an approver's; the
   *  person who placed it is answered by the server). */
  reads: boolean;
}

/**
 * The order's warehouse against the viewer's, as the server's checks answer
 * it: every warehouse for an owner, admin or manager; for anyone else the
 * assigned ones; never write for a viewer. A scope this load did not read, or
 * could not read, decides nothing (offered as before; the server decides).
 */
export function orderWarehouseAccess(input: {
  role: Role | string | null | undefined;
  warehouseId: string | null | undefined;
  scope: OrderWarehouseScope | null | undefined;
}): OrderWarehouseAccess {
  if (seesEveryHolding(input.role)) return { writes: true, reads: true };
  const isViewer = input.role === 'viewer';
  const scope = input.scope;
  if (!scope || scope.unreadable) return { writes: !isViewer, reads: true };
  const has = (ids: readonly string[] | null): boolean =>
    ids === null || (typeof input.warehouseId === 'string' && ids.includes(input.warehouseId));
  return { writes: !isViewer && has(scope.writableIds), reads: has(scope.readableIds) };
}
