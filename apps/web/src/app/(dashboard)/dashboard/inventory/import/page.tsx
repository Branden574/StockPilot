import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { CsvImport } from '@/components/inventory/csv-import';
import { PageHeader, PageHeaderBackLink } from '@/components/patterns/page-header';
import { requireOrgContext } from '@/lib/auth/session';
import { forcedWarehouseId } from '@/lib/auth/warehouse';
import { checkModuleAccess } from '@/lib/modules/module-gate';
import { createClient } from '@/lib/supabase/server';
import { WarehousesService } from '@/server/services/warehouses';

import { can, resolveTerminology } from '@stockpilot/core';

// A tab title of its own (CONFLICTS D16): the page used to inherit the
// dashboard's.
export const metadata: Metadata = { title: 'Import items' };

/** The page area (DESIGN-SPEC 4 and 5.3), the same box every redesigned page
 *  draws; the import steps keep to a reading width inside it. */
const PAGE = 'mx-auto flex w-full max-w-[1320px] flex-col gap-4 px-4 pb-16 pt-6 sm:px-8 sm:pt-7';
const STEPS_WIDTH = 'w-full max-w-[960px]';

export default async function ImportPage() {
  const ctx = await requireOrgContext();
  if (!can(ctx, 'items:import')) {
    redirect('/dashboard/inventory');
  }
  const supabase = await createClient();
  // The template's sports columns are gated like every other sports surface —
  // an org without the module never sees jerseys, colorways or size systems in
  // a CSV header it is told to fill in. Resolved AFTER the permission gate so a
  // redirect costs no extra read.
  //
  // The warehouse list is loaded alongside it because every created item needs
  // one: the screen offered no destination at all, so every row failed on
  // "A warehouse must be selected before creating an item." Same three inputs
  // the bulk-ISBN import already takes.
  const [{ enabled: sportsEnabled }, warehousesSvc, forced, orgRow] = await Promise.all([
    checkModuleAccess('sports'),
    WarehousesService.forCurrentUser(),
    forcedWarehouseId(),
    supabase
      .from('organizations')
      .select('terminology')
      .eq('id', ctx.organizationId)
      .maybeSingle(),
  ]);
  const warehouses = await warehousesSvc.listNames();
  const term = resolveTerminology(
    (orgRow.data?.terminology as Partial<{ warehouse_singular: string }> | null) ?? null,
  );
  return (
    <div className={PAGE}>
      <PageHeader
        className={STEPS_WIDTH}
        back={<PageHeaderBackLink href="/dashboard/inventory">← Back to inventory</PageHeaderBackLink>}
        title="Import items"
        subline="Upload a CSV. We'll validate every row and show errors before anything goes into your inventory."
      />
      <div className={STEPS_WIDTH}>
        <CsvImport
          sportsEnabled={sportsEnabled}
          warehouses={warehouses.map((w) => ({ id: w.id, name: w.name }))}
          forcedWarehouseId={forced}
          warehouseLabel={term.warehouse_singular}
        />
      </div>
    </div>
  );
}
