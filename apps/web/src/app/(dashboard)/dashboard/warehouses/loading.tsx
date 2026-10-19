import { WarehousePageSkeleton } from '@/components/locations/warehouse-page-skeleton';

/**
 * Boundary for /dashboard/warehouses/* (the section has no index page —
 * only the [id] detail). Without this file the nearest boundary is the
 * Overview-shaped dashboard/loading.tsx, which is the wrong frame for a
 * warehouse detail navigation. It draws the warehouse page's own shape.
 */
export default function WarehousesLoading() {
  return <WarehousePageSkeleton />;
}
