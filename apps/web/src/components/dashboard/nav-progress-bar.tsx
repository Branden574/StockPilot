'use client';

import { usePathname, useSearchParams } from 'next/navigation';
import * as React from 'react';

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
 *   • Bar fills to ~80% on a fast ease curve, then pauses (mimics
 *     the classic NProgress feel — we don't actually know how long
 *     the RSC fetch will take, so the asymptotic crawl signals "still
 *     working" without lying about completion).
 *   • Completes when the location (path AND query) moves OR when 8s of
 *     guard time has elapsed without it moving (failsafe so a
 *     prevented/cancelled nav doesn't leave the bar stuck).
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
 *     fetching, no router patching, no React state outside this
 *     component.
 *   • No effect on the actual navigation flow — pure visual feedback.
 *   • Failsafe timer makes it impossible for the bar to remain
 *     visible after a real navigation completes.
 */
/**
 * How long a path-changing navigation may keep the page being left on screen
 * before the shell swaps it for a skeleton (PendingRouteSkeleton). Below it, a
 * fast navigation goes straight from the old page to the new one, with the
 * progress bar as its acknowledgement (painted ~30 ms after the click).
 */
export const SLOW_NAVIGATION_MS = 400;

export interface SlowNavigation {
  /** The pathname the navigation left. The skeleton shows only while this is still the URL. */
  from: string;
  /** The pathname it is going to (chooses the skeleton). */
  target: string;
}

export function NavProgressBar({
  onSlowNavigation,
}: {
  /** Called with the navigation once it has waited SLOW_NAVIGATION_MS, and with null when it ends. */
  onSlowNavigation?: (nav: SlowNavigation | null) => void;
} = {}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const currentKey = locationKey(pathname, searchParams?.toString() ?? '');
  const [phase, setPhase] = React.useState<'idle' | 'climbing' | 'completing'>('idle');
  const startKeyRef = React.useRef<string | null>(null);
  // True while the bar climbs for a click that markNavigationClick recorded.
  // Only such a click gets a feedback mark (see the frames effect below).
  const measuredRef = React.useRef(false);
  const failsafeRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const deferredStartRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const slowTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const onSlowRef = React.useRef(onSlowNavigation);
  React.useEffect(() => {
    onSlowRef.current = onSlowNavigation;
  }, [onSlowNavigation]);

  React.useEffect(() => {
    function isModifiedClick(e: MouseEvent): boolean {
      return e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0;
    }

    function endSlow() {
      if (slowTimerRef.current) {
        clearTimeout(slowTimerRef.current);
        slowTimerRef.current = null;
      }
      onSlowRef.current?.(null);
    }

    function start(fromKey: string) {
      startKeyRef.current = fromKey;
      setPhase('climbing');
      if (failsafeRef.current) clearTimeout(failsafeRef.current);
      failsafeRef.current = setTimeout(() => {
        // 8s no-completion guard: cancel quietly. Real navs that take
        // longer are unusual enough that we'd rather hide the bar than
        // pretend it's still loading.
        measuredRef.current = false;
        setPhase('idle');
      }, 8000);
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
      measuredRef.current = true;
      start(fromKey);
      // A path change that has not landed after SLOW_NAVIGATION_MS gets the
      // shell's skeleton. Only while the URL is still the one it left: a
      // route with its own loading.tsx commits its fallback (and the URL)
      // early, and never reaches this.
      endSlow();
      const from = window.location.pathname;
      const target = next.pathname;
      slowTimerRef.current = setTimeout(() => {
        slowTimerRef.current = null;
        if (window.location.pathname !== from) return;
        onSlowRef.current?.({ from, target });
      }, SLOW_NAVIGATION_MS);
    }

    document.addEventListener('click', onClick, { capture: true });
    return () => {
      document.removeEventListener('click', onClick, { capture: true });
      if (deferredStartRef.current) clearTimeout(deferredStartRef.current);
      if (failsafeRef.current) clearTimeout(failsafeRef.current);
      if (slowTimerRef.current) clearTimeout(slowTimerRef.current);
    };
  }, []);

  // The skeleton ends when the navigation does: the URL moved, the failsafe
  // gave up, or the bar went idle for any other reason.
  React.useEffect(() => {
    if (phase === 'climbing') return;
    if (slowTimerRef.current) {
      clearTimeout(slowTimerRef.current);
      slowTimerRef.current = null;
    }
    onSlowRef.current?.(null);
  }, [phase]);

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
  // A bar started by a query-only click marked no click, so it marks no
  // feedback either: the navigation marks.ts has in flight would be an older
  // one, and this bar is not feedback for it.
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
  }, [phase]);

  React.useEffect(() => {
    if (phase === 'climbing' && startKeyRef.current !== currentKey) {
      // Navigation completed — the path or the query changed.
      measuredRef.current = false;
      setPhase('completing');
      if (failsafeRef.current) clearTimeout(failsafeRef.current);
    }
  }, [currentKey, phase]);

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
    const t = setTimeout(() => setPhase('idle'), 250);
    return () => clearTimeout(t);
  }, [phase]);

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

/**
 * Path plus query, the query re-serialized so two spellings of the same
 * params (`%20` and `+`) compare equal. No hash: a hash change is not a
 * navigation.
 */
function locationKey(pathname: string, search: string): string {
  const query = new URLSearchParams(search).toString();
  return query ? `${pathname}?${query}` : pathname;
}
