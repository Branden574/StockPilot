import Link from 'next/link';

import { ModuleUnavailable } from '@/components/dashboard/module-unavailable';
import { PageHeader, PageHeaderBackLink } from '@/components/patterns/page-header';
import { StatePanel } from '@/components/patterns/state-panel';
import { PublicLinksManager } from '@/components/settings/public-links-manager';
import { PublicRequestsGlobalSettings } from '@/components/settings/public-requests-global-settings';
import { SettingsPage, SettingsPanel } from '@/components/settings/settings-nav';
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
    return <ModuleUnavailable moduleId="public_requests" access={access} />;
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
      <SettingsPage>
        <StatePanel
          kind="forbidden"
          size="page"
          headingLevel={1}
          title="Public request links"
          description={
            <>
              You need the “Manage public links” permission to configure public request links. Ask
              an owner or admin to grant it under Settings → Roles &amp; permissions.
            </>
          }
          action={
            <Link
              href="/dashboard/settings"
              className="text-accent hover:text-foreground text-[13px] transition-colors hover:underline"
            >
              ← Back to settings
            </Link>
          }
        />
      </SettingsPage>
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
    <SettingsPage width="wide">
      <PageHeader
        title="Public requests"
        subline="Share curated request links with external partners. Each link controls exactly which items and books the public can see and request."
        back={
          <PageHeaderBackLink href="/dashboard/settings">← Back to settings</PageHeaderBackLink>
        }
      />

      {canManageLinks && links ? (
        <PublicLinksManager appUrl={appUrl} links={links} />
      ) : (
        <SettingsPanel
          title="Request links"
          description={
            <>
              You need the “Manage public links” permission to view or edit the curated request
              links. Ask an owner or admin to grant it under Settings → Roles &amp; permissions.
            </>
          }
        />
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
    </SettingsPage>
  );
}
