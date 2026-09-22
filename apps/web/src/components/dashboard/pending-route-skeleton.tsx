'use client';

import { usePathname } from 'next/navigation';
import * as React from 'react';

import { type SlowNavigation } from '@/components/dashboard/nav-progress-bar';
import { OverviewSkeleton } from '@/components/dashboard/overview-skeleton';
import { PageSkeleton, TablePageSkeleton } from '@/components/dashboard/skeletons';

/** List routes whose page is a table: their skeleton is the table page's. */
const TABLE_ROUTES = new Set(['/dashboard/inventory', '/dashboard/books', '/dashboard/orders']);

/**
 * The placeholder for a navigation that is STILL waiting after
 * SLOW_NAVIGATION_MS, drawn by DashboardShell in place of the page being left.
 *
 * Why this is not a loading.tsx: a loading.tsx is a Suspense fallback, and
 * React holds a Suspense boundary's content until 300 ms after its fallback
 * appeared (react-dom FALLBACK_THROTTLE_MS). The Overview, Items, Books and
 * Orders skeletons appeared ~50 ms after the click, so their content could not
 * show before ~350 ms however early the page data arrived: in the lab (2026-09-22,
 * production-median Supabase calls, 130 ms round trip) the data was complete at
 * 141-186 ms and then waited 160-210 ms. Without a fallback between the layout
 * that stays and the page that is loading, a navigation keeps the page being
 * left (with the top progress bar climbing) and swaps in the new page the
 * moment it is ready; this skeleton covers only the slow ones.
 */
export function PendingRouteSkeleton({ target }: { target: string }) {
  return (
    <div aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading</span>
      {target === '/dashboard' ? (
        <OverviewSkeleton />
      ) : TABLE_ROUTES.has(target) ? (
        <TablePageSkeleton rows={10} />
      ) : (
        <PageSkeleton />
      )}
    </div>
  );
}

/**
 * The dashboard's page area. While a navigation has been waiting longer than
 * SLOW_NAVIGATION_MS, the page being left is hidden (kept mounted, so nothing
 * is lost if the navigation is abandoned) and the destination's skeleton is
 * drawn instead. Only while the URL is still the one the navigation left: the
 * moment the new page commits, the URL moves and the frame shows it, so a
 * page that has arrived is never behind a skeleton, not even for one frame
 * before the progress bar reports the end. Its own component so that only it,
 * not the whole shell, re-renders when the path changes.
 */
export function PendingRouteFrame({
  slowNavigation,
  children,
}: {
  slowNavigation: SlowNavigation | null;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const pending = slowNavigation !== null && slowNavigation.from === pathname;
  return (
    <>
      {pending && <PendingRouteSkeleton target={slowNavigation.target} />}
      <div className={pending ? 'hidden' : 'contents'}>{children}</div>
    </>
  );
}
