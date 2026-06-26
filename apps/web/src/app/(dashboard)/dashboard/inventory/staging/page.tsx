import type { Metadata } from 'next';
import { Suspense } from 'react';

import { StagingTable } from '@/components/inventory/staging-table';
import { TableBodySkeleton } from '@/components/dashboard/skeletons';
import { hasPermission } from '@stockpilot/core';
import { InventoryService } from '@/server/services/inventory';
import { LocationsService } from '@/server/services/locations';
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
  const canPlace = hasPermission(sessionCtx.role, 'items:create');

  return (
    <div className="container mx-auto max-w-7xl px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-3 sm:gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Staging</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Stock received from POs and waiting to be placed into a rack or crate.
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

  const [inventorySvc, locationsSvc, warehouseFilter] = await Promise.all([
    InventoryService.forCurrentUser(),
    LocationsService.forCurrentUser(),
    getActiveWarehouseFilter(),
  ]);

  const [rows, allLocations] = await Promise.all([
    inventorySvc.stagedWorklist({
      itemType: itemTypeParam,
      warehouseId: warehouseFilter,
    }),
    locationsSvc.list(),
  ]);

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
      canPlace={canPlace}
      activeItemType={itemTypeParam ?? 'all'}
    />
  );
}
