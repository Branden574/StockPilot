import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { Button } from '@/components/ui/button';
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
    <div className="container mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <div className="mb-6">
        <Button asChild variant="ghost" size="sm">
          <Link href="/dashboard/procedures">
            <ArrowLeft className="mr-1 h-3.5 w-3.5" /> Back to procedures
          </Link>
        </Button>
      </div>
      <h1 className="text-2xl font-semibold tracking-tight">New procedure</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Capture the steps. Drop videos in below — they&apos;ll upload after you
        save.
      </p>
      <div className="mt-6">
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
