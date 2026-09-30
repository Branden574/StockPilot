import {
  formatWallClock,
  isNeededByRevisable,
  NEEDED_BY_IN_PAST_COPY,
  neededByInvalidTimeCopy,
  neededByPreviewCopy,
  neededByRowCopy,
  resolveOrgTimezone,
  wallClockToInstant,
  type OrderReadinessResult,
  type Role,
} from '@stockpilot/core';

/**
 * CHANGE AN ORDER'S NEEDED-BY DATE ON THE WEB ORDER PAGE (F2-4): who is
 * offered "Change", in which zone the dialog works, and the dialog's pure
 * steps. Plain module (no 'use client'): the page (a server component) builds
 * the view here, and the client dialog (revise-needed-by-dialog.tsx) only
 * renders it (recurring pattern #8: no plain function a server component calls
 * lives in a client file).
 *
 * The server decides again on every save (OrderRequestsService.reviseNeededBy
 * and revise_order_needed_by, 0382): this only keeps the entry away from people
 * the save would refuse, and the dialog's preview in the zone the save converts
 * in.
 */

/** What the dialog needs, as plain data (it crosses to the client). */
export interface NeededByChangeView {
  orderId: string;
  /** order_requests.needed_by EXACTLY as PostgREST returned it, or null. The
   *  stale check compares it with the stored value to the microsecond, so it
   *  is never re-formatted (a JS Date drops microseconds; two production
   *  orders carry them). */
  neededBy: string | null;
  /** The order's status: what saving does to its Schedule entry depends on it. */
  status: string;
  /** The ORG's zone, resolved as the server resolves it before converting
   *  (core resolveOrgTimezone of organizations.timezone). */
  timeZone: string;
  /** "Needed by Fri, Oct 3, 2:00 PM" or "No needed-by date" (core). */
  rowLabel: string;
}

/** The caller's warehouse access, as far as this decision reads it
 *  (lib/auth/warehouse WarehouseAccess). */
export interface NeededByChangeAccess {
  hasAllAccess: boolean;
  writableIds: string[];
}

/**
 * The Change entry for this viewer, or null when the save would refuse them or
 * the dialog could not say which zone it works in.
 *
 *   - `orders:approve` (a manager holds it by role) and an open order (core
 *     isNeededByRevisable): the service's and the function's gates.
 *   - Write access to the order's warehouse, as the service asserts it
 *     (assertWarehouseAccess 'write'): never a viewer; everyone a manager or
 *     above by role (roleSeesEveryWarehouse, which the function's
 *     user_can_access_inventory agrees with); anyone else only with the
 *     all-warehouses flag or the order's warehouse among their writable ones.
 *     An access read that failed is no access (it answers empty lists).
 *   - The org's zone READ: the readiness facts the page already has carry
 *     organizations.timezone (0377 order.timeZone), the column the service
 *     converts in. When that read failed, the page prints in a fallback zone,
 *     and a preview in a guessed zone would promise a time the save does not
 *     write, so there is no entry until the read succeeds (Check again).
 */
export function neededByChangeView(input: {
  orderId: string;
  status: string;
  neededBy: string | null;
  warehouseId: string;
  canApprove: boolean;
  role: Role;
  /** lib/auth/warehouse roleSeesEveryWarehouse(role): the role alone gives
   *  every warehouse. */
  roleSeesEveryWarehouse: boolean;
  /** The caller's warehouse access, read only when the role does not decide
   *  (null otherwise, or when it was not read). */
  access: NeededByChangeAccess | null;
  /** The readiness read the org's zone comes from (null when not read). */
  zoneFacts: OrderReadinessResult | null;
  now?: number;
}): NeededByChangeView | null {
  if (!input.canApprove || !isNeededByRevisable(input.status)) return null;
  if (input.role === 'viewer') return null;
  const canWrite =
    input.roleSeesEveryWarehouse ||
    (input.access !== null &&
      (input.access.hasAllAccess || input.access.writableIds.includes(input.warehouseId)));
  if (!canWrite) return null;
  if (input.zoneFacts?.state !== 'ok') return null;
  const timeZone = resolveOrgTimezone(input.zoneFacts.assessment.order.timeZone);
  return {
    orderId: input.orderId,
    neededBy: input.neededBy,
    status: input.status,
    timeZone,
    rowLabel: neededByRowCopy(input.neededBy, timeZone, input.now),
  };
}

/** What the date and time field holds, read in the org's zone. */
export type NeededByDraft =
  | { kind: 'empty' }
  | { kind: 'invalid'; message: string }
  | { kind: 'past'; message: string }
  | { kind: 'ok'; instant: number; preview: string };

/**
 * Reads the datetime-local value ("YYYY-MM-DDTHH:mm") as a wall clock in the
 * ORG's zone, strictly, exactly as the server will (core wallClockToInstant):
 * a time that does not exist there (the spring-forward hour) is refused, and
 * so is one already past. `preview` is core's "New needed-by: Fri, Oct 3,
 * 2:00 PM", in the same zone. Never the browser's zone.
 */
export function readNeededByDraft(value: string, timeZone: string, now: number): NeededByDraft {
  if (value.trim() === '') return { kind: 'empty' };
  let at: number | null;
  try {
    at = wallClockToInstant(value, timeZone);
  } catch {
    // A zone this browser's Intl cannot read: never guess an instant.
    at = null;
  }
  if (at === null) return { kind: 'invalid', message: neededByInvalidTimeCopy(timeZone) };
  if (at <= now) return { kind: 'past', message: NEEDED_BY_IN_PAST_COPY };
  return { kind: 'ok', instant: at, preview: neededByPreviewCopy(at, timeZone, now) };
}

/**
 * The field's starting value: the current needed-by as a wall clock in the
 * org's zone when it is still to come, else empty (a past date would only be
 * refused).
 */
export function initialNeededByWallClock(neededBy: string | null, timeZone: string, now: number): string {
  if (!neededBy) return '';
  const at = Date.parse(neededBy);
  if (!Number.isFinite(at) || at <= now) return '';
  try {
    return formatWallClock(at, timeZone);
  } catch {
    return '';
  }
}

/** The earliest wall clock the field offers (now, in the org's zone). Empty
 *  when the zone cannot be read here (the field then offers any time and the
 *  preview says it cannot be read). */
export function minNeededByWallClock(timeZone: string, now: number): string {
  try {
    return formatWallClock(now, timeZone);
  } catch {
    return '';
  }
}

/**
 * The needed-by the save says it started from (the stale check's expected
 * value): what the person saw when they opened the dialog, or, after a stale
 * refusal, the value the server said was current. When the page behind has
 * since been read again and holds that same instant, its text is sent
 * instead: it is exactly what PostgREST printed (microseconds included),
 * where the refusal's value went through a JS Date.
 */
export function neededByExpectedToSend(seen: string | null, onPage: string | null): string | null {
  if (seen !== null && onPage !== null && Date.parse(seen) === Date.parse(onPage)) return onPage;
  return seen;
}
