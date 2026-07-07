import { LocationsManager } from '@/components/locations/locations-manager';
import { requireOrgContext } from '@/lib/auth/session';
import { getWarehousesForRequest } from '@/lib/dashboard/request-cache';
import { scopeLocationsToWarehouse } from '@/lib/locations/scope';
import { getActiveWarehouseFilter } from '@/lib/warehouse-filter';
import { LocationsService } from '@/server/services/locations';

import { can } from '@stockpilot/core';

interface LocationsPageProps {
  searchParams: Promise<{ view?: string }>;
}

export default async function LocationsPage({ searchParams }: LocationsPageProps) {
  const params = await searchParams;
  const isArchivedView = params.view === 'archived';
  const [ctx, svc, warehouseFilter] = await Promise.all([
    requireOrgContext(),
    LocationsService.forCurrentUser(),
    getActiveWarehouseFilter(),
  ]);
  const canManage = can(ctx, 'locations:manage');
  const [rows, warehouses] = await Promise.all([
    svc.list({ includeArchived: isArchivedView }),
    getWarehousesForRequest(ctx.organizationId),
  ]);
  const warehouseNames = new Map(warehouses.map((w) => [w.id, w.name]));
  // Honor the global warehouse selector: rows tied to another warehouse are
  // hidden; rows tied to the selected one (or to none) stay.
  const scoped = scopeLocationsToWarehouse(
    rows as Array<(typeof rows)[number] & { warehouse_id: string | null }>,
    warehouseFilter,
  );

  return (
    <div className="container mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Locations</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {isArchivedView
            ? 'Locations you archived. Restore one to bring it back into pick lists.'
            : 'Warehouses, rooms, shelves, vehicles, job sites — wherever stock lives.'}
        </p>
      </div>
      <LocationsManager
        view={isArchivedView ? 'archived' : 'active'}
        canManage={canManage}
        initial={scoped.map((r) => ({
          id: r.id as string,
          name: r.name as string,
          type: (r.type as string | null) ?? null,
          kind: (r.kind as string | null) ?? null,
          notes: (r.notes as string | null) ?? null,
          warehouseName: r.warehouse_id ? (warehouseNames.get(r.warehouse_id) ?? null) : null,
        }))}
      />
    </div>
  );
}
