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
 */
export const getActiveWarehouseFilter = cache(async (): Promise<string | null> => {
  const access = await getWarehouseAccess();
  if (!access.hasAllAccess) return null;

  const c = await cookies();
  const raw = c.get(COOKIE_NAME)?.value;
  if (!raw) return null;
  if (!access.readableIds.includes(raw)) return null;
  return raw;
});

export const WAREHOUSE_FILTER_COOKIE = COOKIE_NAME;
