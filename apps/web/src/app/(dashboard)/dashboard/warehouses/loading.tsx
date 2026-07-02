import { PageSkeleton } from '@/components/dashboard/skeletons';

/**
 * Boundary for /dashboard/warehouses/* (the section has no index page —
 * only the [id] detail). Without this file the nearest boundary is the
 * Overview-shaped dashboard/loading.tsx, which is the wrong frame for a
 * warehouse detail navigation.
 */
export default function WarehousesLoading() {
  return <PageSkeleton />;
}
