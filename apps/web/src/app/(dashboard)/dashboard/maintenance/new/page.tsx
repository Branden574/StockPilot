import Link from 'next/link';
import { redirect } from 'next/navigation';

import { ModuleNotEnabled } from '@/components/dashboard/module-not-enabled';
import { checkModuleAccess } from '@/lib/modules/module-gate';
import { withContext } from '@/server/services/context';
import { ChartersService } from '@/server/services/charters';

import { can, MAINTENANCE_CATEGORIES, uuidSchema, type MaintenanceRequestFormValues } from '@stockpilot/core';

import { NewMaintenanceRequestClient } from './new-request-client';

export const dynamic = 'force-dynamic';

function readUuidParam(value: string | undefined): string | undefined {
  return value && uuidSchema.safeParse(value).success ? value : undefined;
}

export default async function NewMaintenanceRequestPage({
  searchParams,
}: {
  searchParams: Promise<{
    itemId?: string;
    orderRequestId?: string;
    rentalId?: string;
    charterId?: string;
    subject?: string;
  }>;
}) {
  const access = await checkModuleAccess('maintenance_requests');
  if (!access.enabled) return <ModuleNotEnabled moduleId="maintenance_requests" canManage={access.canManage} />;

  const ctx = await withContext();
  if (!can(ctx, 'maintenance_requests:submit')) {
    redirect('/dashboard/maintenance');
  }

  const sp = await searchParams;

  const [charters, settingsRow, assignmentRow] = await Promise.all([
    new ChartersService(ctx).list(),
    // Org-configured categories live in organization_modules.settings, the
    // same unconstrained-jsonb reader convention as the mint route's
    // shareLinksEnabled() (api/v1/maintenance-requests/[id]/route.ts) — an
    // absent row/key both mean "never configured", falling back to the
    // brief section 7 default twelve. The settings WRITER ships in Task 16;
    // this reader is forward-compatible with it.
    ctx.supabase
      .from('organization_modules')
      .select('settings')
      .eq('organization_id', ctx.organizationId)
      .eq('module_id', 'maintenance_requests')
      .maybeSingle(),
    // The employee's own site (brief section 7 — "site defaults from the
    // employee's own profile/site when known"). uwa_select_own RLS (0140)
    // lets any member read their OWN assignment rows; is_primary desc picks
    // the flagged row, or the first assignment if none is flagged.
    ctx.supabase
      .from('user_warehouse_assignments')
      .select('charter_id, warehouse_id, is_primary')
      .eq('organization_id', ctx.organizationId)
      .eq('user_id', ctx.userId)
      .order('is_primary', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  const sites = charters.map((c) => ({ id: c.id, name: c.name }));

  const configuredCategories = (
    settingsRow.data as { settings?: { categories?: unknown } } | null
  )?.settings?.categories;
  const categories =
    Array.isArray(configuredCategories) &&
    configuredCategories.length > 0 &&
    configuredCategories.every((c) => typeof c === 'string')
      ? (configuredCategories as string[])
      : [...MAINTENANCE_CATEGORIES];

  const assignment = assignmentRow.data as { charter_id: string | null; warehouse_id: string | null } | null;
  const launchCharterId = readUuidParam(sp.charterId);
  const defaults: Partial<MaintenanceRequestFormValues> = {
    subject: sp.subject?.trim().slice(0, 120) || undefined,
    charterId: launchCharterId ?? assignment?.charter_id ?? undefined,
    warehouseId: assignment?.warehouse_id ?? undefined,
    relatedItemId: readUuidParam(sp.itemId),
    relatedOrderRequestId: readUuidParam(sp.orderRequestId),
    relatedRentalId: readUuidParam(sp.rentalId),
  };

  return (
    <div className="container mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <div className="mb-6">
        <Link href="/dashboard/maintenance" className="text-sm text-muted-foreground hover:text-foreground">
          ← Back to maintenance requests
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">New maintenance request</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Describe the issue and StockPilot will prepare an email to the maintenance team on the next screen.
        </p>
      </div>

      <NewMaintenanceRequestClient defaults={defaults} sites={sites} categories={categories} />
    </div>
  );
}
