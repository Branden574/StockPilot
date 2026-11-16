import { authenticatorSetUpOwedForLayout, requireOrgContextForLayout } from '@/lib/auth/session';
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
 *
 * A member who must set up an authenticator first is sent to set-up by the
 * page they asked for (requireOrgContext()), and a layout never redirects for
 * it. So for such a member the layout renders the page, whose rule sends them
 * there, instead of the access panel (authenticatorSetUpOwedForLayout gives
 * the page's own answer).
 */
export default async function PurchaseOrdersLayout({ children }: { children: React.ReactNode }) {
  // The layout's context: no set-up redirect from a layout (lib/auth/session.ts).
  const ctx = await requireOrgContextForLayout();
  if (!can(ctx, 'purchase_orders:read')) {
    if (await authenticatorSetUpOwedForLayout()) return <>{children}</>;
    return <PoAccessDenied />;
  }
  return <>{children}</>;
}
