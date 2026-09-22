import 'server-only';

import { cookies } from 'next/headers';
import { cache } from 'react';

import { getWarehouseAccess } from '@/lib/auth/warehouse';

const COOKIE_NAME = 'sp_warehouse_filter';

/**
 * Returns the active warehouse filter id for the current request, or null.
 *
 * Behavior:
 *   • Warehouse-scoped users (staff/viewer): always returns null. Their queries
 *     are forced to assigned warehouses inside the service layer.
 *   • Managers/admins: returns the cookie value if it points to a warehouse
 *     they can read, otherwise null. This is purely a view filter — it cannot
 *     escalate access since access is enforced server-side regardless.
 *
 * COOKIE FIRST. With no cookie every role gets null, so that answer needs no
 * access lookup. It used to await getWarehouseAccess() before looking, which
 * for a manager waits on the `warehouses` read (and for staff/viewer on the
 * assignments + membership reads) in front of the Items/Books table's own
 * reads, only to return null for the visitor who never picked a warehouse. The
 * layout's request-cached copy does not help there: a client-side navigation
 * re-renders only the page segment, not the shared layout (Next's staleTimes
 * doc), so the page issues those reads itself. Calls from Vercel to Supabase
 * stall 1-8 s at Supabase's entry point on 3-5% of weekday calls (logs,
 * 2026-09-22), so each read the rows wait on is another chance to stall the
 * page. When the cookie IS present it is checked against the readable ids
 * exactly as before, so a stale or forged cookie still resolves null.
 */
export const getActiveWarehouseFilter = cache(async (): Promise<string | null> => {
  const c = await cookies();
  const raw = c.get(COOKIE_NAME)?.value;
  if (!raw) return null;

  const access = await getWarehouseAccess();
  if (!access.hasAllAccess) return null;
  if (!access.readableIds.includes(raw)) return null;
  return raw;
});

/**
 * Route-handler variant. `getActiveWarehouseFilter()` resolves auth via the
 * zero-arg `getWarehouseAccess()`, whose `requireOrgContext()` fallback
 * throws NEXT_REDIRECT outside a page render (no x-pathname header) — a
 * route handler that calls it 500s. API routes already hold a ctx from
 * `withApiContext`; passing it here skips that fallback entirely. Bearer
 * callers carry no cookies, so they simply resolve to null (no filter).
 */
export async function getActiveWarehouseFilterFor(ctx: {
  organizationId: string;
  userId: string;
  role: string;
}): Promise<string | null> {
  const access = await getWarehouseAccess(ctx as Parameters<typeof getWarehouseAccess>[0]);
  if (!access.hasAllAccess) return null;

  const c = await cookies();
  const raw = c.get(COOKIE_NAME)?.value;
  if (!raw) return null;
  if (!access.readableIds.includes(raw)) return null;
  return raw;
}

export const WAREHOUSE_FILTER_COOKIE = COOKIE_NAME;
