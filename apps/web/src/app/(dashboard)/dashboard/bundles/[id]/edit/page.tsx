import { notFound, redirect } from 'next/navigation';

import { BundleForm } from '@/components/bundles/bundle-form';
import { PageHeader, PageHeaderBackLink } from '@/components/patterns/page-header';
import { can } from '@stockpilot/core';
import { requireOrgContext } from '@/lib/auth/session';
import { notFoundUnlessUuid } from '@/server/lib/path-id';
import { BundlesService } from '@/server/services/bundles';

/** The form page area (DESIGN-SPEC 4 and 5.3): the page box at a form's width. */
const PAGE = 'mx-auto flex w-full max-w-[880px] flex-col gap-4 px-4 pb-16 pt-6 sm:px-8 sm:pt-7';

export default async function EditBundlePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // A malformed id (a mistyped or cut-off link) is Page not found before
  // anything is read with it (B63).
  notFoundUnlessUuid(id);
  const ctx = await requireOrgContext();
  if (!can(ctx, 'bundles:manage')) {
    redirect(`/dashboard/bundles/${id}`);
  }

  const svc = await BundlesService.forCurrentUser();
  let detail;
  try {
    detail = await svc.get(id);
  } catch {
    notFound();
  }

  return (
    <div className={PAGE}>
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
