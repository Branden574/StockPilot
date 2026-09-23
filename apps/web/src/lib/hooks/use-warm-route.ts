'use client';

import { usePathname, useRouter } from 'next/navigation';
import * as React from 'react';

import { markNavigationIntent } from '@/lib/perf/marks';

/**
 * The app's ONE way to warm a route before a click: `router.prefetch(href)`,
 * plus the navigation-intent performance mark (lib/perf/marks.ts).
 *
 * Two callers, one policy:
 *   - the sidebar (components/dashboard/sidebar.tsx), which warms on hover /
 *     focus / pointer-down and runs its staggered top-5 warm-up through it;
 *   - IntentLink (components/ui/intent-link.tsx), which every link grid, list
 *     and table row in the app uses instead of a viewport-prefetching <Link>.
 *
 * What router.prefetch fetches in Next 16.3.5 (read from
 * next/dist/client/components/app-router-instance.js and segment-cache/): the
 * default kind is AUTO, the same strategy a default <Link> uses when it enters
 * the viewport. For our routes (dynamic, no PPR) that is the route tree plus
 * the segments down to the nearest loading.tsx: two requests per route, and a
 * click afterwards paints the route's skeleton at once. So warming on intent
 * gives a click the same head start the viewport prefetch gave, for the one
 * link the person is about to use instead of every link on the screen.
 *
 * `intent` is for the performance mark only: hover, focus and pointer-down are
 * a PERSON signalling where they are about to go. A timer (the sidebar's
 * warm-up) is not intent and passes false, so an early click on those routes
 * is not credited with a head start nobody's pointer gave it.
 *
 * The page already on screen is never warmed: there is nothing to fetch.
 */
export function useWarmRoute(): (href: string, intent?: boolean) => void {
  const pathname = usePathname();
  const router = useRouter();
  return React.useCallback(
    (href: string, intent = true) => {
      if (href === pathname) return;
      if (intent) markNavigationIntent(href);
      router.prefetch(href);
    },
    [pathname, router],
  );
}
