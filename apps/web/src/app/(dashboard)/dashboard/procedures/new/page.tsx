import { ArrowLeft } from 'lucide-react';
import { notFound, redirect } from 'next/navigation';

import { PageHeader, PageHeaderBackLink } from '@/components/patterns/page-header';
import { ProcedureForm } from '@/components/procedures/procedure-form';
import { requireOrgContext } from '@/lib/auth/session';
import { can } from '@stockpilot/core';
import { ProcedureCategoriesService } from '@/server/services/procedure-categories';
import { WarehousesService } from '@/server/services/warehouses';

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
    <div className="mx-auto flex w-full max-w-[760px] flex-col gap-6 px-4 pb-16 pt-6 sm:px-8 sm:pt-7">
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
          organizationId={ctx.organizationId}
        />
      </div>
    </div>
  );
}
