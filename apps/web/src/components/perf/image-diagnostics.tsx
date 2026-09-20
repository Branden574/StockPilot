'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useLayoutEffect, useRef } from 'react';

import { classifyImageUrl } from '@/lib/perf/image-class';
import { landingRoute } from '@/lib/perf/marks';
import { toRouteTemplate } from '@/lib/perf/route-template';
import {
  MAX_IMAGE_SAMPLES,
  reportImageError,
  reportImages,
  type ImageSample,
} from '@/lib/perf/rum';

/** A page of 300 broken thumbnails is one finding, not 300 events. */
const MAX_ERRORS_PER_VIEW = 20;

interface RouteView {
  pathname: string;
  /** Images that started loading before this moment belong to an earlier view. */
  startedAt: number;
  samples: ImageSample[];
  seen: number;
  errors: number;
  flushed: boolean;
}

/**
 * Only the FIRST view in a document may claim the images that loaded before
 * this component existed (the server-rendered `<img>`s of a hard load). Module
 * scope, because the shell can unmount and mount again within one document.
 */
let firstViewTaken = false;

function startView(pathname: string): RouteView {
  let startedAt = performance.now();
  if (!firstViewTaken) {
    firstViewTaken = true;
    // A hard load of THIS route: everything since navigation start is ours.
    // Arriving here by a soft navigation from sign-in is not, and must not
    // inherit the sign-in page's images.
    if (landingRoute() === toRouteTemplate(pathname)) startedAt = 0;
  }
  return { pathname, startedAt, samples: [], seen: 0, errors: 0, flushed: false };
}

function flush(view: RouteView | null): void {
  if (!view || view.flushed) return;
  // Nothing to send leaves the view OPEN: "at most one event per view" is about
  // events, and a tab hidden before the first photo arrived has sent none.
  if (view.samples.length === 0) return;
  view.flushed = true;
  reportImages(view.pathname, view.samples, view.seen > MAX_IMAGE_SAMPLES);
  view.samples = [];
}

/**
 * How photos are actually loading for real users, without ever recording
 * which photos. Mounted once, inside the dashboard shell; never on the public
 * or share pages. Renders nothing.
 *
 * PRIVACY: an image URL here is a 30-day signed credential whose path names an
 * organization and an item. Both listeners hand the URL straight to
 * `classifyImageUrl` and keep only the class it returns ("a thumbnail through
 * the optimizer", "a master straight from Storage"). No URL, path or token is
 * stored in a variable that outlives the callback, and `rum.ts` would refuse
 * to send one anyway.
 *
 *   (a) Load FAILURES. One capture-phase `error` listener on `window` (resource
 *       errors do not bubble, so capture is the only way to hear them from one
 *       place) reports `perf_image_error` with the class and the route template.
 *
 *   (b) Load TIMINGS. One PerformanceObserver on `resource` entries started by
 *       an `<img>`. Entries are reduced to a class and a duration as they
 *       arrive, and the whole route view is sent as ONE `perf_images` event:
 *       when the route changes, or when the tab is hidden (the last moment a
 *       page can count on). After that flush the view is closed; late entries
 *       are ignored rather than sent as a second, partial batch.
 *
 * COST: the observer callback runs off the critical path, does one URL parse
 * per image and stops at MAX_IMAGE_SAMPLES per view. Nothing polls.
 */
export function ImageDiagnostics() {
  const pathname = usePathname();
  const viewRef = useRef<RouteView | null>(null);

  // LAYOUT effect, not a passive one: it has to stamp the boundary between two
  // route views during the commit that inserts the new route's `<img>`s, before
  // the browser starts fetching them. A passive effect runs a task later, and
  // every above-the-fold image of the new route would be filed under the old one.
  useLayoutEffect(() => {
    if (typeof performance === 'undefined' || !pathname) return;
    // Same route, effect re-run (StrictMode): keep the view and its start time.
    if (viewRef.current?.pathname === pathname) return;
    flush(viewRef.current);
    viewRef.current = startView(pathname);
  }, [pathname]);

  useEffect(() => {
    // The cap has to hold with NO view too (no `performance`, or a null
    // pathname, means the layout effect above never opened one). Without this
    // counter that state had no ceiling at all: a page of broken thumbnails
    // would be one event per image, which is the flood the cap exists to stop.
    let errorsWithoutView = 0;

    const onError = (event: Event) => {
      try {
        const target = event.target;
        if (!(target instanceof HTMLImageElement)) return;
        const view = viewRef.current;
        if (view) {
          view.errors += 1;
          if (view.errors > MAX_ERRORS_PER_VIEW) return;
        } else {
          errorsWithoutView += 1;
          if (errorsWithoutView > MAX_ERRORS_PER_VIEW) return;
        }
        reportImageError(
          view?.pathname ?? window.location.pathname,
          classifyImageUrl(target.currentSrc || target.src, window.location.origin),
        );
      } catch {
        /* diagnostics must never turn a broken image into a broken page */
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') flush(viewRef.current);
    };

    let observer: PerformanceObserver | null = null;
    try {
      if (typeof PerformanceObserver !== 'undefined') {
        observer = new PerformanceObserver((list) => {
          try {
            for (const entry of list.getEntries() as PerformanceResourceTiming[]) {
              if (entry.initiatorType !== 'img') continue;
              const view = viewRef.current;
              if (!view || view.flushed) continue;
              if (entry.startTime < view.startedAt) continue;
              view.seen += 1;
              if (view.seen > MAX_IMAGE_SAMPLES) continue;
              const klass = classifyImageUrl(entry.name, window.location.origin);
              view.samples.push({
                delivery: klass.delivery,
                variant: klass.variant,
                durationMs: entry.duration,
                // Cross-origin responses without Timing-Allow-Origin report every
                // size as 0: "unknown", which must not be counted as a cache miss.
                sizesKnown: entry.transferSize > 0 || entry.decodedBodySize > 0,
                cacheHit: entry.transferSize === 0 && entry.decodedBodySize > 0,
              });
            }
          } catch {
            /* see onError */
          }
        });
        // `buffered` replays what finished before this effect ran: on a hard
        // load that is most of the first screen. `startedAt` keeps a replay
        // from handing an earlier view's images to this one.
        observer.observe({ type: 'resource', buffered: true });
      }
    } catch {
      observer = null; // an engine without resource timing: errors are still reported
    }

    window.addEventListener('error', onError, true);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('error', onError, true);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      observer?.disconnect();
      // The ref is left in place: StrictMode re-runs these effects on the same
      // instance, and the layout effect above must find its view (and the
      // hard-load start time it carries) still there.
      flush(viewRef.current);
    };
  }, []);

  return null;
}

/** Test seam. Not for application code. */
export function __resetImageDiagnosticsForTests(): void {
  firstViewTaken = false;
}
