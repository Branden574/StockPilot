// NOTE: this PO-imports gate is being superseded by the configurable-permissions
// feature (P2) so an admin can grant Read-Only Auditors import access. Until then
// it shows a clear access message (no longer a silent bounce to home).
import { StatePanel } from '@/components/patterns/state-panel';
import { requireOrgContext } from '@/lib/auth/session';

import { can } from '@stockpilot/core';

/**
 * Gates the entire /dashboard/purchase-orders/imports/* tree on
 * purchase_orders:manage. PO-import actions (create, process, retry) all assert
 * that permission server-side. Without this layout the pages render for
 * viewers/staff and only fail on action — confusing.
 *
 * A user without the permission (e.g. a Read-Only Auditor / viewer) previously
 * got a silent redirect('/dashboard') — which read as the app "kicking them to
 * the home screen" for no reason. Show a clear access-denied message instead:
 * P2.6's StatePanel (kind forbidden, page size, its title the page's only h1),
 * inside the page's gutters, as PoAccessDenied draws it.
 */
export default async function PoImportsLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireOrgContext();
  if (!can(ctx, 'purchase_orders:manage')) {
    return (
      <div className="w-full px-4 py-16 sm:px-8 sm:py-24">
        <StatePanel
          kind="forbidden"
          size="page"
          headingLevel={1}
          title="PO imports are manager-only"
          description={
            <>
              Uploading and processing purchase-order imports needs the &ldquo;Manage purchase
              orders&rdquo; permission. Your role has view-only access.
            </>
          }
          action={
            <p className="text-muted-foreground text-[13.5px]">
              Ask an owner, admin, or manager to run the import.
            </p>
          }
        />
      </div>
    );
  }
  return <>{children}</>;
}
