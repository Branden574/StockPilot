import Link from 'next/link';
import { redirect } from 'next/navigation';

import { CsvImport } from '@/components/inventory/csv-import';
import { requireOrgContext } from '@/lib/auth/session';
import { forcedWarehouseId } from '@/lib/auth/warehouse';
import { checkModuleAccess } from '@/lib/modules/module-gate';
import { createClient } from '@/lib/supabase/server';
import { WarehousesService } from '@/server/services/warehouses';

import { can, resolveTerminology } from '@stockpilot/core';

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
    <div className="container mx-auto max-w-4xl px-4 py-8 sm:px-6">
      <div className="mb-6">
        <Link href="/dashboard/inventory" className="text-sm text-muted-foreground hover:text-foreground">
          ← Back to inventory
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Import items</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Upload a CSV. We'll validate every row and show errors before anything goes into your inventory.
        </p>
      </div>
      <CsvImport
        sportsEnabled={sportsEnabled}
        warehouses={warehouses.map((w) => ({ id: w.id, name: w.name }))}
        forcedWarehouseId={forced}
        warehouseLabel={term.warehouse_singular}
      />
    </div>
  );
}
