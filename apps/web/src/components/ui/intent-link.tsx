'use client';

import Link from 'next/link';
import * as React from 'react';

import { useWarmRoute } from '@/lib/hooks/use-warm-route';

/**
 * A <Link> for link GRIDS, LISTS and TABLE ROWS: no viewport prefetch, warmed
 * on intent instead.
 *
 * WHY. A default <Link> prefetches its route as soon as it scrolls into view,
 * and in Next 16.3.5 each prefetch of one of our (dynamic) routes is TWO
 * server requests: the route tree, then the segments down to the nearest
 * loading.tsx (measured before Overview, Items, Books and Orders dropped
 * theirs). A page of tiles or rows therefore fires two requests per
 * distinct link the moment it renders. Measured in production on 2026-09-22:
 * opening /dashboard/reports fired 26 page requests in about 1.4 s (13 tiles
 * x 2); a Dashboard hard load fired about 40; the Orders list fired 14
 * order-detail prefetches per view. Every Supabase call in that Reports load
 * took 13-40 ms, yet the page took about 5 s: it was the first visit after a
 * deploy (a cold instance), and with Fluid compute one warm instance serves
 * concurrent requests on one Node thread, so the page the person asked for
 * was rendered in turns with 26 renders of pages they had not asked for.
 *
 * WHAT INSTEAD. The same warm-up the sidebar has always used (useWarmRoute:
 * router.prefetch, which fetches exactly what the viewport prefetch fetched),
 * started by the person's own approach to ONE link:
 *   - pointer-down: immediately. It is a click in progress (mouse, pen and
 *     touch alike; pointer events cover touchstart);
 *   - hover and keyboard focus: after INTENT_DWELL_MS on the link. A pointer
 *     sliding down a table, or Tab held down through a list, crosses many
 *     links without meaning any of them; firing on every crossing would
 *     rebuild the storm this component exists to stop, one row at a time.
 *     Leaving the link (pointer-leave / blur) before the dwell cancels it.
 * A click then paints the destination's loading.tsx at once IF the warm-up
 * has finished. (Overview, Items, Books, Orders and their sub-pages have no
 * loading.tsx: the page being left stays up with the progress bar until the
 * new one is ready, and a navigation still waiting after 400 ms shows the
 * late skeleton, components/dashboard/pending-route-skeleton.tsx.) The
 * navigation reads the same prefetch cache (the Link's own
 * prefetch prop only feeds instrumentation hooks, read in
 * next/dist/client/components/app-router-instance.js), but it uses a route
 * entry only once it is fulfilled. A warm-up still in flight is not waited
 * for; the click sends its own request (segment-cache/navigation.js
 * navigateToUnknownRoute). So a warm-up must START at least a round trip
 * before the click to help, and `hoverDwellMs` lets a table row start it the
 * moment the pointer arrives.
 *
 * Use it for any link that is one of many on a page. A single primary next
 * step (a lone "New order" button, a "Back to list" link) can stay a plain
 * <Link>; the guard in lib/perf/link-prefetch.guard.test.ts enforces the rule
 * for links rendered inside .map() and for the files that opted in.
 */
export const INTENT_DWELL_MS = 65;

type NextLinkProps = React.ComponentProps<typeof Link>;

export type IntentLinkProps = Omit<NextLinkProps, 'href' | 'prefetch'> & {
  /** A string href, so the warm-up and the performance mark see the same URL the click does. */
  href: string;
  /**
   * How long the POINTER must rest on the link before the warm-up starts.
   * Default INTENT_DWELL_MS. 0 starts it on arrival: right for rows whose
   * warm-up is cheap (only the route tree is new per row; the loading
   * segments are shared) and whose click comes soon after the pointer lands.
   * Keyboard focus always waits INTENT_DWELL_MS (Tab held through a list).
   */
  hoverDwellMs?: number;
};

/** A plain primary press: not a right/middle click, not a modified click that opens elsewhere. */
function isPlainPrimaryPress(event: React.PointerEvent): boolean {
  return (
    event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey
  );
}

export function IntentLink({
  href,
  hoverDwellMs = INTENT_DWELL_MS,
  onPointerEnter,
  onPointerLeave,
  onPointerDown,
  onFocus,
  onBlur,
  ...rest
}: IntentLinkProps) {
  const warmRoute = useWarmRoute();
  const dwellTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelDwell = React.useCallback(() => {
    if (dwellTimer.current !== null) {
      clearTimeout(dwellTimer.current);
      dwellTimer.current = null;
    }
  }, []);

  // A row that unmounts mid-dwell (a filter changed, the list re-rendered)
  // must not warm a route after it is gone.
  React.useEffect(() => cancelDwell, [cancelDwell]);

  const warmAfterDwell = (dwellMs: number) => {
    cancelDwell();
    if (dwellMs <= 0) {
      warmRoute(href);
      return;
    }
    dwellTimer.current = setTimeout(() => {
      dwellTimer.current = null;
      warmRoute(href);
    }, dwellMs);
  };

  const warmNow = () => {
    cancelDwell();
    warmRoute(href);
  };

  return (
    <Link
      {...rest}
      href={href}
      prefetch={false}
      onPointerEnter={(event) => {
        onPointerEnter?.(event);
        warmAfterDwell(hoverDwellMs);
      }}
      onPointerLeave={(event) => {
        onPointerLeave?.(event);
        cancelDwell();
      }}
      onPointerDown={(event) => {
        onPointerDown?.(event);
        // A right or middle click, or a modified click that opens a new tab
        // or window, will not navigate THIS tab: nothing to warm here.
        if (isPlainPrimaryPress(event)) warmNow();
      }}
      onFocus={(event) => {
        onFocus?.(event);
        warmAfterDwell(INTENT_DWELL_MS);
      }}
      onBlur={(event) => {
        onBlur?.(event);
        cancelDwell();
      }}
    />
  );
}
