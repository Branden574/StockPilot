import { Lock } from 'lucide-react';

import { requireOrgContext } from '@/lib/auth/session';
import { Card, CardContent } from '@/components/ui/card';

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
    return (
      <div className="container mx-auto flex max-w-2xl items-center justify-center px-4 py-20 sm:px-6">
        <Card className="w-full">
          <CardContent className="flex flex-col items-center gap-4 py-12 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted/50 text-muted-foreground">
              <Lock className="h-5 w-5" aria-hidden="true" />
            </div>
            <div className="space-y-1.5">
              <h1 className="text-xl font-semibold tracking-tight">
                You don&apos;t have access to purchase orders
              </h1>
              <p className="max-w-sm text-sm text-muted-foreground">
                Viewing purchase orders needs the &ldquo;View purchase
                orders&rdquo; permission, which isn&apos;t enabled for your
                account.
              </p>
            </div>
            <p className="mt-2 text-sm text-muted-foreground">
              Ask an owner or admin to enable it from Settings → Roles &amp;
              permissions.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }
  return <>{children}</>;
}
