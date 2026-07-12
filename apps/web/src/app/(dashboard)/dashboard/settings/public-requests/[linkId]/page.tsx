import Link from 'next/link';
import { notFound } from 'next/navigation';

import { ModuleNotEnabled } from '@/components/dashboard/module-not-enabled';
import { PublicLinkEditor } from '@/components/settings/public-link-editor';
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
      <div className="container mx-auto max-w-3xl px-4 py-8 sm:px-6">
        <div className="bg-card rounded-xl border p-8 text-center">
          <h1 className="text-lg font-semibold">Public request link</h1>
          <p className="text-muted-foreground mx-auto mt-2 max-w-md text-sm">
            You need the “Manage public links” permission to edit public
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
    <div className="container mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <div className="mb-6">
        <Link
          href="/dashboard/settings/public-requests"
          className="text-muted-foreground hover:text-foreground inline-flex items-center text-sm"
        >
          ← Back to public requests
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">{link.name}</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Configure what this link exposes and how requests are limited.
          Changes go live on the public page immediately.
        </p>
      </div>

      <PublicLinkEditor
        appUrl={appUrl}
        link={link}
        categories={categories}
        warehouses={warehouses}
        initialEffective={effective}
        initialRows={initial.rows}
        initialTotal={initial.total}
      />
    </div>
  );
}
