import { notFound, redirect } from 'next/navigation';

import { BundleForm } from '@/components/bundles/bundle-form';
import { ModuleUnavailable } from '@/components/dashboard/module-unavailable';
import { PageHeader, PageHeaderBackLink } from '@/components/patterns/page-header';
import { can } from '@stockpilot/core';
import { requireOrgContext } from '@/lib/auth/session';
import { checkModuleAccess } from '@/lib/modules/module-gate';
import { notFoundUnlessUuid } from '@/server/lib/path-id';
import { BundlesService } from '@/server/services/bundles';
import { ServiceError } from '@/server/services/context';

// The Liquid Glass operations composition (stage 4: pages/ops.css, the
// shared frame, and the board's own file where there is one): every rule is
// scoped to this page's [data-glass-page] root and to glass, so Classic never
// matches it (styles/liquid-glass/glass-scope.guard.test.ts).
import '@/styles/liquid-glass/pages/ops.css';

/** The form page area (DESIGN-SPEC 4 and 5.3): the page box at a form's width. */
const PAGE = 'mx-auto flex w-full max-w-[880px] flex-col gap-4 px-4 pb-16 pt-6 sm:px-8 sm:pt-7';

export default async function EditBundlePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // A malformed id (a mistyped or cut-off link) is Page not found before
  // anything is read with it (B63).
  notFoundUnlessUuid(id);
  // Bundles off (a stale link) is the module-off panel, before anything is read:
  // the read below would refuse with module_disabled and reach the error page (B66).
  const moduleAccess = await checkModuleAccess('bundles');
  if (!moduleAccess.enabled) {
    return <ModuleUnavailable moduleId="bundles" access={moduleAccess} />;
  }
  const ctx = await requireOrgContext();
  if (!can(ctx, 'bundles:manage')) {
    redirect(`/dashboard/bundles/${id}`);
  }

  const svc = await BundlesService.forCurrentUser();
  let detail;
  try {
    detail = await svc.get(id);
  } catch (e) {
    // Only a missing bundle is Page not found. A failed read reaches the error
    // page, which says the page could not be loaded, offers Try again and
    // reports it; it used to tell the person the bundle did not exist (B66).
    if (e instanceof ServiceError && e.code === 'not_found') notFound();
    throw e;
  }

  return (
    <div
      className={PAGE}
      data-glass-page="ops"
      data-glass-view="bundle-edit"
      data-glass-width="form"
    >
      <PageHeader
        back={
          <PageHeaderBackLink href={`/dashboard/bundles/${id}`}>
            ← Back to bundle
          </PageHeaderBackLink>
        }
        title="Edit bundle"
      />
      <BundleForm
        initial={{
          id: detail.bundle.id,
          name: detail.bundle.name,
          sku: detail.bundle.sku,
          description: detail.bundle.description,
          preassemblyEnabled: detail.bundle.preassembly_enabled,
          components: detail.components.map((c) => ({
            itemId: c.itemId,
            itemName: c.itemName,
            itemSku: c.itemSku,
            quantity: c.quantity,
            isOptional: c.isOptional,
          })),
        }}
      />
    </div>
  );
}
