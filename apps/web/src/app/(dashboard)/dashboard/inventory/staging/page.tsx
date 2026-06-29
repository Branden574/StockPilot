import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Suspense } from 'react';

import { StagingTable } from '@/components/inventory/staging-table';
import { TableBodySkeleton } from '@/components/dashboard/skeletons';
import { can } from '@stockpilot/core';
import { InventoryService } from '@/server/services/inventory';
import { LocationsService } from '@/server/services/locations';
import { WarehousesService } from '@/server/services/warehouses';
import { requireOrgContext } from '@/lib/auth/session';
import { getActiveWarehouseFilter } from '@/lib/warehouse-filter';

export const metadata: Metadata = { title: 'Staging' };

type StagingSearchParams = {
  type?: string;
};

export default async function StagingPage({
  searchParams,
}: {
  searchParams: Promise<StagingSearchParams>;
}) {
  const params = await searchParams;

  // Resolve the page shell synchronously (React-cached — same cost as the
  // dashboard layout's requireOrgContext call). Gates the Place button.
  const sessionCtx = await requireOrgContext();

  // Explicit route-level gate. The registry placement carries
  // `requires: 'items:read'` so the nav link is hidden from roles without
  // it, but the URL is still directly reachable — RLS alone would 200 an
  // empty page rather than refuse. notFound() matches the placement gate
  // and hides the route's existence from unauthorized roles.
  if (!can(sessionCtx, 'items:read')) notFound();

  const canPlace = can(sessionCtx, 'items:create');

  return (
    <div className="container mx-auto max-w-7xl px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-3 sm:gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Staging</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Stock waiting to be placed into a rack or crate — received from POs
            (staged) or on hand but never placed (unplaced).
          </p>
        </div>
      </div>

      <div className="mt-8">
        <Suspense fallback={<TableBodySkeleton rows={8} />}>
          <StagingTableSection params={params} canPlace={canPlace} />
        </Suspense>
      </div>
    </div>
  );
}

/**
 * Inner async Server Component — streams behind <Suspense>. Fetches the
 * staged worklist and the rack/crate locations (grouped by warehouse_id),
 * then passes serializable props to the 'use client' <StagingTable>.
 */
async function StagingTableSection({
  params,
  canPlace,
}: {
  params: StagingSearchParams;
  canPlace: boolean;
}) {
  const itemTypeParam =
    params.type === 'book' ? 'book' : params.type === 'non-book' ? 'non-book' : undefined;

  const [inventorySvc, locationsSvc, warehousesSvc, warehouseFilter] = await Promise.all([
    InventoryService.forCurrentUser(),
    LocationsService.forCurrentUser(),
    WarehousesService.forCurrentUser(),
    getActiveWarehouseFilter(),
  ]);

  const [rows, allLocations, warehouses] = await Promise.all([
    inventorySvc.stagedWorklist({
      itemType: itemTypeParam,
      warehouseId: warehouseFilter,
    }),
    locationsSvc.list(),
    warehousesSvc.list(),
  ]);

  // warehouse id → display name for the Warehouse column. list() returns only
  // active warehouses; any staged row pointing at an archived/inactive
  // warehouse simply falls back to the truncated UUID in the table.
  const warehouseNames: Record<string, string> = {};
  for (const w of warehouses) {
    warehouseNames[w.id] = w.name;
  }

  // Build a map of warehouseId → rack/crate destinations for that warehouse.
  // The PlaceFromStagingDialog only needs rack and crate kinds.
  const destinationsByWarehouse = new Map<string, Array<{ id: string; name: string; kind: string }>>();
  for (const loc of allLocations) {
    if (loc.kind !== 'rack' && loc.kind !== 'crate') continue;
    const wid = (loc.warehouse_id as string | null) ?? '__none__';
    if (!destinationsByWarehouse.has(wid)) {
      destinationsByWarehouse.set(wid, []);
    }
    destinationsByWarehouse.get(wid)!.push({
      id: loc.id as string,
      name: loc.name as string,
      kind: loc.kind as string,
    });
  }

  // Flatten the Map to a plain object so it crosses the RSC → client boundary
  // as serializable JSON. Keys are warehouse IDs (or '__none__').
  const destinationsMap: Record<string, Array<{ id: string; name: string; kind: string }>> = {};
  for (const [wid, dests] of destinationsByWarehouse) {
    destinationsMap[wid] = dests;
  }

  return (
    <StagingTable
      rows={rows}
      destinationsMap={destinationsMap}
      warehouseNames={warehouseNames}
      canPlace={canPlace}
      activeItemType={itemTypeParam ?? 'all'}
    />
  );
}
