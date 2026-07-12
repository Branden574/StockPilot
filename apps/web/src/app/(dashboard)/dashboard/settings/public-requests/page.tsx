import Link from 'next/link';

import { ModuleNotEnabled } from '@/components/dashboard/module-not-enabled';
import { PublicLinksManager } from '@/components/settings/public-links-manager';
import { PublicRequestsGlobalSettings } from '@/components/settings/public-requests-global-settings';
import { can } from '@stockpilot/core';
import { requireOrgContext } from '@/lib/auth/session';
import { checkModuleAccess } from '@/lib/modules/module-gate';
import { OrderRequestsService } from '@/server/services/order-requests';
import { PublicLinksService } from '@/server/services/public-links';
import { WarehousesService } from '@/server/services/warehouses';

export default async function PublicRequestsSettingsPage() {
  const ctx = await requireOrgContext();

  // Gate the page on the module first: link reads assert public_requests is
  // enabled and THROW module_disabled otherwise. Render the graceful
  // not-enabled state instead of the dashboard error boundary.
  const access = await checkModuleAccess('public_requests');
  if (!access.enabled) {
    return <ModuleNotEnabled moduleId="public_requests" canManage={access.canManage} />;
  }

  // Two independent capabilities live on this page (review finding
  // 2026-07-12: the links gate must not lock organization:update holders out
  // of the org-wide blurb/warehouse controls they had before 0261):
  // - links/catalog management → public_links:manage (service gate + RLS)
  // - blurb + warehouse toggles → organization:update (their services/RLS)
  // Full-page 403 only when the caller holds NEITHER.
  const canManageLinks = can(ctx, 'public_links:manage');
  const canManageOrg = can(ctx, 'organization:update');
  if (!canManageLinks && !canManageOrg) {
    return (
      <div className="container mx-auto max-w-3xl px-4 py-8 sm:px-6">
        <div className="bg-card rounded-xl border p-8 text-center">
          <h1 className="text-lg font-semibold">Public request links</h1>
          <p className="text-muted-foreground mx-auto mt-2 max-w-md text-sm">
            You need the “Manage public links” permission to configure public
            request links. Ask an owner or admin to grant it under Settings →
            Roles &amp; permissions.
          </p>
          <Link
            href="/dashboard/settings"
            className="text-primary mt-4 inline-block text-sm hover:underline"
          >
            ← Back to settings
          </Link>
        </div>
      </div>
    );
  }

  const warehousesSvc = await WarehousesService.forCurrentUser();
  const linksSvc = canManageLinks ? await PublicLinksService.forCurrentUser() : null;
  const orderSvc = canManageOrg ? await OrderRequestsService.forCurrentUser() : null;
  const [links, warehouses, settings] = await Promise.all([
    linksSvc ? linksSvc.list() : Promise.resolve(null),
    warehousesSvc.listNames(),
    orderSvc ? orderSvc.getPublicSettings() : Promise.resolve(null),
  ]);

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://stockpilotusa.com';

  return (
    <div className="container mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <div className="mb-6">
        <Link
          href="/dashboard/settings"
          className="text-muted-foreground hover:text-foreground inline-flex items-center text-sm"
        >
          ← Back to settings
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Public requests</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Share curated request links with external partners. Each link
          controls exactly which items and books the public can see and
          request.
        </p>
      </div>

      <div className="space-y-6">
        {canManageLinks && links ? (
          <PublicLinksManager appUrl={appUrl} links={links} />
        ) : (
          <div className="bg-card rounded-xl border p-5">
            <h2 className="text-sm font-semibold">Request links</h2>
            <p className="text-muted-foreground mt-1 text-sm">
              You need the “Manage public links” permission to view or edit
              the curated request links. Ask an owner or admin to grant it
              under Settings → Roles &amp; permissions.
            </p>
          </div>
        )}

        {canManageOrg && settings ? (
          <PublicRequestsGlobalSettings
            initialBlurb={settings.blurb}
            warehouses={warehouses.map((w) => ({
              id: w.id,
              name: w.name,
              isPublicOrderable: settings.publicOrderableWarehouseIds.includes(w.id),
            }))}
          />
        ) : null}
      </div>
    </div>
  );
}
