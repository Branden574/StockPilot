import 'server-only';

import { getWarehouseAccess } from '@/lib/auth/warehouse';
import { getWarehousesForRequest } from '@/lib/dashboard/request-cache';
import { requireOrgContext } from '@/lib/auth/session';
import { buildWarehouseScope, scopedWarehouseMessage } from '@/lib/warehouse-scope';

/**
 * Subtle info line for warehouse-scoped users (staff/viewer with warehouse
 * assignments): names exactly what they're looking at and where an admin can
 * widen it. Renders nothing for all-access roles, so dropping it under a page
 * header is a no-op for managers+.
 *
 * Zero extra round-trips in practice: `getWarehouseAccess()` (no-arg — the
 * SAME memo key the dashboard layout uses at layout.tsx:81; passing a ctx
 * would fork React.cache's per-args memo and re-query) and
 * `getWarehousesForRequest` are both request-cached from the layout render.
 */
export async function ScopedWarehouseNotice({ className }: { className?: string }) {
  const access = await getWarehouseAccess();
  if (access.hasAllAccess) return null;
  const ctx = await requireOrgContext();
  const warehouses = await getWarehousesForRequest(ctx.organizationId);
  const message = scopedWarehouseMessage(buildWarehouseScope(access, warehouses));
  if (!message) return null;
  return <p className={className ?? 'text-muted-foreground mt-1 text-xs'}>{message}</p>;
}
