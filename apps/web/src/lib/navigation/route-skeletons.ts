/**
 * Which skeleton a dashboard route shows while it loads, for the two places
 * that draw one outside a route's own loading.tsx:
 *   - the late skeleton (components/dashboard/pending-route-skeleton.tsx), for
 *     a soft navigation still waiting after SLOW_NAVIGATION_MS;
 *   - the (dashboard) group's loading.tsx, on a hard load or refresh.
 *
 * null means "this route has a loading.tsx of its own": it keeps it, and the
 * late skeleton stays off (a second skeleton would stack on the first one when
 * the route was not prefetched).
 *
 * Overview, Items, Books and Orders have no loading.tsx on purpose: React holds
 * a Suspense boundary's content until 300 ms after its fallback appeared
 * (react-dom FALLBACK_THROTTLE_MS), so their route skeleton, shown ~50 ms after
 * the click, kept pages whose data was ready at 140-190 ms off screen until
 * ~350 ms. Their sub-routes (the item page, the order page) inherited those
 * files, and each row below keeps the shape they had before.
 *
 * lib/navigation/late-skeleton-routes.guard.test.ts walks app/(dashboard) and
 * fails when a page relies on this map without an entry, or when an entry would
 * stack on a route's own loading.tsx.
 */
export type RouteSkeletonKind = 'overview' | 'table-10' | 'table-8' | 'table-6' | 'page';

function within(pathname: string, base: string): boolean {
  return pathname === base || pathname.startsWith(`${base}/`);
}

/**
 * Pages that never had a loading.tsx of their own (they inherited the Overview
 * one by accident), plus the two sections whose async layout sits ABOVE their
 * loading.tsx, so that loading.tsx cannot show until the layout has rendered.
 * `page` is their shape: the generic dashboard page for the first group, and
 * the same markup as admin/ and reports/ loading.tsx for the second.
 */
const PAGE_SECTIONS = [
  '/dashboard/audit',
  '/dashboard/customers',
  '/dashboard/exceptions',
  '/dashboard/help',
  '/dashboard/support',
  '/dashboard/admin',
  '/dashboard/reports',
];

export function routeSkeletonFor(pathname: string): RouteSkeletonKind | null {
  if (pathname === '/dashboard') return 'overview';
  // inventory/loading.tsx and books/loading.tsx were TablePageSkeleton rows=10.
  if (within(pathname, '/dashboard/inventory') || within(pathname, '/dashboard/books')) {
    return 'table-10';
  }
  // The storefront keeps its own loading.tsx.
  if (within(pathname, '/dashboard/orders/new')) return null;
  // orders/loading.tsx was TablePageSkeleton rows=8.
  if (within(pathname, '/dashboard/orders')) return 'table-8';
  // Async layout above purchase-orders/loading.tsx (TablePageSkeleton rows=6).
  if (within(pathname, '/dashboard/purchase-orders')) return 'table-6';
  if (PAGE_SECTIONS.some((base) => within(pathname, base))) return 'page';
  return null;
}
