'use client';

import { usePathname, useSearchParams } from 'next/navigation';
import * as React from 'react';

import {
  getRouterNavigation,
  getServerRouterNavigation,
  locationKey,
  pendingPathNavigationRemaining,
  subscribeRouterNavigation,
} from '@/lib/navigation/router-navigation';
import { markNavigationClick, markNavigationFeedback } from '@/lib/perf/marks';

/**
 * Global top progress bar that responds to every in-app navigation.
 * Covers links the sidebar's per-link NavLinkPending indicator can't
 * see — topbar, dashboard cards, table rows, breadcrumbs, action
 * buttons that call router.push.
 *
 * How it works:
 *   • Document-level capture-phase click listener on internal <a>
 *     links (same-origin, not modified-click). Fires the moment the
 *     user clicks, which is before Next.js's RSC fetch even starts.
 *   • Navigations started from CODE (router.push/replace from a form
 *     submit, a keyboard shortcut, the command palette) have no click to
 *     see. The router reports every start it makes (src/instrumentation-client.ts
 *     -> lib/navigation/router-navigation.ts), and a path change reported
 *     there starts the bar too, in the same task as the start. Back/Forward
 *     and query-only starts do not: React renders a popstate synchronously,
 *     so a Back to a page the tab still holds commits at once, and a query
 *     change started from code has its own in-page pending state.
 *   • Bar fills to ~80% on a fast ease curve, then pauses (mimics
 *     the classic NProgress feel — we don't actually know how long
 *     the RSC fetch will take, so the asymptotic crawl signals "still
 *     working" without lying about completion).
 *   • Completes when the location (path AND query) moves, or when the
 *     router starts a same-URL navigation (Next discarded the one the bar
 *     was following).
 *   • Failsafe: after 8 s it gives up quietly, UNLESS the late skeleton
 *     (pending-route-skeleton.tsx) is covering the page for a path navigation
 *     still in flight from it. Then it keeps climbing alongside the skeleton
 *     and both end together, at MAX_PENDING_NAVIGATION_MS (30 s) at the
 *     latest, so a covered page never waits with no sign of progress. With
 *     no skeleton up it still gives up at 8 s: a navigation can end without
 *     the location moving (the proxy sends /signin back to /dashboard), and
 *     nothing else would stop the bar.
 *
 * Query-only navigations (the item page's Movements/Activity tabs, ?page=,
 * filter chips) get the bar too. They used to be skipped as "in-page", but a
 * query change re-renders the page on the server like any other navigation:
 * the owner's tab clicks (2026-09-22) showed nothing for 3.6-6.6 s. Two
 * differences from a path change, both deliberate:
 *   • The bar starts one task after the click, and only if the URL has not
 *     already moved by then. The Inventory table's instant mode answers its
 *     ?page= and view-chip clicks IN PLACE, with a synchronous
 *     history.pushState inside the click handler; starting at once would
 *     flash a loading bar over a change that took no time at all.
 *   • No performance mark. The marks time click -> useful content, and
 *     "useful" fires when a page's content MOUNTS. A query change does not
 *     remount the page (Next keys a page's React tree without its query:
 *     layout-router.js `createRouterCacheKey(activeSegment, true)`), so the
 *     click would never be closed, and the next un-clicked arrival on the
 *     same route (Back, a router.push from search) would close it with a
 *     made-up duration.
 *
 * Safe by construction:
 *   • Only ever triggers a CSS animation on a 2px-tall div. No data
 *     fetching and no router patching: it reads the router's start events,
 *     it never changes them.
 *   • No effect on the actual navigation flow — pure visual feedback.
 *   • Failsafe timer makes it impossible for the bar to remain
 *     visible after a real navigation completes.
 */

/** The bar gives up after this long unless the router still has a path navigation in flight. */
const FAILSAFE_MS = 8000;

type Phase = 'idle' | 'climbing' | 'completing';

export function NavProgressBar() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const currentKey = locationKey(pathname, searchParams?.toString() ?? '');
  // useSyncExternalStore, never setState from a store listener: the start is
  // recorded inside Next's startTransition, and a setState there would join the
  // navigation's transition, so the bar would paint when the page does.
  const nav = React.useSyncExternalStore(
    subscribeRouterNavigation,
    getRouterNavigation,
    getServerRouterNavigation,
  );
  const [phase, setPhase] = React.useState<Phase>('idle');
  // The phase as of the last call to enter(), readable at once. A click and
  // the router start it causes arrive in the same task, before any re-render.
  const phaseRef = React.useRef<Phase>('idle');
  // Bumped by a measured click that lands on a bar ALREADY climbing for a
  // navigation no click was marked for (one started from code). The phase does
  // not change, so without this the feedback effect would not run for it and
  // marks.ts would report the click as never acknowledged; before the bar
  // followed code-started navigations it was idle there and the click started
  // it. A click on a bar climbing for an earlier CLICK does not bump it: that
  // click got no feedback from the bar before either, and the marks stay
  // comparable with the baseline.
  const [measuredClicks, setMeasuredClicks] = React.useState(0);
  const startKeyRef = React.useRef<string | null>(null);
  // True while the bar climbs for a click that markNavigationClick recorded.
  // Only such a click gets a feedback mark (see the frames effect below).
  const measuredRef = React.useRef(false);
  const failsafeRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const deferredStartRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  // The router start the bar has already answered.
  const handledNavIdRef = React.useRef<number | null>(null);

  const enter = React.useCallback((next: Phase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  const complete = React.useCallback(() => {
    measuredRef.current = false;
    if (failsafeRef.current) {
      clearTimeout(failsafeRef.current);
      failsafeRef.current = null;
    }
    enter('completing');
  }, [enter]);

  // One start for both sources (a click, a router start), so either can find
  // the bar already climbing and leave it alone.
  const start = React.useCallback(
    (fromKey: string) => {
      startKeyRef.current = fromKey;
      enter('climbing');
      if (failsafeRef.current) clearTimeout(failsafeRef.current);
      const giveUp = () => {
        // A path navigation whose late skeleton covers the page keeps the bar
        // up with it, to 30 s from its start (the skeleton uses the same clock).
        const remaining = pendingPathNavigationRemaining(
          getRouterNavigation(),
          startKeyRef.current,
          Date.now(),
        );
        if (remaining > 0) {
          failsafeRef.current = setTimeout(giveUp, remaining);
          return;
        }
        // No-completion guard: cancel quietly. A prevented Link, a plain <a>
        // to a download, a query change that never lands.
        failsafeRef.current = null;
        measuredRef.current = false;
        enter('idle');
      };
      failsafeRef.current = setTimeout(giveUp, FAILSAFE_MS);
    },
    [enter],
  );

  React.useEffect(() => {
    function isModifiedClick(e: MouseEvent): boolean {
      return e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0;
    }

    function onClick(e: MouseEvent) {
      if (isModifiedClick(e)) return;
      let el = e.target as HTMLElement | null;
      // Walk up to the nearest <a> (clicks often land on an icon or
      // span inside the link).
      while (el && el.tagName !== 'A') el = el.parentElement;
      if (!el) return;
      const a = el as HTMLAnchorElement;
      if (a.target && a.target !== '_self') return;
      if (a.hasAttribute('download')) return;
      const href = a.getAttribute('href');
      if (!href) return;
      // Only intercept same-origin app routes. Skip hash links + protocol links.
      if (href.startsWith('#') || /^[a-z]+:/i.test(href)) return;
      let next: URL;
      try {
        next = new URL(a.href, window.location.origin);
      } catch {
        return;
      }
      const fromKey = locationKey(window.location.pathname, window.location.search);
      // The page already on screen, path AND query: not a navigation.
      if (locationKey(next.pathname, next.search) === fromKey) return;
      if (deferredStartRef.current) {
        clearTimeout(deferredStartRef.current);
        deferredStartRef.current = null;
      }

      if (next.pathname === window.location.pathname) {
        // Query-only: see "Query-only navigations" above. By the time this
        // task runs every click handler has returned, so an in-place history
        // update has already moved the URL and there is nothing to wait for.
        deferredStartRef.current = setTimeout(() => {
          deferredStartRef.current = null;
          if (locationKey(window.location.pathname, window.location.search) !== fromKey) return;
          start(fromKey);
        }, 0);
        return;
      }

      // Performance mark only (lib/perf/marks.ts): this listener is the one
      // place that sees EVERY accepted in-app link click, at click time. The
      // event's own timeStamp is passed so a busy main thread's input delay
      // counts against the navigation instead of vanishing.
      markNavigationClick(next.pathname, e.timeStamp);
      if (phaseRef.current === 'climbing' && !measuredRef.current) {
        setMeasuredClicks((n) => n + 1);
      }
      measuredRef.current = true;
      start(fromKey);
    }

    document.addEventListener('click', onClick, { capture: true });
    return () => {
      document.removeEventListener('click', onClick, { capture: true });
      if (deferredStartRef.current) clearTimeout(deferredStartRef.current);
      if (failsafeRef.current) clearTimeout(failsafeRef.current);
    };
  }, [start]);

  // Router starts (see "How it works"). A Link click reaches here too, right
  // after the listener above started the bar for it: the bar is then already
  // climbing from the same page and this leaves it, and its marks, alone.
  React.useEffect(() => {
    if (nav === null) {
      // The navigation the bar followed is over: its page committed, or the
      // page came back from the back-forward cache with nothing in flight.
      if (handledNavIdRef.current !== null && phaseRef.current === 'climbing') complete();
      handledNavIdRef.current = null;
      return;
    }
    if (handledNavIdRef.current === nav.id) return;
    handledNavIdRef.current = nav.id;
    if (nav.kind === 'same') {
      // Next discarded whatever the bar was following for a same-URL start.
      if (phaseRef.current === 'climbing') complete();
      return;
    }
    if (nav.kind !== 'path' || nav.type === 'traverse' || nav.fromKey !== currentKey) return;
    if (phaseRef.current === 'climbing' && startKeyRef.current === nav.fromKey) return;
    // Not measured: no click was marked for it, so it marks no feedback.
    start(nav.fromKey);
  }, [nav, currentKey, start, complete]);

  // Performance mark only: "the click was acknowledged". The effect runs once
  // the bar is in the DOM, and then waits a DOUBLE requestAnimationFrame. The
  // first callback runs at the START of the frame that will paint the bar,
  // before anything is on screen; the second runs at the start of the frame
  // after it, by which time the bar has been painted. One frame late at worst,
  // never early: a budget check must err toward the slower number, and a
  // single rAF would stamp feedback the person had not seen yet. The external
  // harness (tests/perf/collector.ts, `nextFrame`) uses the same convention,
  // so the in-app number and the harness number mean the same thing.
  //
  // BOTH handles are cancelled on cleanup: the phase can leave 'climbing'
  // between the two frames (a cached route commits at once), and an inner
  // frame left armed would stamp feedback for a bar that is already gone.
  // First feedback wins, so when a sidebar link's spinner (NavLinkPending)
  // got there earlier this call is ignored.
  //
  // A bar started by a query-only click or by the router alone marked no
  // click, so it marks no feedback either: the navigation marks.ts has in
  // flight would be an older one, and this bar is not feedback for it. It
  // runs again when a measured click lands on such a bar (measuredClicks).
  React.useEffect(() => {
    if (phase !== 'climbing') return;
    if (!measuredRef.current) return;
    let inner: number | null = null;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => markNavigationFeedback());
    });
    return () => {
      cancelAnimationFrame(outer);
      if (inner !== null) cancelAnimationFrame(inner);
    };
  }, [phase, measuredClicks]);

  React.useEffect(() => {
    if (phase === 'climbing' && startKeyRef.current !== currentKey) {
      // Navigation completed — the path or the query changed.
      complete();
    }
  }, [currentKey, phase, complete]);

  // The fade-out gets an effect of its OWN, keyed on `phase` alone.
  //
  // It used to be a setTimeout inside the effect above, whose cleanup cleared
  // it. But that effect depends on `phase`, and it had just called
  // setPhase('completing'): the very next render ran its cleanup, cancelled the
  // timer it had set one line earlier, and found nothing to do on re-run. The
  // bar therefore NEVER returned to 'idle' after a navigation. For most people
  // that was invisible (the complete animation ends at opacity 0 and holds), but
  // under `prefers-reduced-motion: reduce` that animation is switched off, so
  // the bar sat at full width and full opacity across the top of the screen
  // from the first click until a reload: a loading bar that never stopped.
  React.useEffect(() => {
    if (phase !== 'completing') return;
    const t = setTimeout(() => enter('idle'), 250);
    return () => clearTimeout(t);
  }, [phase, enter]);

  if (phase === 'idle') return null;

  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-x-0 top-0 z-[60] h-[2px]">
      <div
        className={
          phase === 'climbing'
            ? 'h-full origin-left animate-[nav-progress-climb_2.8s_cubic-bezier(0.2,0.8,0.2,1)_forwards] bg-[hsl(var(--accent))] shadow-[0_0_8px_hsl(var(--accent))]'
            : 'h-full origin-left animate-[nav-progress-complete_240ms_ease-out_forwards] bg-[hsl(var(--accent))] shadow-[0_0_8px_hsl(var(--accent))]'
        }
      />
    </div>
  );
}
