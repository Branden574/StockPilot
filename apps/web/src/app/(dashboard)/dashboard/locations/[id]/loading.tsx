import { LocationPageSkeleton } from '@/components/locations/location-page-skeleton';

/**
 * The location page's own skeleton (F1-3). Without this file the page would
 * inherit locations/loading.tsx, the Locations LIST's table skeleton, which is
 * the wrong shape for one location. Mapped to null in
 * lib/navigation/route-skeletons.ts (a route with its own loading.tsx gets no
 * late skeleton on top of it).
 */
export default function LocationLoading() {
  return <LocationPageSkeleton />;
}
