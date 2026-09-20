'use client';

import { useEffect, type ReactNode } from 'react';

import { markNavigationUseful } from '@/lib/perf/marks';

/**
 * "The real content of this route is on screen."
 *
 * Put it WHERE THE DATA MOUNTS and nowhere else: inside the Suspense boundary
 * that carries the rows, next to the markup they render into, including the
 * rich empty state (an empty list is a finished page). Never in a loading.tsx,
 * a skeleton, or a shell that paints before its data: a marker there would
 * report the wait as over while the person is still looking at grey boxes, and
 * every number built on it would be flattering and wrong.
 *
 * It fires ONCE, on mount. A component that stays mounted while its data
 * changes underneath it (the inventory table adopting its streamed dataset, a
 * filter re-running the server component) does not fire again, which is the
 * point: the first rows are what the person was waiting for.
 *
 * The pathname is read from `location` inside the effect rather than from
 * `usePathname()`. They agree by then (the router writes history in an
 * insertion effect of the same commit, before any passive effect runs), and
 * reading it this way adds no router subscription, and therefore no re-render,
 * to the large client components that host this hook.
 */
export function usePerfUseful(): void {
  useEffect(() => {
    // Two animation frames, like the click-feedback marks and like the external
    // harness (tests/perf/collector.ts): an effect runs BEFORE its commit is
    // painted, so stamping here would report content as visible up to two
    // frames before anyone could see it, and field numbers would read faster
    // than synthetic ones for no real reason. One frame late at worst, never
    // early. The path is captured now: by the second frame a fast second click
    // may already have moved the URL on.
    const pathname = window.location.pathname;
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => markNavigationUseful(pathname));
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, []);
}

/**
 * The same marker for server-rendered pages: render it beside the data markup.
 * Renders nothing of its own. `children` exists for the early-return shape
 * (`if (emptyState) return <PerfUseful>{emptyState}</PerfUseful>;`), where there
 * is no surrounding markup to sit beside; they are rendered untouched.
 */
export function PerfUseful({ children }: { children?: ReactNode }) {
  usePerfUseful();
  return children ?? null;
}
