import 'server-only';

import { getWarehouseAccess } from '@/lib/auth/warehouse';
import { getWarehousesForRequest } from '@/lib/dashboard/request-cache';
import { requireOrgContext } from '@/lib/auth/session';
import { buildWarehouseScope, scopedWarehouseMessage } from '@/lib/warehouse-scope';
import { isManagerOrAbove, type Role } from '@stockpilot/core';

/**
 * Subtle info line for warehouse-scoped users (staff/viewer with warehouse
 * assignments): names exactly what they're looking at and where an admin can
 * widen it. Renders nothing for all-access roles, so dropping it under a page
 * header is a no-op for managers+.
 *
 * Manager-and-above return before any warehouse read. getWarehouseAccess()
 * answers hasAllAccess = true for them on the SAME isManagerOrAbove(role)
 * test (lib/auth/warehouse.ts), whatever its `warehouses` read returns, so the
 * notice was always null for them; awaiting that read first still held the
 * page's single reveal on it, and on a client-side navigation the layout does
 * not re-render to have warmed it. Staff/viewer (the 0280 all-warehouses flag
 * included) take the unchanged path below.
 *
 * For them, `getWarehouseAccess()` stays no-arg — the SAME memo key the
 * dashboard layout uses at layout.tsx:80; passing a ctx would fork
 * React.cache's per-args memo and re-query — and `getWarehousesForRequest` is
 * request-cached too.
 */
export async function ScopedWarehouseNotice({ className }: { className?: string }) {
  const ctx = await requireOrgContext();
  if (isManagerOrAbove(ctx.role as Role)) return null;
  const access = await getWarehouseAccess();
  if (access.hasAllAccess) return null;
  const warehouses = await getWarehousesForRequest(ctx.organizationId);
  const message = scopedWarehouseMessage(buildWarehouseScope(access, warehouses));
  if (!message) return null;
  return <p className={className ?? 'text-muted-foreground mt-1 text-xs'}>{message}</p>;
}
