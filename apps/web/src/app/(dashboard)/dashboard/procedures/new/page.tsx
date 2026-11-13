import { ArrowLeft } from 'lucide-react';
import { notFound, redirect } from 'next/navigation';

import { PageHeader, PageHeaderBackLink } from '@/components/patterns/page-header';
import { ProcedureForm } from '@/components/procedures/procedure-form';
import { requireOrgContext } from '@/lib/auth/session';
import { can } from '@stockpilot/core';
import { ProcedureCategoriesService } from '@/server/services/procedure-categories';
import { WarehousesService } from '@/server/services/warehouses';

// The Liquid Glass operations composition (stage 4: pages/ops.css, the
// shared frame, and the board's own file where there is one): every rule is
// scoped to this page's [data-glass-page] root and to glass, so Classic never
// matches it (styles/liquid-glass/glass-scope.guard.test.ts).
import '@/styles/liquid-glass/pages/ops.css';

export const dynamic = 'force-dynamic';

export default async function NewProcedurePage() {
  const ctx = await requireOrgContext();
  if (!can(ctx, 'categories:manage')) {
    notFound();
  }

  const [catService, whService] = await Promise.all([
    ProcedureCategoriesService.forCurrentUser(),
    WarehousesService.forCurrentUser(),
  ]);
  const [categories, warehouses] = await Promise.all([catService.list(), whService.listNames()]);

  if (!ctx.organizationId) redirect('/dashboard');

  return (
    <div
      className="mx-auto flex w-full max-w-[760px] flex-col gap-6 px-4 pb-16 pt-6 sm:px-8 sm:pt-7"
      data-glass-page="ops"
      data-glass-view="procedure-new"
      data-glass-width="form"
    >
      <PageHeader
        back={
          <PageHeaderBackLink href="/dashboard/procedures">
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Back to procedures
          </PageHeaderBackLink>
        }
        title="New procedure"
        subline="Capture the steps. Drop videos in below — they'll upload after you save."
      />
      <div>
        <ProcedureForm
          mode="create"
          categories={categories.map((c) => ({ id: c.id, name: c.name, color: c.color }))}
          warehouses={warehouses.map((w) => ({ id: w.id, name: w.name }))}
          userId={ctx.userId}
          organizationId={ctx.organizationId}
        />
      </div>
    </div>
  );
}
