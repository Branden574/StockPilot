import Link from 'next/link';
import { notFound } from 'next/navigation';

import { ModuleNotEnabled } from '@/components/dashboard/module-not-enabled';
import { PageHeader, PageHeaderBackLink } from '@/components/patterns/page-header';
import { StatePanel } from '@/components/patterns/state-panel';
import { PublicLinkEditor } from '@/components/settings/public-link-editor';
import { SettingsPage } from '@/components/settings/settings-nav';
import { can } from '@stockpilot/core';
import { requireOrgContext } from '@/lib/auth/session';
import { checkModuleAccess } from '@/lib/modules/module-gate';
import { CategoriesService } from '@/server/services/categories';
import { ServiceError } from '@/server/services/context';
import { PublicLinksService, type PublicLinkRow } from '@/server/services/public-links';
import { WarehousesService } from '@/server/services/warehouses';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function PublicLinkEditorPage({
  params,
}: {
  params: Promise<{ linkId: string }>;
}) {
  const { linkId } = await params;
  if (!UUID_RE.test(linkId)) notFound();

  const ctx = await requireOrgContext();

  const access = await checkModuleAccess('public_requests');
  if (!access.enabled) {
    return <ModuleNotEnabled moduleId="public_requests" canManage={access.canManage} />;
  }

  if (!can(ctx, 'public_links:manage')) {
    return (
      <SettingsPage>
        <StatePanel
          kind="forbidden"
          size="page"
          headingLevel={1}
          title="Public request link"
          description={
            <>
              You need the “Manage public links” permission to edit public request links. Ask an
              owner or admin to grant it under Settings → Roles &amp; permissions.
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

  const svc = await PublicLinksService.forCurrentUser();
  let link: PublicLinkRow;
  try {
    link = await svc.get(linkId);
  } catch (e) {
    if (e instanceof ServiceError && e.code === 'not_found') notFound();
    throw e;
  }

  const [categoriesSvc, warehousesSvc] = await Promise.all([
    CategoriesService.forCurrentUser(),
    WarehousesService.forCurrentUser(),
  ]);
  const [categoriesRaw, warehouses, effective, initial] = await Promise.all([
    categoriesSvc.list(),
    warehousesSvc.listNames(),
    svc.effectiveCatalogCount(linkId),
    svc.searchCandidates(linkId, { page: 1, pageSize: 25 }),
  ]);

  const categories = (categoriesRaw as Array<{ id: string; name: string }>).map((c) => ({
    id: c.id,
    name: c.name,
  }));

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://stockpilotusa.com';

  return (
    <SettingsPage width="wide">
      <PageHeader
        title={link.name}
        subline="Configure what this link exposes and how requests are limited. Changes go live on the public page immediately."
        back={
          <PageHeaderBackLink href="/dashboard/settings/public-requests">
            ← Back to public requests
          </PageHeaderBackLink>
        }
      />

      <PublicLinkEditor
        appUrl={appUrl}
        link={link}
        categories={categories}
        warehouses={warehouses}
        initialEffective={effective}
        initialRows={initial.rows}
        initialTotal={initial.total}
      />
    </SettingsPage>
  );
}
