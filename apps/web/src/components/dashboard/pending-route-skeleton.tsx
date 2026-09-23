'use client';

import { usePathname, useSearchParams } from 'next/navigation';
import * as React from 'react';

import { RouteSkeleton } from '@/components/dashboard/route-skeleton';
import {
  getRouterNavigation,
  getServerRouterNavigation,
  locationKey,
  MAX_PENDING_NAVIGATION_MS,
  noteCommittedLocation,
  noteLateSkeleton,
  SLOW_NAVIGATION_MS,
  subscribeRouterNavigation,
} from '@/lib/navigation/router-navigation';
import { routeSkeletonFor } from '@/lib/navigation/route-skeletons';

/**
 * The dashboard's page area, with the LATE skeleton: a path navigation still
 * waiting after SLOW_NAVIGATION_MS hides the page being left (kept mounted, so
 * nothing is lost if the navigation is abandoned) and draws the destination's
 * skeleton in its place.
 *
 * Why this is not a loading.tsx: a loading.tsx is a Suspense fallback, and
 * React holds a Suspense boundary's content until 300 ms after its fallback
 * appeared (react-dom FALLBACK_THROTTLE_MS). The Overview, Items, Books and
 * Orders skeletons appeared ~50 ms after the click, so their content could not
 * show before ~350 ms however early the page data arrived: in the lab
 * (2026-09-22, production-median Supabase calls, 130 ms round trip) the data
 * was complete at 141-186 ms and then waited 160-210 ms. Without a fallback
 * between the layout that stays and the page that is loading, a navigation
 * keeps the page being left (with the top progress bar climbing) and swaps in
 * the new page the moment it is ready. This skeleton is ordinary state, not a
 * fallback, so React holds nothing back for it; it covers only the slow ones.
 *
 * What starts it: the router's own start event (lib/navigation/router-navigation.ts),
 * so Link clicks, router.push/replace and Back/Forward alike. Only routes
 * without a loading.tsx of their own get it (lib/navigation/route-skeletons.ts);
 * the others show their own fallback, and a second skeleton would stack on it.
 * A redirect (a replace from the page that just committed) does not wait.
 *
 * What ends it, all at render time so a page that has arrived is never hidden,
 * not even for one frame:
 *   - the router commits anything (the new page, a redirect, error.tsx,
 *     not-found, or a shallow history.replaceState from the hidden page): the
 *     committed location is no longer the one the navigation left;
 *   - a newer navigation replaces it (Next discarded ours). A newer PATH
 *     navigation from the same page while the skeleton is up keeps a skeleton
 *     up, with no flash of the page the person already chose to leave;
 *   - a failed request: Next falls back to a full page load;
 *   - MAX_PENDING_NAVIGATION_MS (30 s), for a navigation Next abandoned without
 *     a word. The page comes back with its scroll position, and the progress
 *     bar, which climbs past its own 8 s failsafe only while this skeleton is
 *     up, goes idle at the same moment.
 *
 * Its own component, holding its own state, so that only it (not the shell,
 * the sidebar or the topbar) re-renders while a navigation is pending.
 */
export function PendingRouteFrame({ children }: { children: React.ReactNode }) {
  // useSyncExternalStore, never setState from a store listener: the start is
  // recorded inside Next's startTransition, and a setState there would join the
  // navigation's transition and paint only when it commits.
  const nav = React.useSyncExternalStore(
    subscribeRouterNavigation,
    getRouterNavigation,
    getServerRouterNavigation,
  );
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const currentKey = locationKey(pathname, searchParams?.toString() ?? '');

  // The store places every navigation against the location the ROUTER has
  // committed (the address bar moves early for Back/Forward and shallow
  // pushState). A layout effect, so it is written before any passive effect of
  // the same commit can start a navigation (RedirectBoundary's router.replace).
  React.useLayoutEffect(() => {
    noteCommittedLocation(currentKey);
    return () => noteCommittedLocation(null);
  }, [currentKey]);

  // The key of the page the skeleton is covering, set once SLOW_NAVIGATION_MS
  // has passed. Compared with the current key at render time, so it can never
  // outlive the page it covered.
  const [slowFromKey, setSlowFromKey] = React.useState<string | null>(null);
  // A navigation that reached MAX_PENDING_NAVIGATION_MS.
  const [expiredId, setExpiredId] = React.useState<number | null>(null);

  const tracked =
    nav !== null && nav.kind === 'path' && nav.fromKey === currentKey && nav.id !== expiredId
      ? nav
      : null;
  const mapped = tracked ? routeSkeletonFor(tracked.targetPath) : null;
  // A skeleton is already up over this page: a newer path navigation from it
  // keeps one up (its target's, or the generic page shape when the target has
  // a loading.tsx of its own), instead of flashing the page for 400 ms.
  const continuing = slowFromKey !== null && slowFromKey === currentKey;
  const eligible = tracked !== null && (mapped !== null || continuing);
  // A redirect into a mapped route (RouterNavigation.redirect): the page it
  // leaves is the redirecting one, which rendered nothing, so waiting 400 ms
  // would leave the page area blank. Its skeleton shows at once instead, as
  // the route's loading.tsx used to as soon as the replace committed.
  const atOnce = tracked !== null && tracked.redirect && mapped !== null;
  const show = eligible && (continuing || atOnce);

  // Nothing left to cover: forget the page it covered, so a later navigation
  // from the same URL waits its own 400 ms. Adjusted during render (React's
  // pattern for state derived from a change) rather than in an effect, so the
  // stale key is gone before the next navigation can be compared with it.
  if (!eligible && slowFromKey !== null) setSlowFromKey(null);

  // The progress bar climbs past its 8 s failsafe only while this covers the
  // page (router-navigation.ts pendingPathNavigationRemaining).
  const coveredId = show && tracked !== null ? tracked.id : null;
  React.useLayoutEffect(() => {
    noteLateSkeleton(coveredId);
    return () => noteLateSkeleton(null);
  }, [coveredId]);

  const pageRef = React.useRef<HTMLDivElement>(null);
  const savedScrollRef = React.useRef<{ key: string; top: number } | null>(null);

  React.useEffect(() => {
    if (!eligible || tracked === null) return;
    // The start may predate this effect (it was recorded in the same click
    // that rendered it, or before a remount): wait only what is left.
    const age = Date.now() - tracked.startedAt;
    const slow = setTimeout(
      () => {
        // Before the page is hidden: a focused control inside it would drop
        // focus to <body>, and its scroll position would read as clamped.
        const page = pageRef.current;
        const main = page?.closest('main');
        if (page && main) {
          if (page.contains(document.activeElement)) main.focus({ preventScroll: true });
          const saved = savedScrollRef.current;
          if (saved === null || saved.key !== tracked.fromKey) {
            savedScrollRef.current = { key: tracked.fromKey, top: main.scrollTop };
          }
        }
        setSlowFromKey(tracked.fromKey);
      },
      Math.max(0, SLOW_NAVIGATION_MS - age),
    );
    const expire = setTimeout(
      () => setExpiredId(tracked.id),
      Math.max(0, MAX_PENDING_NAVIGATION_MS - age),
    );
    return () => {
      clearTimeout(slow);
      clearTimeout(expire);
    };
  }, [eligible, tracked]);

  // The page is back. When it is the same page (the navigation was abandoned or
  // expired), put it back where the person left it; a new page gets Next's own
  // scroll handling. Before paint, so the jump is never seen.
  React.useLayoutEffect(() => {
    if (show) return;
    const saved = savedScrollRef.current;
    savedScrollRef.current = null;
    const main = pageRef.current?.closest('main');
    if (saved && main && saved.key === currentKey) main.scrollTop = saved.top;
  }, [show, currentKey]);

  return (
    <>
      {/* Always mounted, so assistive tech announces the text change. */}
      <p role="status" className="sr-only">
        {show ? 'Loading page' : ''}
      </p>
      {show && (
        <div aria-hidden="true" data-pending-route-skeleton="">
          <RouteSkeleton kind={mapped ?? 'page'} />
        </div>
      )}
      <div ref={pageRef} className={show ? 'hidden' : 'contents'}>
        {children}
      </div>
    </>
  );
}
