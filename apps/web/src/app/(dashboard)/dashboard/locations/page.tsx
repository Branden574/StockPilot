import type { Metadata } from 'next';

import { LocationsManager } from '@/components/locations/locations-manager';
import { requireOrgContext } from '@/lib/auth/session';
import { getWarehousesForRequest } from '@/lib/dashboard/request-cache';
import { scopeLocationsToWarehouse } from '@/lib/locations/scope';
import { getActiveWarehouseFilter } from '@/lib/warehouse-filter';
import { LocationsService } from '@/server/services/locations';

import { can } from '@stockpilot/core';

// The tab names the page ("Locations · StockPilot"); before, it read the
// group's "Dashboard" (CONFLICTS D16).
export const metadata: Metadata = { title: 'Locations' };

/** The page area (DESIGN-SPEC 4 and 5.3), the same box the other pages use. */
const PAGE = 'mx-auto flex w-full max-w-[1320px] flex-col gap-4 px-4 pb-16 pt-6 sm:px-8 sm:pt-7';

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
    // The header (h1, subline, Active / Archived, New location) is drawn by
    // LocationsManager, which holds the dialog New location opens.
    <div className={PAGE}>
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
