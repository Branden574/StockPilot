'use client';

import { usePathname } from 'next/navigation';

import { RouteSkeleton } from '@/components/dashboard/route-skeleton';
import { routeSkeletonFor } from '@/lib/navigation/route-skeletons';

/**
 * The dashboard group's fallback: what a hard load or refresh shows inside the
 * shell until the page streams in. It takes the ROUTE's shape
 * (lib/navigation/route-skeletons.ts, the map the late skeleton uses too), so
 * Items, Books, Orders and Overview, which have no loading.tsx of their own,
 * get their table or Overview skeleton here instead of the generic page.
 *
 * Same boundary as before, only its content depends on the path: no new
 * Suspense boundary and no extra reveal hold. A soft navigation never shows it
 * (this boundary is already revealed), except a Back/Forward that suspends
 * while React renders it synchronously. Routes with a loading.tsx of their own
 * resolve that inner boundary in the same pass and never show this one.
 */
export default function DashboardLoading() {
  return <RouteSkeleton kind={routeSkeletonFor(usePathname()) ?? 'page'} />;
}
