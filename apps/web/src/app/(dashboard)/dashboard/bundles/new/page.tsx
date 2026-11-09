import { redirect } from 'next/navigation';

import { BundleForm } from '@/components/bundles/bundle-form';
import { PageHeader, PageHeaderBackLink } from '@/components/patterns/page-header';
import { can } from '@stockpilot/core';
import { requireOrgContext } from '@/lib/auth/session';

// The Liquid Glass operations composition (stage 4: pages/ops.css, the
// shared frame, and the board's own file where there is one): every rule is
// scoped to this page's [data-glass-page] root and to glass, so Classic never
// matches it (styles/liquid-glass/glass-scope.guard.test.ts).
import '@/styles/liquid-glass/pages/ops.css';

/** The form page area (DESIGN-SPEC 4 and 5.3): the page box at a form's width. */
const PAGE = 'mx-auto flex w-full max-w-[880px] flex-col gap-4 px-4 pb-16 pt-6 sm:px-8 sm:pt-7';

export default async function NewBundlePage() {
  const ctx = await requireOrgContext();
  if (!can(ctx, 'bundles:manage')) {
    redirect('/dashboard/bundles');
  }

  return (
    <div
      className={PAGE}
      data-glass-page="ops"
      data-glass-view="bundle-new"
      data-glass-width="form"
    >
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
