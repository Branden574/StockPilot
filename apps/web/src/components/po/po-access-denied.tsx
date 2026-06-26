import { Lock } from 'lucide-react';

import { Card, CardContent } from '@/components/ui/card';

/**
 * Shown when a user lacks purchase_orders:read. Rendered by both the
 * /purchase-orders section layout AND each PO page directly — the page-level
 * guard is the authoritative one, because Next renders a page concurrently with
 * its layout, so a page that throws (e.g. a service assertPermission) would trip
 * the error boundary ("Something broke loading this page") BEFORE the layout's
 * gate could show this card. Gating in-page, before any throwing service call,
 * guarantees the clean denial.
 */
export function PoAccessDenied() {
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
              Viewing purchase orders needs the &ldquo;View purchase orders&rdquo;
              permission, which isn&apos;t enabled for your account.
            </p>
          </div>
          <p className="mt-2 text-sm text-muted-foreground">
            Ask an owner or admin to enable it from Settings → Roles &amp; permissions.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
