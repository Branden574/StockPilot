import { requireOrgContext } from '@/lib/auth/session';
import { PoAccessDenied } from '@/components/po/po-access-denied';

import { can } from '@stockpilot/core';

/**
 * Gates the entire /dashboard/purchase-orders/* tree on purchase_orders:read.
 *
 * Without this, a user whose "View purchase orders" permission was revoked via
 * a role/user override still saw the list (it relies on RLS, which lets any org
 * member read) and then HIT A 500 on the detail page — PurchaseOrdersService
 * read methods assertPermission('purchase_orders:read'), which threw uncaught
 * and tripped the dashboard error boundary ("Something broke loading this
 * page"). Gating the section here turns both into one clean access message,
 * and the matching sidebar link is hidden because its placement requires the
 * same permission (registry: purchase_orders web_sidebar requires
 * purchase_orders:read). Manage-only sub-trees (imports, recurring) keep their
 * own purchase_orders:manage gate inside this one.
 */
export default async function PurchaseOrdersLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const ctx = await requireOrgContext();
  if (!can(ctx, 'purchase_orders:read')) {
    return <PoAccessDenied />;
  }
  return <>{children}</>;
}
