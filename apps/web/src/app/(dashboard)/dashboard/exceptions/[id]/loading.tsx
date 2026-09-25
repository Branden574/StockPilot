import { PageSkeleton } from '@/components/dashboard/skeletons';

/**
 * The occurrence page's own skeleton. The Exceptions list keeps relying on
 * the late skeleton (lib/navigation/route-skeletons.ts maps only the list
 * path to 'page'), so this boundary covers the detail alone.
 */
export default function ExceptionDetailLoading() {
  return <PageSkeleton />;
}
