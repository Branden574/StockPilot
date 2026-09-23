import { OverviewSkeleton } from '@/components/dashboard/overview-skeleton';
import { PageSkeleton, TablePageSkeleton } from '@/components/dashboard/skeletons';
import type { RouteSkeletonKind } from '@/lib/navigation/route-skeletons';

/** Draws a route's skeleton by kind (lib/navigation/route-skeletons.ts picks the kind). */
export function RouteSkeleton({ kind }: { kind: RouteSkeletonKind }) {
  switch (kind) {
    case 'overview':
      return <OverviewSkeleton />;
    case 'table-10':
      return <TablePageSkeleton rows={10} />;
    case 'table-8':
      return <TablePageSkeleton rows={8} />;
    case 'table-6':
      return <TablePageSkeleton rows={6} />;
    case 'page':
      return <PageSkeleton />;
  }
}
