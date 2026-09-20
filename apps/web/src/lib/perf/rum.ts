/**
 * Real-user performance events: navigation timings, web vitals and image
 * diagnostics, sent through the app's existing analytics wrapper.
 *
 * THE RULE (owner, performance program 2026-09): telemetry never contains a
 * SKU, an item or customer name, an email address, an image URL (they carry
 * signed bearer tokens), a search term, form contents or an inventory value.
 *
 * That rule is enforced by CONSTRUCTION, in two layers, not by reviewing
 * call sites:
 *
 *   1. Every reporter below builds its property bag field by field. Nothing a
 *      caller hands in is spread or passed through. A web-vitals metric
 *      arrives with `entries` (the LCP entry's `url` is a signed photo URL)
 *      and an image sample comes from a component that has seen raw URLs;
 *      neither can reach the wire, because no code path copies them.
 *   2. `emit` is the only caller of `capture`, and it re-checks every value:
 *      a number must be finite; a string must be a route template (and only
 *      under a route key) or a member of a CLOSED vocabulary. Anything else
 *      is dropped, so a future reporter that forgets layer 1 still cannot
 *      leak. The build hash is added by `emit` itself, never taken from a bag.
 *
 * Routes are always templates (`/dashboard/inventory/[id]`); whatever path a
 * caller hands in is run through `toRouteTemplate` here, again.
 *
 * COST: no timers, no observers, no dependency of its own. `capture` is a
 * no-op without a PostHog key, and nothing is ever sent from a share path
 * (`/r/<token>`, `/m/<token>`): PostHog is never initialized there, and a
 * `capture` call would download the SDK onto a public page for nothing.
 */
import { capture } from '@/lib/analytics';
import { LOADED_BUILD } from '@/lib/build-info';
import { isSharePath } from '@/lib/share-paths';

import type { ImageClass } from './image-class';
import { landingRoute, onNavigationMeasured, type NavigationSummary } from './marks';
import { toRouteTemplate } from './route-template';
import { summarize } from './stats';

/**
 * Fraction of page loads that report. 1 = everyone, which is right while the
 * program is establishing a baseline on a small customer base. The decision is
 * made ONCE per page load (one `Math.random()`), not per event, so a sampled
 * session is complete: its navigations, vitals and image batches can be read
 * together. Lower this, never add a per-event coin flip.
 */
export const PERF_SAMPLE_RATE = 1;

export type PerfEventName =
  'perf_navigation' | 'perf_page_useful' | 'perf_web_vital' | 'perf_image_error' | 'perf_images';

/** What a reporter may put in a bag. `null`/`undefined` mean "not measured" and are omitted. */
type PerfValue = number | boolean | string | null | undefined;

const DELIVERIES = [
  'optimizer',
  'storage-signed',
  'storage-transform',
  'storage-other',
  'same-origin',
  'external',
  'inline',
  'unknown',
] as const;
const VARIANTS = ['thumb', 'master', 'not-an-item-photo'] as const;
const RATINGS = ['good', 'needs-improvement', 'poor'] as const;
const VITALS = ['TTFB', 'FCP', 'LCP', 'FID', 'CLS', 'INP'] as const;
const NAV_KINDS = ['soft-nav', 'hard-load'] as const;
const NAVIGATION_TYPES = [
  'navigate',
  'reload',
  'back-forward',
  'back-forward-cache',
  'prerender',
  'restore',
] as const;

/** Every string that may appear as a VALUE, other than a route template under a route key. */
const VOCABULARY: ReadonlySet<string> = new Set<string>([
  ...DELIVERIES,
  ...VARIANTS,
  ...RATINGS,
  ...VITALS,
  ...NAV_KINDS,
  ...NAVIGATION_TYPES,
]);

/** Exactly the shapes `toRouteTemplate` can produce, and the only keys allowed to hold one. */
const ROUTE_TEMPLATE_RE = /^\/$|^(?:\/(?:[a-z][a-z-]{0,39}|\[id\]|\[token\]|\[unknown\]))+$/;
const ROUTE_KEYS: ReadonlySet<string> = new Set(['route', 'from_route']);
const BUILD_RE = /^[0-9a-f]{6,40}$/;
/** Property names are written in this file; the check is for the one place they are computed. */
const KEY_RE = /^[a-z][a-z0-9_]{0,59}$/;

/** A view that loaded more images than this reports the first 300 and says it was capped. */
export const MAX_IMAGE_SAMPLES = 300;

let sampled: boolean | null = null;
let started = false;
let unsubscribe: (() => void) | null = null;

function isSampled(): boolean {
  if (sampled === null) sampled = Math.random() < PERF_SAMPLE_RATE;
  return sampled;
}

function oneOf<T extends string>(allowed: ReadonlyArray<T>, value: unknown): T | null {
  return typeof value === 'string' && (allowed as ReadonlyArray<string>).includes(value)
    ? (value as T)
    : null;
}

/** Whole milliseconds, or null for anything that is not a sane non-negative number. */
function wholeMs(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.round(value);
}

function boundedInt(value: unknown, max: number): number | null {
  const n = wholeMs(value);
  return n !== null && n <= max ? n : null;
}

function isSafeString(key: string, value: string): boolean {
  return ROUTE_KEYS.has(key) ? ROUTE_TEMPLATE_RE.test(value) : VOCABULARY.has(value);
}

/** The ONLY caller of `capture` in the performance code. See layer 2 in the file header. */
function emit(event: PerfEventName, bag: Record<string, PerfValue>): void {
  try {
    if (typeof window === 'undefined') return;
    if (isSharePath(window.location.pathname)) return;
    if (!isSampled()) return;

    const properties: Record<string, number | boolean | string> = {};
    for (const [key, value] of Object.entries(bag)) {
      if (!KEY_RE.test(key)) continue;
      if (typeof value === 'number') {
        if (Number.isFinite(value)) properties[key] = value;
      } else if (typeof value === 'boolean') {
        properties[key] = value;
      } else if (typeof value === 'string') {
        if (isSafeString(key, value)) properties[key] = value;
      }
    }
    if (BUILD_RE.test(LOADED_BUILD)) properties.build = LOADED_BUILD;
    capture(event, properties);
  } catch {
    /* telemetry must never break the page it is measuring */
  }
}

/**
 * Every reporter below is TOTAL: it runs inside a React effect (the image
 * batch inside a LAYOUT effect of the dashboard shell), where an exception
 * would not be a lost sample but an error boundary over the page being
 * measured. `emit` guards the send; `guarded` covers the few lines that build
 * the bag, for input this file did not construct (a metric object from a
 * library, a sample array from a component).
 */
function guarded(report: () => void): void {
  try {
    report();
  } catch {
    /* telemetry must never break the page it is measuring */
  }
}

export function reportNavigation(summary: NavigationSummary): void {
  guarded(() => {
    if (!summary || typeof summary !== 'object') return;
    if (summary.kind === 'soft-nav') {
      const clickToUseful = wholeMs(summary.clickToUsefulMs);
      if (clickToUseful === null) return;
      emit('perf_navigation', {
        nav_kind: 'soft-nav',
        route: toRouteTemplate(summary.toRoute),
        from_route: toRouteTemplate(summary.fromRoute),
        click_to_feedback_ms: wholeMs(summary.clickToFeedbackMs),
        click_to_useful_ms: clickToUseful,
        intent_lead_ms: wholeMs(summary.intentLeadMs),
      });
      return;
    }
    if (summary.kind === 'hard-load') {
      const useful = wholeMs(summary.usefulMs);
      if (useful === null) return;
      emit('perf_page_useful', {
        nav_kind: 'hard-load',
        route: toRouteTemplate(summary.route),
        useful_ms: useful,
      });
    }
  });
}

/** The part of a web-vitals metric this file is willing to look at. `entries` is not in it. */
export interface WebVitalLike {
  name?: unknown;
  value?: unknown;
  delta?: unknown;
  rating?: unknown;
  navigationType?: unknown;
}

/**
 * `route` is the route the DOCUMENT was loaded on, not the one on screen when
 * the metric is reported. Vitals describe a document: LCP and CLS are often
 * finalized when the tab is hidden, many soft navigations later, and filing
 * them under whatever screen happened to be open then would smear one page's
 * load across the whole app.
 */
export function reportWebVital(metric: WebVitalLike | null | undefined): void {
  guarded(() => {
    if (typeof window === 'undefined') return;
    if (!metric || typeof metric !== 'object') return;
    const name = oneOf(VITALS, metric.name);
    if (name === null) return;
    if (typeof metric.value !== 'number' || !Number.isFinite(metric.value) || metric.value < 0) {
      return;
    }
    // CLS is a unitless score around 0.1: rounding it to an integer would erase it.
    const round = (n: unknown): number | null => {
      if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return null;
      return name === 'CLS' ? Math.round(n * 1000) / 1000 : Math.round(n);
    };
    emit('perf_web_vital', {
      metric: name,
      value: round(metric.value),
      delta: round(metric.delta),
      rating: oneOf(RATINGS, metric.rating),
      navigation_type: oneOf(NAVIGATION_TYPES, metric.navigationType),
      route: landingRoute() ?? toRouteTemplate(window.location.pathname),
    });
  });
}

function classProperties(klass: ImageClass | null | undefined): Record<string, PerfValue> {
  return {
    delivery: oneOf(DELIVERIES, klass?.delivery) ?? 'unknown',
    upstream: oneOf(DELIVERIES, klass?.upstream),
    variant: oneOf(VARIANTS, klass?.variant) ?? 'not-an-item-photo',
    // Parsed out of a URL, so bounded: a width is a width, not a free-form number.
    requested_width: boundedInt(klass?.requestedWidth, 10_000),
    requested_quality: boundedInt(klass?.requestedQuality, 100),
    signed: klass?.signed === true,
  };
}

/** An `<img>` failed to load. `klass` comes from `classifyImageUrl`; the URL itself never gets here. */
export function reportImageError(pathname: string | null | undefined, klass: ImageClass): void {
  guarded(() => {
    emit('perf_image_error', { route: toRouteTemplate(pathname), ...classProperties(klass) });
  });
}

export interface ImageSample {
  delivery: ImageClass['delivery'];
  variant: ImageClass['variant'];
  durationMs: number;
  /** The browser exposed body sizes (same-origin, or a `Timing-Allow-Origin` response). */
  sizesKnown: boolean;
  /** `transferSize === 0` with a non-zero decoded body: served from the browser cache. */
  cacheHit: boolean;
}

function countKey(delivery: string, variant: string): string {
  return `images_${delivery}_${variant}`.replace(/-/g, '_');
}

/**
 * ONE event for every image a route view loaded: how many of each class, how
 * long they took, how many came from the browser cache. `capped` says the view
 * loaded more than the component was willing to count.
 */
export function reportImages(
  pathname: string | null | undefined,
  samples: ReadonlyArray<ImageSample>,
  capped = false,
): void {
  guarded(() => {
    if (!Array.isArray(samples) || samples.length === 0) return;
    const counted = samples.slice(0, MAX_IMAGE_SAMPLES);
    const bag: Record<string, PerfValue> = {
      route: toRouteTemplate(pathname),
      image_count: counted.length,
      capped: capped === true || samples.length > MAX_IMAGE_SAMPLES,
    };
    let sizesKnown = 0;
    let cacheHits = 0;
    for (const sample of counted) {
      const key = countKey(
        oneOf(DELIVERIES, sample?.delivery) ?? 'unknown',
        oneOf(VARIANTS, sample?.variant) ?? 'not-an-item-photo',
      );
      const current = bag[key];
      bag[key] = (typeof current === 'number' ? current : 0) + 1;
      if (sample?.sizesKnown === true) {
        sizesKnown += 1;
        if (sample.cacheHit === true) cacheHits += 1;
      }
    }
    // Nearest-rank (stats.ts): the median is a duration that was actually observed.
    const durations = summarize(counted.map((s) => wholeMs(s?.durationMs)));
    bag.duration_p50_ms = durations?.p50 ?? null;
    bag.duration_max_ms = durations?.max ?? null;
    // A cache-hit count means nothing without its denominator: cross-origin
    // images without Timing-Allow-Origin report every size as 0 and cannot be told apart.
    bag.sizes_known_count = sizesKnown;
    bag.cache_hit_count = cacheHits;
    emit('perf_images', bag);
  });
}

/**
 * Connects the navigation marks to analytics. Idempotent; called from the one
 * performance component that is mounted on every route.
 */
export function startPerfRum(): void {
  if (started || typeof window === 'undefined') return;
  started = true;
  unsubscribe = onNavigationMeasured(reportNavigation);
}

/** Test seam. Not for application code. */
export function __resetForTests(): void {
  unsubscribe?.();
  unsubscribe = null;
  started = false;
  sampled = null;
}
