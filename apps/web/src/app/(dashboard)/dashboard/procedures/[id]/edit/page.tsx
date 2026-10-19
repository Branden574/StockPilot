import { ArrowLeft } from 'lucide-react';
import { notFound } from 'next/navigation';

import { PageHeader, PageHeaderBackLink } from '@/components/patterns/page-header';
import { ProcedureForm } from '@/components/procedures/procedure-form';
import { UploadRecoveryToast } from '@/components/procedures/upload-recovery-toast';
import { requireOrgContext } from '@/lib/auth/session';
import { can } from '@stockpilot/core';
import { ProcedureCategoriesService } from '@/server/services/procedure-categories';
import { ProceduresService } from '@/server/services/procedures';
import { WarehousesService } from '@/server/services/warehouses';
import { ServiceError } from '@/server/services/context';

export const dynamic = 'force-dynamic';

export default async function EditProcedurePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireOrgContext();
  if (!can(ctx, 'categories:manage')) {
    notFound();
  }

  const [procService, catService, whService] = await Promise.all([
    ProceduresService.forCurrentUser(),
    ProcedureCategoriesService.forCurrentUser(),
    WarehousesService.forCurrentUser(),
  ]);

  let procedure;
  try {
    procedure = await procService.get(id);
  } catch (e) {
    if (e instanceof ServiceError && e.code === 'not_found') notFound();
    throw e;
  }

  const [categories, warehouses] = await Promise.all([catService.list(), whService.listNames()]);

  const videos = procedure.videos.map((v) => ({
    id: v.id,
    title: v.title,
    storage_path: v.storage_path,
    signed_url: v.signed_url,
    duration_seconds: v.duration_seconds,
    size_bytes: v.size_bytes,
    mime_type: v.mime_type,
    order_idx: v.order_idx,
  }));

  return (
    <div className="mx-auto flex w-full max-w-[760px] flex-col gap-6 px-4 pb-16 pt-6 sm:px-8 sm:pt-7">
      <UploadRecoveryToast />
      <PageHeader
        back={
          <PageHeaderBackLink href={`/dashboard/procedures/${id}`}>
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Back to procedure
          </PageHeaderBackLink>
        }
        title="Edit procedure"
        subline="Update the body or attach more videos. Changes save when you click Save."
      />
      <div>
        <ProcedureForm
          mode="edit"
          categories={categories.map((c) => ({ id: c.id, name: c.name, color: c.color }))}
          warehouses={warehouses.map((w) => ({ id: w.id, name: w.name }))}
          organizationId={ctx.organizationId}
          defaults={{
            id: procedure.id,
            title: procedure.title,
            description: procedure.description,
            body: procedure.body,
            categoryId: procedure.category_id,
            authoringWarehouseId: procedure.authoring_warehouse_id,
            updatedAt: procedure.updated_at,
          }}
          videos={videos}
        />
      </div>
    </div>
  );
}
