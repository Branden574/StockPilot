import { LocationsPageSkeleton } from '@/components/locations/locations-page-skeleton';

/** The Locations list's own skeleton, in the list's shape (its header, the
 *  three group tabs and the table card). A location's own page has its own
 *  loading.tsx (locations/[id]/loading.tsx). */
export default function LocationsLoading() {
  return <LocationsPageSkeleton />;
}
