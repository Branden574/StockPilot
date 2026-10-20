import { redirect } from 'next/navigation';

import { BundleForm } from '@/components/bundles/bundle-form';
import { PageHeader, PageHeaderBackLink } from '@/components/patterns/page-header';
import { can } from '@stockpilot/core';
import { requireOrgContext } from '@/lib/auth/session';

/** The form page area (DESIGN-SPEC 4 and 5.3): the page box at a form's width. */
const PAGE = 'mx-auto flex w-full max-w-[880px] flex-col gap-4 px-4 pb-16 pt-6 sm:px-8 sm:pt-7';

export default async function NewBundlePage() {
  const ctx = await requireOrgContext();
  if (!can(ctx, 'bundles:manage')) {
    redirect('/dashboard/bundles');
  }

  return (
    <div className={PAGE}>
      <PageHeader
        back={<PageHeaderBackLink href="/dashboard/bundles">← Back to bundles</PageHeaderBackLink>}
        title="New bundle"
        subline={
          <span className="block max-w-[640px]">
            Define a reusable kit. Choose components and per-kit quantities. Optionally enable
            pre-assembly to box kits ahead of distribution.
          </span>
        }
      />
      <BundleForm />
    </div>
  );
}
