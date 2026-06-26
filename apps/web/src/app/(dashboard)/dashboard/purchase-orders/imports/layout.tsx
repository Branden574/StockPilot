// NOTE: this PO-imports gate is being superseded by the configurable-permissions
// feature (P2) so an admin can grant Read-Only Auditors import access. Until then
// it shows a clear access message (no longer a silent bounce to home).
import { Lock } from 'lucide-react';

import { requireOrgContext } from '@/lib/auth/session';
import { Card, CardContent } from '@/components/ui/card';

import { can } from '@stockpilot/core';

/**
 * Gates the entire /dashboard/purchase-orders/imports/* tree on
 * purchase_orders:manage. PO-import actions (create, process, retry) all assert
 * that permission server-side. Without this layout the pages render for
 * viewers/staff and only fail on action — confusing.
 *
 * A user without the permission (e.g. a Read-Only Auditor / viewer) previously
 * got a silent redirect('/dashboard') — which read as the app "kicking them to
 * the home screen" for no reason. Show a clear access-denied message instead.
 */
export default async function PoImportsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const ctx = await requireOrgContext();
  if (!can(ctx, 'purchase_orders:manage')) {
    return (
      <div className="container mx-auto flex max-w-2xl items-center justify-center px-4 py-20 sm:px-6">
        <Card className="w-full">
          <CardContent className="flex flex-col items-center gap-4 py-12 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted/50 text-muted-foreground">
              <Lock className="h-5 w-5" aria-hidden="true" />
            </div>
            <div className="space-y-1.5">
              <h1 className="text-xl font-semibold tracking-tight">PO imports are manager-only</h1>
              <p className="max-w-sm text-sm text-muted-foreground">
                Uploading and processing purchase-order imports needs the
                &ldquo;Manage purchase orders&rdquo; permission. Your role has
                view-only access.
              </p>
            </div>
            <p className="mt-2 text-sm text-muted-foreground">
              Ask an owner, admin, or manager to run the import.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }
  return <>{children}</>;
}
