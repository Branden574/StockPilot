import Link from 'next/link';
import { redirect } from 'next/navigation';

import { PublicTokenControls } from '@/components/orders/public-token-controls';
import { hasPermission } from '@stockpilot/core';
import { requireOrgContext } from '@/lib/auth/session';
import { OrderRequestsService } from '@/server/services/order-requests';
import { WarehousesService } from '@/server/services/warehouses';

export default async function PublicRequestsSettingsPage() {
  const ctx = await requireOrgContext();
  if (!hasPermission(ctx.role, 'orders:approve')) {
    redirect('/dashboard');
  }

  const [orderSvc, warehousesSvc] = await Promise.all([
    OrderRequestsService.forCurrentUser(),
    WarehousesService.forCurrentUser(),
  ]);
  const [settings, warehouses] = await Promise.all([
    orderSvc.getPublicSettings(),
    warehousesSvc.list(),
  ]);

  const publicWarehouseSet = new Set(settings.publicOrderableWarehouseIds);
  const warehouseRows = warehouses.map((w) => ({
    id: w.id,
    name: w.name,
    isPublicOrderable: publicWarehouseSet.has(w.id),
  }));

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://stockpilotusa.com';

  return (
    <div className="container mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <div className="mb-6">
        <Link
          href="/dashboard/settings"
          className="text-muted-foreground hover:text-foreground inline-flex items-center text-sm"
        >
          ← Back to settings
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">
          Public requests
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Lets external partners submit book requests through a shared link.
          You stay in control of which warehouses and which items show up.
        </p>
      </div>

      <PublicTokenControls
        appUrl={appUrl}
        initialToken={settings.token}
        initialBlurb={settings.blurb}
        warehouses={warehouseRows}
      />
    </div>
  );
}
