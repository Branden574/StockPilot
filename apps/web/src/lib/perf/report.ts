/**
 * Turns the performance harness's raw samples into the owner's report: a
 * percentile table, a before/after comparison, a photo-delivery audit, and an
 * SVG chart drawn from the same numbers. Pure functions, no I/O, so every rule
 * below is unit-tested.
 *
 * THE RULES THIS FILE ENFORCES
 *   - A cell is a measurement or it says "not measured". Nothing is estimated,
 *     carried over, or filled in.
 *   - Every row shows how many samples it rests on, how many were attempted,
 *     how many failed and how many had no value. A row with failures gets no
 *     budget verdict and no improved/regressed label.
 *   - "Improved" and "regressed" need three things at once: a change of at least
 *     10%, a change bigger than the instrument's resolution, and a change bigger
 *     than the two runs' own scatter (a seeded bootstrap). A p95 that gets 10%
 *     worse is a regression even when p75 improved (owner's trigger).
 *   - Two runs are only compared as equals when they were taken the same way.
 */
import type { ImageClass } from './image-class';
import {
  bootstrapPercentileDelta,
  deltaPercent,
  summarize,
  summarizeWithUnfinished,
  type Summary,
} from './stats';

/** Bump when the SHAPE of results.json changes. */
export const SCHEMA_VERSION = 5;
/** Bump when WHAT A NUMBER MEANS changes (a marker, a clock, a floor). Runs with different values are not comparable. */
export const HARNESS_VERSION = '2026-09-20.4';

export interface ImageRecord {
  order: number;
  row: number | null;
  /** True for the photos the scenario calls "first": the first N rows, or the first N cards. */
  first: boolean;
  renderedWidth: number;
  renderedHeight: number;
  naturalWidth: number;
  naturalHeight: number;
  devicePixelRatio: number;
  loading: string;
  fetchPriority: string | null;
  hasBlurPlaceholder: boolean;
  complete: boolean;
  failed: boolean;
  /** Visible to the person: never earlier than the content it sits in. Null when broken or unfinished. */
  doneMs: number | null;
  /** Bytes in hand, with no floor applied. */
  bytesReadyMs: number | null;
  /** When the browser started fetching it. Late discovery shows up here, slow delivery in the gap to `bytesReadyMs`. */
  requestStartMs: number | null;
  klass: ImageClass;
  objectFingerprint: string | null;
  tokenFingerprint: string | null;
  network: {
    status: number | null;
    servedFromBrowserCache: boolean | null;
    cacheControl: string | null;
    age: string | null;
    cfCacheStatus: string | null;
    vercelCache: string | null;
    contentType: string | null;
    contentLength: number | null;
    hasEtag: boolean;
    wireBytes: number | null;
    cache: 'memory' | 'disk' | 'revalidated' | 'network' | null;
  } | null;
}

export interface PhotoSample {
  visibleCount: number;
  firstCount: number;
  failedCount: number;
  /** Still loading when the harness stopped waiting (PERF_IMAGE_WAIT_MS). */
  unfinishedCount: number;
  /** How many visible photos had their bytes BEFORE the content painted, so their "done" time is the paint time. */
  flooredCount: number;
  firstDoneMs: number | null;
  allVisibleDoneMs: number | null;
  /** Earliest fetch start among the "first" photos. */
  firstRequestStartMs: number | null;
  firstBytesReadyMs: number | null;
  allVisibleBytesReadyMs: number | null;
  images: ImageRecord[];
}

export interface PageFetch {
  kind: string;
  route: string;
  status: number | null;
  ttfbMs: number | null;
  totalMs: number | null;
  /** Browser wall clock (ms since epoch). */
  requestSentAt: number | null;
  firstByteAt: number | null;
  wireBytes: number | null;
  vercelCache: string | null;
  regions: string | null;
}

export interface NetworkSample {
  counts: Record<string, number>;
  bytes: Record<string, number | null>;
  total: number;
  wireBytes: number | null;
  rscRoutes: Record<string, number>;
  prefetchRoutes: Record<string, number>;
  serverActions: string[];
  pageFetches: PageFetch[];
  failedPageFetches: number;
  images: {
    requests: number;
    fromBrowserCache: number | null;
    notFromCache: number | null;
    /** Answered 304: the browser had the bytes but had to ask the server first. */
    revalidated: number;
    wireBytes: number | null;
  };
}

export interface Sample {
  scenario: string;
  iteration: number;
  /** Iteration 0: pays for cold caches, stored, never part of the percentiles. */
  warmup: boolean;
  /** Wall-clock start, so a slow outlier can be matched to server logs. */
  at: string;
  ok: boolean;
  /** A short classified code (`timeout:useful`, `link-missing`…), never free text. */
  error: string | null;
  feedbackMs: number | null;
  feedbackPaintMs: number | null;
  feedbackBy: string | null;
  clickEventDurationMs: number | null;
  clickInputDelayMs: number | null;
  /** How long the pointer had really been on the link before the click. */
  hoverLeadMs: number | null;
  usefulMs: number | null;
  usefulPaintMs: number | null;
  /** The route's loading skeleton on screen. Null when content arrived without one (a client-cache hit). */
  shellPaintMs: number | null;
  /** Page-data fetch on the page's own clock, from the click. */
  rscRequestStartMs: number | null;
  rscFirstByteMs: number | null;
  ttfbMs: number | null;
  fcpMs: number | null;
  lcpMs: number | null;
  /** Null on engines that cannot report it, which is not the same as 0. */
  cls: number | null;
  longTaskBlockingMs: number | null;
  consoleErrors: number | null;
  hydrationErrors: number | null;
  listRows: number | null;
  network: NetworkSample | null;
  photos: PhotoSample | null;
}

export interface RunMeta {
  schemaVersion: number;
  harnessVersion: string;
  label: string;
  kind: 'lab' | 'preview-synthetic' | 'production-synthetic' | 'unknown-target';
  host: string;
  buildAtStart: string | null;
  buildAtEnd: string | null;
  builtAt: string | null;
  startedAt: string;
  finishedAt: string;
  browser: string;
  browserVersion: string;
  viewport: string | null;
  devicePixelRatio: number;
  /** Operator label for the network profile. */
  network: string;
  /** Measured: median round trip of a few tiny same-origin requests at run start. */
  rttMs: number | null;
  machine: string;
  /** What the SERVER said the signed-in account is. */
  role: string | null;
  roleLabel: string;
  dataset: string;
  /** `post-deploy` | `post-idle` | `first-org-request` | `steady` | `not controlled`. */
  serverState: string;
  iterations: number;
  coldIterations: number;
  hoverMs: number;
  settleMs: number;
  usefulTimeoutMs: number;
  imageWaitMs: number;
  unsupportedMetrics: string[];
}

export interface RunFile {
  meta: RunMeta;
  scenarios: Array<{ id: string; title: string; kind: string; routes?: string[] }>;
  samples: Sample[];
}

export interface Budget {
  p75?: number;
  p95?: number;
  source: string;
}

type Unit = 'ms' | 'score' | 'count' | 'KB';
type Group =
  'owner' | 'click' | 'navigation' | 'photos' | 'hard-load' | 'first-visit' | 'network' | 'health';

export interface RowSpec {
  id: string;
  title: string;
  scenario: string;
  unit: Unit;
  group: Group;
  pick: (s: Sample) => number | null;
  /** `right`: a TIME row. A sample that never finished is slower than every value present and is ranked last. */
  censored?: 'right';
  /**
   * For a finished iteration with no value: did this metric fail to finish
   * (photos still loading or broken), or was there simply nothing to measure
   * (no photos on screen)? Only the first is ranked as "did not finish".
   */
  unfinishedWhen?: (s: Sample) => boolean;
  /** Absent = no budget frozen yet. */
  budget?: Budget;
}

/** Smallest change each unit can honestly resolve: a frame, a thousandth of CLS, one request, one KB. */
const RESOLUTION: Record<Unit, number> = { ms: 17, score: 0.01, count: 1, KB: 1 };

const BRIEF = 'owner brief 2026-09';
const WARM_NAV: Budget = { p75: 500, p95: 1000, source: BRIEF };
const CLICK: Budget = { p75: 75, p95: 150, source: BRIEF };
const ZERO: Budget = { p75: 0, p95: 0, source: `${BRIEF}: no regression` };

const useful = (s: Sample) => s.usefulPaintMs;
const photosUnfinished = (s: Sample) =>
  Boolean(s.photos && (s.photos.unfinishedCount > 0 || s.photos.failedCount > 0));
const feedback = (s: Sample) => s.feedbackPaintMs;
const kb = (bytes: number | null | undefined) => (typeof bytes === 'number' ? bytes / 1024 : null);
const prefetches = (route: string) => (s: Sample) =>
  s.network ? (s.network.prefetchRoutes[route] ?? 0) : null;
/** Server + network share of the page-data fetch, with the client's own queueing taken out. */
const rscWait = (s: Sample) =>
  s.rscFirstByteMs === null || s.rscRequestStartMs === null
    ? null
    : s.rscFirstByteMs - s.rscRequestStartMs;
const shell = (s: Sample) => s.shellPaintMs;
const allPrefetches = (s: Sample) => (s.network ? (s.network.counts['rsc-prefetch'] ?? 0) : null);

/** The first six are the owner's required table, in the owner's order. */
export const ROWS: RowSpec[] = [
  {
    id: 'nav-inventory',
    group: 'owner',
    title: 'Dashboard → Inventory',
    scenario: 'dashboard-to-inventory',
    unit: 'ms',
    censored: 'right',
    pick: useful,
    budget: WARM_NAV,
  },
  {
    id: 'nav-orders',
    group: 'owner',
    title: 'Dashboard → Orders',
    scenario: 'dashboard-to-orders',
    unit: 'ms',
    censored: 'right',
    pick: useful,
    budget: WARM_NAV,
  },
  {
    id: 'nav-item',
    group: 'owner',
    title: 'Inventory → Item',
    scenario: 'inventory-to-item',
    unit: 'ms',
    censored: 'right',
    pick: useful,
    budget: WARM_NAV,
  },
  {
    id: 'photos-first',
    group: 'owner',
    title: 'Inventory first-row photos (warm browser cache)',
    scenario: 'dashboard-to-inventory',
    unit: 'ms',
    censored: 'right',
    unfinishedWhen: photosUnfinished,
    pick: (s) => s.photos?.firstDoneMs ?? null,
  },
  {
    id: 'photos-all',
    group: 'owner',
    title: 'Inventory all visible photos (warm browser cache)',
    scenario: 'dashboard-to-inventory',
    unit: 'ms',
    censored: 'right',
    unfinishedWhen: photosUnfinished,
    pick: (s) => s.photos?.allVisibleDoneMs ?? null,
  },
  {
    id: 'hard-inventory',
    group: 'owner',
    title: 'Hard-load Inventory (warm browser cache)',
    scenario: 'hard-load-inventory',
    unit: 'ms',
    censored: 'right',
    pick: useful,
  },

  {
    id: 'click-inventory',
    group: 'click',
    title: 'Click → visible response (sidebar, Inventory)',
    scenario: 'dashboard-to-inventory',
    unit: 'ms',
    pick: feedback,
    budget: CLICK,
  },
  {
    id: 'click-orders',
    group: 'click',
    title: 'Click → visible response (sidebar, Orders)',
    scenario: 'dashboard-to-orders',
    unit: 'ms',
    pick: feedback,
    budget: CLICK,
  },
  {
    id: 'click-item',
    group: 'click',
    title: 'Click → visible response (item row)',
    scenario: 'inventory-to-item',
    unit: 'ms',
    pick: feedback,
    budget: CLICK,
  },
  {
    id: 'click-paint-item',
    group: 'click',
    title:
      'Click → next paint, browser Event Timing (item row; entries under 16 ms are not reported)',
    scenario: 'inventory-to-item',
    unit: 'ms',
    pick: (s) => s.clickEventDurationMs,
    budget: CLICK,
  },

  {
    id: 'nav-order',
    group: 'navigation',
    title: 'Orders → Order',
    scenario: 'orders-to-order',
    unit: 'ms',
    censored: 'right',
    pick: useful,
    budget: WARM_NAV,
  },
  {
    id: 'nav-books',
    group: 'navigation',
    title: 'Dashboard → Books',
    scenario: 'dashboard-to-books',
    unit: 'ms',
    censored: 'right',
    pick: useful,
    budget: WARM_NAV,
  },
  {
    id: 'revisit',
    group: 'navigation',
    title: 'Inventory revisit within 90 s',
    scenario: 'inventory-revisit',
    unit: 'ms',
    censored: 'right',
    pick: useful,
    budget: WARM_NAV,
  },
  {
    id: 'nav-storefront',
    group: 'navigation',
    title: 'Orders → New order (storefront)',
    scenario: 'orders-to-storefront',
    unit: 'ms',
    censored: 'right',
    pick: useful,
    budget: WARM_NAV,
  },
  {
    id: 'shell-inventory',
    group: 'navigation',
    title: 'Click → loading skeleton visible (Inventory)',
    scenario: 'dashboard-to-inventory',
    unit: 'ms',
    pick: shell,
  },
  {
    id: 'shell-item',
    group: 'navigation',
    title: 'Click → loading skeleton visible (Item)',
    scenario: 'inventory-to-item',
    unit: 'ms',
    pick: shell,
  },
  {
    id: 'rsc-wait-inventory',
    group: 'navigation',
    title: 'Page-data fetch: request → first byte (Inventory)',
    scenario: 'dashboard-to-inventory',
    unit: 'ms',
    pick: rscWait,
    budget: { p75: 300, p95: 600, source: `${BRIEF}: warm authenticated TTFB` },
  },
  {
    id: 'rsc-wait-orders',
    group: 'navigation',
    title: 'Page-data fetch: request → first byte (Orders)',
    scenario: 'dashboard-to-orders',
    unit: 'ms',
    pick: rscWait,
    budget: { p75: 300, p95: 600, source: `${BRIEF}: warm authenticated TTFB` },
  },
  {
    id: 'rsc-wait-item',
    group: 'navigation',
    title: 'Page-data fetch: request → first byte (Item)',
    scenario: 'inventory-to-item',
    unit: 'ms',
    pick: rscWait,
    budget: { p75: 300, p95: 600, source: `${BRIEF}: warm authenticated TTFB` },
  },
  {
    id: 'rsc-start-inventory',
    group: 'navigation',
    title: 'Click → page-data request sent (Inventory)',
    scenario: 'dashboard-to-inventory',
    unit: 'ms',
    pick: (s) => s.rscRequestStartMs,
  },
  {
    id: 'rsc-byte-inventory',
    group: 'navigation',
    title: 'Click → page-data first byte (Inventory)',
    scenario: 'dashboard-to-inventory',
    unit: 'ms',
    pick: (s) => s.rscFirstByteMs,
  },
  {
    id: 'rsc-byte-orders',
    group: 'navigation',
    title: 'Click → page-data first byte (Orders)',
    scenario: 'dashboard-to-orders',
    unit: 'ms',
    pick: (s) => s.rscFirstByteMs,
  },
  {
    id: 'rsc-byte-item',
    group: 'navigation',
    title: 'Click → page-data first byte (Item)',
    scenario: 'inventory-to-item',
    unit: 'ms',
    pick: (s) => s.rscFirstByteMs,
  },

  {
    id: 'photos-first-request',
    group: 'photos',
    title: 'Inventory: first photo REQUESTED (discovery)',
    scenario: 'dashboard-to-inventory',
    unit: 'ms',
    pick: (s) => s.photos?.firstRequestStartMs ?? null,
  },
  {
    id: 'store-photos-request',
    group: 'photos',
    title: 'Storefront: first photo REQUESTED (discovery)',
    scenario: 'orders-to-storefront',
    unit: 'ms',
    pick: (s) => s.photos?.firstRequestStartMs ?? null,
  },
  {
    id: 'books-photos-all',
    group: 'photos',
    title: 'Books all visible photos (warm browser cache)',
    scenario: 'dashboard-to-books',
    unit: 'ms',
    censored: 'right',
    unfinishedWhen: photosUnfinished,
    pick: (s) => s.photos?.allVisibleDoneMs ?? null,
  },
  {
    id: 'photos-first-bytes',
    group: 'photos',
    title: 'Inventory first-row photos: bytes in hand (no floor)',
    scenario: 'dashboard-to-inventory',
    unit: 'ms',
    censored: 'right',
    unfinishedWhen: photosUnfinished,
    pick: (s) => s.photos?.firstBytesReadyMs ?? null,
  },
  {
    id: 'store-photos-first',
    group: 'photos',
    title: 'Storefront first cards: photos (warm browser cache)',
    scenario: 'orders-to-storefront',
    unit: 'ms',
    censored: 'right',
    unfinishedWhen: photosUnfinished,
    pick: (s) => s.photos?.firstDoneMs ?? null,
  },
  {
    id: 'store-photos-all',
    group: 'photos',
    title: 'Storefront all visible photos (warm browser cache)',
    scenario: 'orders-to-storefront',
    unit: 'ms',
    censored: 'right',
    unfinishedWhen: photosUnfinished,
    pick: (s) => s.photos?.allVisibleDoneMs ?? null,
  },

  {
    id: 'hover-lead',
    group: 'click',
    title: 'Pointer on the link before the click (what intent warming had to work with)',
    scenario: 'dashboard-to-inventory',
    unit: 'ms',
    pick: (s) => s.hoverLeadMs,
  },
  {
    id: 'hard-ttfb',
    group: 'hard-load',
    title: 'Hard-load Inventory: document first byte (static shell, reused connection)',
    scenario: 'hard-load-inventory',
    unit: 'ms',
    pick: (s) => s.ttfbMs,
  },
  {
    id: 'hard-lcp',
    group: 'hard-load',
    title: 'Hard-load Inventory: LCP',
    scenario: 'hard-load-inventory',
    unit: 'ms',
    pick: (s) => s.lcpMs,
    budget: { p75: 2500, source: `${BRIEF} (stretch 1800)` },
  },
  {
    id: 'hard-cls',
    group: 'hard-load',
    title: 'Hard-load Inventory: layout shift, load → content + 1 s (sum)',
    scenario: 'hard-load-inventory',
    unit: 'score',
    pick: (s) => s.cls,
    budget: { p75: 0.1, source: BRIEF },
  },
  {
    id: 'hard-photos-all',
    group: 'hard-load',
    title: 'Hard-load Inventory: all visible photos (warm browser cache)',
    scenario: 'hard-load-inventory',
    unit: 'ms',
    censored: 'right',
    unfinishedWhen: photosUnfinished,
    pick: (s) => s.photos?.allVisibleDoneMs ?? null,
  },
  {
    id: 'hard-storefront',
    group: 'hard-load',
    title: 'Hard-load storefront',
    scenario: 'hard-load-storefront',
    unit: 'ms',
    censored: 'right',
    pick: useful,
  },
  {
    id: 'hard-store-photos',
    group: 'hard-load',
    title: 'Hard-load storefront: all visible photos (warm browser cache)',
    scenario: 'hard-load-storefront',
    unit: 'ms',
    censored: 'right',
    unfinishedWhen: photosUnfinished,
    pick: (s) => s.photos?.allVisibleDoneMs ?? null,
  },

  {
    id: 'cold-nav',
    group: 'first-visit',
    title: 'Dashboard → Inventory, first visit (empty browser cache, warm server)',
    scenario: 'dashboard-to-inventory-cold-browser',
    unit: 'ms',
    censored: 'right',
    pick: useful,
  },
  {
    id: 'cold-nav-photos-first',
    group: 'first-visit',
    title: 'Empty browser cache: first-row photos',
    scenario: 'dashboard-to-inventory-cold-browser',
    unit: 'ms',
    censored: 'right',
    unfinishedWhen: photosUnfinished,
    pick: (s) => s.photos?.firstDoneMs ?? null,
  },
  {
    id: 'cold-nav-photos-all',
    group: 'first-visit',
    title: 'Empty browser cache: all visible photos',
    scenario: 'dashboard-to-inventory-cold-browser',
    unit: 'ms',
    censored: 'right',
    unfinishedWhen: photosUnfinished,
    pick: (s) => s.photos?.allVisibleDoneMs ?? null,
  },
  {
    id: 'cold-ttfb',
    group: 'first-visit',
    title: 'Hard-load Inventory: document first byte (new connection)',
    scenario: 'hard-load-inventory-cold-browser',
    unit: 'ms',
    pick: (s) => s.ttfbMs,
  },
  {
    id: 'cold-hard',
    group: 'first-visit',
    title: 'Hard-load Inventory, first visit (empty browser cache, warm server)',
    scenario: 'hard-load-inventory-cold-browser',
    unit: 'ms',
    censored: 'right',
    pick: useful,
  },
  {
    id: 'cold-store-photos',
    group: 'first-visit',
    title: 'Hard-load storefront, empty browser cache: all visible photos',
    scenario: 'hard-load-storefront-cold-browser',
    unit: 'ms',
    censored: 'right',
    unfinishedWhen: photosUnfinished,
    pick: (s) => s.photos?.allVisibleDoneMs ?? null,
  },

  {
    id: 'req-inventory',
    group: 'network',
    title: 'Requests, click → content + 1 s (Inventory)',
    scenario: 'dashboard-to-inventory',
    unit: 'count',
    pick: (s) => s.network?.total ?? null,
  },
  {
    id: 'prefetch-order-rows',
    group: 'network',
    title: 'Order-detail prefetches fired by the Orders list',
    scenario: 'dashboard-to-orders',
    unit: 'count',
    pick: prefetches('/dashboard/orders/[id]'),
    budget: ZERO,
  },
  {
    id: 'prefetch-item-rows',
    group: 'network',
    title: 'Item-detail prefetches fired by the Inventory list',
    scenario: 'dashboard-to-inventory',
    unit: 'count',
    pick: prefetches('/dashboard/inventory/[id]'),
    budget: ZERO,
  },
  {
    id: 'prefetch-hard',
    group: 'network',
    title: 'Background prefetches during a hard load (Inventory)',
    scenario: 'hard-load-inventory',
    unit: 'count',
    pick: allPrefetches,
  },
  {
    id: 'bytes-rsc',
    group: 'network',
    title: 'Page-data bytes (Inventory)',
    scenario: 'dashboard-to-inventory',
    unit: 'KB',
    pick: (s) => kb(s.network?.bytes.rsc),
  },
  {
    id: 'bytes-script',
    group: 'network',
    title: 'Script bytes, empty browser cache (hard-load Inventory)',
    scenario: 'hard-load-inventory-cold-browser',
    unit: 'KB',
    pick: (s) => kb(s.network?.bytes.script),
  },
  {
    id: 'bytes-image',
    group: 'network',
    title: 'Image bytes, empty browser cache (hard-load Inventory)',
    scenario: 'hard-load-inventory-cold-browser',
    unit: 'KB',
    pick: (s) => kb(s.network?.images.wireBytes),
  },
  {
    id: 'image-misses',
    group: 'network',
    title: 'Images NOT served from the browser cache (Inventory, warm)',
    scenario: 'dashboard-to-inventory',
    unit: 'count',
    pick: (s) => s.network?.images.notFromCache ?? null,
  },
  {
    id: 'image-304',
    group: 'network',
    title: 'Images the browser had to re-check with the server, 304 (Inventory, warm)',
    scenario: 'dashboard-to-inventory',
    unit: 'count',
    pick: (s) => s.network?.images.revalidated ?? null,
  },
  {
    id: 'bytes-hard',
    group: 'network',
    title: 'Bytes on the wire (hard-load Inventory, warm browser cache)',
    scenario: 'hard-load-inventory',
    unit: 'KB',
    pick: (s) => kb(s.network?.wireBytes),
  },

  {
    id: 'dataset-rows',
    group: 'health',
    title: 'Dataset: rows in the Inventory list',
    scenario: 'dashboard-to-inventory',
    unit: 'count',
    pick: (s) => s.listRows,
  },
  {
    id: 'dataset-photos',
    group: 'health',
    title: 'Dataset: photos on screen (Inventory)',
    scenario: 'dashboard-to-inventory',
    unit: 'count',
    pick: (s) => s.photos?.visibleCount ?? null,
  },
  {
    id: 'broken-photos',
    group: 'health',
    title: 'Broken photos per view (Inventory)',
    scenario: 'dashboard-to-inventory',
    unit: 'count',
    pick: (s) => s.photos?.failedCount ?? null,
    budget: ZERO,
  },
  {
    id: 'broken-store-photos',
    group: 'health',
    title: 'Broken photos per view (storefront)',
    scenario: 'hard-load-storefront',
    unit: 'count',
    pick: (s) => s.photos?.failedCount ?? null,
    budget: ZERO,
  },
  {
    id: 'failed-fetches',
    group: 'health',
    title: 'Failed page-data fetches per navigation (Inventory)',
    scenario: 'dashboard-to-inventory',
    unit: 'count',
    pick: (s) => s.network?.failedPageFetches ?? null,
    budget: ZERO,
  },
  {
    id: 'hydration-errors',
    group: 'health',
    title: 'Hydration errors per hard load (Inventory)',
    scenario: 'hard-load-inventory',
    unit: 'count',
    pick: (s) => s.hydrationErrors,
    budget: ZERO,
  },
  {
    id: 'console-errors',
    group: 'health',
    title: 'Console errors per hard load (Inventory)',
    scenario: 'hard-load-inventory',
    unit: 'count',
    pick: (s) => s.consoleErrors,
  },
];

export interface RowResult {
  spec: RowSpec;
  summary: Summary | null;
  /** Timed iterations run (warm-up excluded). */
  attempted: number;
  /** Iterations that threw: no metric at all. */
  failed: number;
  /** Iterations that finished but had no value for THIS metric. */
  noValue: number;
  /**
   * Samples that never finished and are RANKED LAST in this row's percentiles
   * (time rows only): timed-out / crashed iterations plus samples with no value.
   */
  unfinished: number;
  /** Failed iterations that are NOT "did not finish" (a missing link, a harness error): these void the row. */
  otherFailures: number;
  /** For the noise check: finished values, plus the give-up time for each unfinished sample (a lower bound). */
  values: number[];
  /** Which element(s) counted as click feedback, most common first. */
  detectors: string;
}

/** Failure codes that mean "the person never got the content", as opposed to "the harness could not run". */
const DID_NOT_FINISH = new Set(['timeout:useful', 'error-screen', 'page-crashed']);
/** On rows that are not times, this share of failed iterations is tolerated (and stated). */
const TOLERATED_FAILURE_SHARE = 0.05;

/** A selector is long and unreadable in a table; name what it matched. */
function detectorName(by: string | null): string {
  if (!by) return '';
  if (by === 'url-changed') return 'URL change';
  return by.includes('animate-spin')
    ? 'link spinner'
    : by.includes('nav-progress')
      ? 'progress bar'
      : 'other';
}

/**
 * A results file is only read by the code that understands its shape. An older
 * file is REFUSED with one sentence, never half-read into "not measured" cells
 * that would look like a run with no data.
 */
export function parseRunFile(raw: unknown, name: string): RunFile {
  const file = raw as Partial<RunFile> | null;
  const version = file?.meta?.schemaVersion;
  if (
    !file ||
    typeof file !== 'object' ||
    !file.meta ||
    !Array.isArray(file.samples) ||
    !Array.isArray(file.scenarios)
  ) {
    throw new Error(`The ${name} file is not a performance results file.`);
  }
  if (version !== SCHEMA_VERSION) {
    throw new Error(
      `NOT COMPARABLE: the ${name} run was written by results schema v${version ?? 1} (harness ${file.meta.harnessVersion ?? 'unknown'}); this tool reads v${SCHEMA_VERSION}. Re-take that run with the current harness.`,
    );
  }
  return file as RunFile;
}

export function summarizeRun(run: RunFile, rows: RowSpec[] = ROWS): RowResult[] {
  return rows.map((spec) => {
    const timed = run.samples.filter((s) => s.scenario === spec.scenario && !s.warmup);
    const ok = timed.filter((s) => s.ok);
    // A pick must never throw on an older or partial file: a missing branch is "no value".
    const picked = ok.map((s) => {
      try {
        return spec.pick(s);
      } catch {
        return null;
      }
    });
    const finished = picked.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    const failures = timed.filter((s) => !s.ok);
    const didNotFinish = failures.filter((s) => DID_NOT_FINISH.has(s.error ?? '')).length;
    // On a time row, "never finished" is the slowest outcome and is ranked as
    // such. On any other row (a count, a byte total) it is simply missing.
    const timeRow = spec.censored === 'right';
    const pending = ok.filter(
      (sample, i) => typeof picked[i] !== 'number' && (spec.unfinishedWhen?.(sample) ?? false),
    ).length;
    const unfinished = timeRow ? didNotFinish + pending : 0;
    const giveUp = run.meta?.usefulTimeoutMs ?? 30_000;
    return {
      spec,
      summary: timeRow ? summarizeWithUnfinished(finished, unfinished) : summarize(finished),
      attempted: timed.length,
      failed: failures.length,
      noValue: ok.length - finished.length,
      unfinished,
      otherFailures: failures.length - (timeRow ? didNotFinish : 0),
      values: [...finished, ...new Array<number>(unfinished).fill(giveUp)],
      detectors: [...new Set(ok.map((s) => detectorName(s.feedbackBy)).filter((d) => d !== ''))]
        .sort()
        .join(' + '),
    };
  });
}

const NOT_MEASURED = 'not measured';

export function formatValue(value: number | null | undefined, unit: Unit): string {
  if (value === Number.POSITIVE_INFINITY) return 'did not finish';
  if (typeof value !== 'number' || !Number.isFinite(value)) return NOT_MEASURED;
  if (unit === 'score') return value.toFixed(3);
  if (unit === 'count') return String(Math.round(value));
  return `${Math.round(value)} ${unit}`;
}

function formatBudget(budget: Budget | undefined, unit: Unit): string {
  if (!budget) return 'none yet';
  const side = (v: number | undefined) => (v === undefined ? 'none' : formatValue(v, unit));
  return `${side(budget.p75)} / ${side(budget.p95)}`;
}

/** Below this many samples a budget verdict would be a guess. */
const MIN_SAMPLES_TO_JUDGE = 8;

/**
 * When a row's failures stop it from being judged at all. On a time row the
 * "did not finish" samples are already ranked last, so only OTHER failures (a
 * missing link, a harness error) void it. On any other row a few missing samples
 * are tolerated and said out loud; more than that, and the row is not judged.
 */
function voidedBy(row: RowResult): string | null {
  if (row.otherFailures === 0) return null;
  const share = row.attempted === 0 ? 1 : row.otherFailures / row.attempted;
  if (row.spec.censored !== 'right' && share <= TOLERATED_FAILURE_SHARE) return null;
  return `${row.otherFailures} of ${row.attempted} iterations failed`;
}

export function verdict(row: RowResult): string {
  const { summary, spec } = row;
  if (!summary) return NOT_MEASURED;
  // A timeout is the slowest possible result. On time rows it is ranked last
  // (so it can push a percentile to "did not finish"); it is never dropped.
  const voided = voidedBy(row);
  if (voided) return `not judged: ${voided}`;
  if (!spec.budget) return 'no budget set';
  if (summary.n < MIN_SAMPLES_TO_JUDGE) return `too few samples to judge (n=${summary.n})`;
  const over =
    (spec.budget.p75 !== undefined && summary.p75 > spec.budget.p75) ||
    (spec.budget.p95 !== undefined && summary.p95 > spec.budget.p95);
  if (over) return 'OVER budget';
  // Nearest-rank p95 of a small sample is the second-slowest value or so: it
  // UNDERSTATES the true tail. "Within" is then a statement about this sample.
  return spec.budget.p95 !== undefined && summary.n < 60
    ? `within budget in this sample (n=${summary.n} cannot confirm a p95 budget)`
    : 'within budget';
}

const KIND_LABEL: Record<RunMeta['kind'], string> = {
  lab: 'LAB (a machine we control)',
  'preview-synthetic':
    'PREVIEW SYNTHETIC (scripted browser against a preview deployment; not production, not field data)',
  'production-synthetic':
    'PRODUCTION SYNTHETIC (scripted browser against the live site; not field/RUM data)',
  'unknown-target': 'UNKNOWN TARGET (the site did not identify its environment)',
};

function metaBlock(meta: RunMeta): string {
  const build =
    meta.buildAtStart === meta.buildAtEnd
      ? `build ${meta.buildAtStart ?? 'unknown'}`
      : `**BUILD CHANGED DURING THE RUN** (${meta.buildAtStart ?? 'unknown'} → ${meta.buildAtEnd ?? 'unknown'}): these numbers mix two builds`;
  return [
    `- Result type: **${KIND_LABEL[meta.kind]}**`,
    `- Target: ${meta.host}, ${build}${meta.builtAt ? `, built ${meta.builtAt}` : ''}`,
    `- Server state at the start: ${meta.serverState}`,
    `- When: ${meta.startedAt} to ${meta.finishedAt}`,
    `- Browser: ${meta.browser} ${meta.browserVersion}, viewport ${meta.viewport ?? 'default'}, DPR ${meta.devicePixelRatio}`,
    `- Network: ${meta.network}; measured round trip to the site ${meta.rttMs === null ? NOT_MEASURED : `${Math.round(meta.rttMs)} ms`}; machine: ${meta.machine}`,
    `- Signed in as: ${meta.role ?? 'role not verified'} (label "${meta.roleLabel}"); dataset: ${meta.dataset}`,
    `- Samples per scenario: ${meta.iterations} (${meta.coldIterations} for empty-browser-cache scenarios), plus one warm-up each, reported separately`,
    `- Method: harness ${meta.harnessVersion}; pointer rests ${meta.hoverMs} ms on a link before the click; start page settles ${meta.settleMs} ms; gives up on content after ${meta.usefulTimeoutMs} ms and on photos after ${meta.imageWaitMs} ms`,
    ...(meta.unsupportedMetrics.length > 0
      ? [
          `- This browser cannot report: ${meta.unsupportedMetrics.join(', ')} (those cells say "${NOT_MEASURED}", which is not 0)`,
        ]
      : []),
  ].join('\n');
}

function rowLine(row: RowResult): string {
  const { spec, summary } = row;
  const cell = (v: number | undefined) => formatValue(v, spec.unit);
  return `| ${spec.title} | ${summary?.n ?? 0} / ${row.attempted} | ${row.failed} | ${row.noValue} | ${cell(summary?.p50)} | ${cell(summary?.p75)} | ${cell(summary?.p95)} | ${cell(summary?.min)} | ${cell(summary?.max)} | ${formatBudget(spec.budget, spec.unit)} | ${verdict(row)} |`;
}

const TABLE_HEAD = [
  '| Scenario | n / attempted | failed | no value | p50 | p75 | p95 | min | max | Budget (p75 / p95) | Result |',
  '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |',
];

/** How often the photos were already in hand when the list painted: then the photo row IS the navigation row. */
function floorNote(run: RunFile, scenario: string): string | null {
  const timed = run.samples.filter(
    (s) => s.scenario === scenario && !s.warmup && s.ok && s.photos && s.photos.visibleCount > 0,
  );
  if (timed.length === 0) return null;
  const fully = timed.filter(
    (s) => (s.photos as PhotoSample).flooredCount === (s.photos as PhotoSample).visibleCount,
  ).length;
  return `In ${fully} of ${timed.length} "${scenario}" samples every visible photo had its bytes before the content painted, so the photo time equals the content time. Count a change there ONCE, not three times; the "bytes in hand" row is the unfloored figure.`;
}

// ---------------------------------------------------------------------------
// Signed-URL stability

const timedImages = (run: RunFile): ImageRecord[] =>
  run.samples.filter((s) => !s.warmup && s.ok).flatMap((s) => s.photos?.images ?? []);

function tokensByObject(run: RunFile): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const image of timedImages(run)) {
    if (!image.objectFingerprint || !image.tokenFingerprint) continue;
    const set = map.get(image.objectFingerprint) ?? new Set<string>();
    set.add(image.tokenFingerprint);
    map.set(image.objectFingerprint, set);
  }
  return map;
}

/** Did the signed URL of any photo change DURING the run? */
export function rotationWithinRun(run: RunFile): { objects: number; rotated: number } {
  const map = tokensByObject(run);
  let rotated = 0;
  for (const tokens of map.values()) if (tokens.size > 1) rotated += 1;
  return { objects: map.size, rotated };
}

/** Did the signed URL of the same photo change BETWEEN two runs (a deploy, four hours)? Same machine only: the hashes are keyed. */
export function rotationBetweenRuns(
  before: RunFile,
  after: RunFile,
): { shared: number; sameToken: number; rotated: number } {
  const b = tokensByObject(before);
  const a = tokensByObject(after);
  let shared = 0;
  let sameToken = 0;
  for (const [object, tokens] of a) {
    const earlier = b.get(object);
    if (!earlier) continue;
    shared += 1;
    if ([...tokens].some((t) => earlier.has(t))) sameToken += 1;
  }
  return { shared, sameToken, rotated: shared - sameToken };
}

// ---------------------------------------------------------------------------
// Photo delivery audit: what each surface asks for, against what it needs

function median(values: number[]): number | null {
  return summarize(values)?.p50 ?? null;
}

function tally(values: Array<string | null | undefined>): string {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v ?? '(none)', (counts.get(v ?? '(none)') ?? 0) + 1);
  return [...counts.entries()]
    .sort((x, y) => y[1] - x[1])
    .slice(0, 3)
    .map(([k, n]) => `${k} ×${n}`)
    .join(', ');
}

function imageAudit(run: RunFile): string[] {
  const groups = new Map<string, ImageRecord[]>();
  for (const sample of run.samples) {
    if (sample.warmup || !sample.ok || !sample.photos) continue;
    for (const image of sample.photos.images) {
      if (image.klass.delivery === 'inline') continue;
      const source =
        image.klass.delivery === 'optimizer'
          ? `optimizer ← ${image.klass.upstream ?? 'unknown'}`
          : image.klass.delivery;
      const key = `${sample.scenario} | ${source} | ${image.klass.variant}`;
      groups.set(key, [...(groups.get(key) ?? []), image]);
    }
  }
  if (groups.size === 0) return [];
  const lines = [
    '## Photo delivery audit',
    '',
    'What each surface fetched, against what it needs to look sharp (rendered CSS px × DPR). Counts are photo observations across all timed samples.',
    '',
    '| Scenario | Delivered by | Variant | Photos seen | Rendered (CSS px) | Needs (px) | Got (px) | Too small for the screen | From browser cache | Bytes when fetched | Optimizer width | Cache-Control | Blur placeholder | Broken |',
    '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | ---: | ---: |',
  ];
  for (const [key, images] of [...groups.entries()].sort()) {
    const [scenario, source, variant] = key.split(' | ');
    const loaded = images.filter((i) => !i.failed && i.naturalWidth > 0);
    const needs = loaded.map(
      (i) => Math.max(i.renderedWidth, i.renderedHeight) * i.devicePixelRatio,
    );
    const got = loaded.map((i) => Math.max(i.naturalWidth, i.naturalHeight));
    const tooSmall = loaded.filter(
      (i) =>
        Math.max(i.naturalWidth, i.naturalHeight) <
        Math.max(i.renderedWidth, i.renderedHeight) * i.devicePixelRatio,
    ).length;
    const known = images.filter((i) => i.network && i.network.servedFromBrowserCache !== null);
    const cached = known.filter((i) => i.network?.servedFromBrowserCache).length;
    const fetchedBytes = images.map((i) => i.network?.wireBytes ?? 0).filter((b) => b > 0);
    const px = (v: number | null) => (v === null ? NOT_MEASURED : String(Math.round(v)));
    lines.push(
      `| ${scenario} | ${source} | ${variant} | ${images.length} | ${px(median(loaded.map((i) => Math.max(i.renderedWidth, i.renderedHeight))))} | ${px(median(needs))} | ${px(median(got))} | ${tooSmall} | ${known.length === 0 ? NOT_MEASURED : `${cached} of ${known.length}`} | ${fetchedBytes.length === 0 ? 'none fetched' : formatValue(kb(median(fetchedBytes)), 'KB')} | ${tally(images.map((i) => (i.klass.requestedWidth === null ? null : `w=${i.klass.requestedWidth}`)))} | ${tally(images.map((i) => i.network?.cacheControl))} | ${images.filter((i) => i.hasBlurPlaceholder).length} | ${images.filter((i) => i.failed).length} |`,
    );
  }
  return [...lines, ''];
}

// ---------------------------------------------------------------------------
// Single-run report

function warmupBlock(run: RunFile): string[] {
  const first = run.samples.filter((s) => s.warmup);
  if (first.length === 0) return [];
  // Only the first scenario to touch a route meets it cold. Later warm-ups hit
  // routes this same run already warmed, and must not be read as cold starts.
  const seen = new Set<string>();
  const rowsOut = first.map((s) => {
    const scenario = run.scenarios.find((x) => x.id === s.scenario);
    const routes = scenario?.routes ?? [];
    const fresh = routes.length > 0 && routes.some((r) => !seen.has(r));
    routes.forEach((r) => seen.add(r));
    const state =
      routes.length === 0
        ? 'unknown'
        : fresh
          ? `first request to a route in this run (server: ${run.meta.serverState})`
          : 'routes already warmed earlier in this run';
    return `| ${scenario?.title ?? s.scenario} | ${state} | ${s.ok ? formatValue(s.usefulPaintMs, 'ms') : `failed (${s.error ?? 'unknown'})`} | ${formatValue(s.rscFirstByteMs, 'ms')} | ${formatValue(s.ttfbMs, 'ms')} |`;
  });
  return [
    '## First request of each scenario',
    '',
    "One sample per scenario, taken before the timed ones. n=1: single observations, not percentiles, and never mixed into the tables above. The owner's post-deploy / cold-start budget (useful content p95 2000 ms) can only be judged from runs started with PERF_SERVER_STATE=post-deploy or post-idle, pooled over several runs.",
    '',
    '| Scenario | What this sample met | Useful content | Page-data first byte | Document first byte |',
    '| --- | --- | ---: | ---: | ---: |',
    ...rowsOut,
    '',
  ];
}

export function buildRunReport(run: RunFile): {
  markdown: string;
  chartSvg: string;
  rows: RowResult[];
} {
  const rows = summarizeRun(run);
  const rotation = rotationWithinRun(run);
  const failures = run.samples.filter((s) => !s.ok && !s.warmup);
  const notes = ['dashboard-to-inventory', 'hard-load-inventory', 'orders-to-storefront']
    .map((id) => floorNote(run, id))
    .filter((n): n is string => n !== null);
  const lines = [
    `# Performance run: ${run.meta.label}`,
    '',
    metaBlock(run.meta),
    '',
    "## Owner's table",
    '',
    ...TABLE_HEAD,
    ...rows.filter((r) => r.spec.group === 'owner').map(rowLine),
    '',
    '## Everything measured',
    '',
    ...TABLE_HEAD,
    ...rows.filter((r) => r.spec.group !== 'owner').map(rowLine),
    '',
    '- "n / attempted": samples with a value, out of timed iterations run. "failed": iterations that produced nothing (a timeout is the slowest possible result, so a row with failures is not judged). "no value": iterations that finished without this one metric.',
    '- Percentiles are nearest-rank: every cell is a value that was actually observed. Below n=20, p95 is simply the slowest sample.',
    ...rows
      .filter((r) => r.spec.group === 'click' && r.detectors !== '' && r.spec.id !== 'hover-lead')
      .map((r) => `- "${r.spec.title}" was detected by: ${r.detectors}.`),
    '- Times to "visible" are stamped two animation frames after the DOM changed: one frame late at worst, never early. A long main-thread task between those frames is included (see the long-task figures in results.json).',
    ...notes.map((n) => `- ${n}`),
    '',
    ...warmupBlock(run),
    ...imageAudit(run),
    '## Signed photo URLs',
    '',
    rotation.objects === 0
      ? 'No signed photo was observed in this run.'
      : `${rotation.objects} distinct signed photos observed; the signed URL of ${rotation.rotated} of them CHANGED during the run. A changed URL is a browser-cache and optimizer-cache miss for an unchanged photo.`,
    '',
    ...(failures.length > 0
      ? [
          '## Failed iterations',
          '',
          ...[...new Set(failures.map((s) => `${s.scenario}: ${s.error ?? 'unknown'}`))].map(
            (f) =>
              `- ${f} ×${failures.filter((s) => `${s.scenario}: ${s.error ?? 'unknown'}` === f).length}`,
          ),
          '',
        ]
      : []),
  ];
  return {
    markdown: lines.join('\n'),
    chartSvg: chart(
      `${run.meta.label}: ${KIND_LABEL[run.meta.kind].split(' (')[0]}, ${run.meta.host}, build ${run.meta.buildAtStart ?? 'unknown'}`,
      rows
        .filter((r) => r.spec.unit === 'ms')
        .map((r) => ({
          title: r.spec.title,
          group: r.spec.group,
          budget: r.spec.budget ?? null,
          series: [{ name: run.meta.label, summary: r.summary }],
          warnings: [chartWarning(r)],
        })),
    ),
    rows,
  };
}

// ---------------------------------------------------------------------------
// Before / after

export interface ComparisonRow {
  spec: RowSpec;
  before: RowResult;
  after: RowResult;
  deltaP75: number | null;
  deltaP95: number | null;
  /** 95% interval of the p75 change, from a seeded bootstrap. A derived statistic, not an observation. */
  noise: { low: number; high: number; distinguishable: boolean; shareAbove: number } | null;
  result: string;
  /** How far this row moved between two runs of the SAME build (absolute %), when an A/A pair was supplied. */
  drift: { p75: number | null; p95: number | null } | null;
}

/** The owner's regression trigger is ">10% worse"; the same bar is used for "improved". */
const MATERIAL_PERCENT = 10;

/** A "candidate" needs this share of resampled differences on the worse side. 0.5 would be a coin toss. */
const CANDIDATE_SHARE = 0.8;

type Movement =
  | 'flat'
  | 'better'
  | 'worse'
  | 'better-in-noise'
  | 'worse-candidate'
  | 'worse-in-noise'
  | 'unproven';

function judge(
  spec: RowSpec,
  before: RowResult,
  after: RowResult,
): Pick<ComparisonRow, 'deltaP75' | 'deltaP95' | 'noise' | 'result'> {
  const b = before.summary;
  const a = after.summary;
  const none = { deltaP75: null, deltaP95: null, noise: null };
  if (!b || !a) return { ...none, result: NOT_MEASURED };
  const deltaP75 = deltaPercent(b.p75, a.p75);
  const deltaP95 = deltaPercent(b.p95, a.p95);
  const noise = bootstrapPercentileDelta(before.values, after.values, 75);
  const base = { deltaP75, deltaP95, noise };
  const resolution = RESOLUTION[spec.unit];
  if (spec.group === 'click' && before.detectors !== after.detectors) {
    // The same row measured two different things: the progress bar in one run,
    // the URL change in the other.
    return {
      ...base,
      result: `not comparable: click feedback was detected by ${before.detectors || 'nothing'} before and ${after.detectors || 'nothing'} after`,
    };
  }
  const voidedBefore = voidedBy(before);
  const voidedAfter = voidedBy(after);
  if (voidedBefore || voidedAfter) {
    return {
      ...base,
      result: `not comparable: ${voidedBefore ?? 'no failures'} before, ${voidedAfter ?? 'no failures'} after`,
    };
  }

  // A change counts when it clears the instrument's resolution AND 10%. From a
  // zero baseline a percentage does not exist, so resolution alone decides.
  const moved = (from: number, to: number, direction: 1 | -1) => {
    const change = (to - from) * direction;
    if (change < resolution) return false;
    return from === 0 ? true : (change / from) * 100 >= MATERIAL_PERCENT;
  };
  // p75 and p95 are judged SEPARATELY, each against its own bootstrap, so a
  // proven p75 improvement is never relabelled by an unproven wobble in the tail.
  const movement = (p: 75 | 95, from: number, to: number): Movement => {
    const worse = moved(from, to, 1);
    const better = moved(from, to, -1);
    if (!worse && !better) return 'flat';
    const check = p === 75 ? noise : bootstrapPercentileDelta(before.values, after.values, 95);
    if (check === null) return 'unproven';
    if (check.distinguishable) return worse ? 'worse' : 'better';
    if (worse) return check.shareAbove >= CANDIDATE_SHARE ? 'worse-candidate' : 'worse-in-noise';
    return 'better-in-noise';
  };
  const m75 = movement(75, b.p75, a.p75);
  const m95 = movement(95, b.p95, a.p95);
  const pct = (d: number | null) => (d === null ? '' : ` ${d > 0 ? '+' : ''}${Math.round(d)}%`);

  let result: string;
  const dnf = (v: number) => v === Number.POSITIVE_INFINITY;
  if (dnf(a.p75) || dnf(a.p95) || dnf(b.p75) || dnf(b.p95)) {
    // No percentage exists against "did not finish"; say which side it is on.
    const worseNow = (dnf(a.p75) && !dnf(b.p75)) || (dnf(a.p95) && !dnf(b.p95));
    const betterNow = (dnf(b.p75) && !dnf(a.p75)) || (dnf(b.p95) && !dnf(a.p95));
    result = worseNow
      ? `regressed: ${after.unfinished} of ${after.attempted} samples did not finish (${before.unfinished} of ${before.attempted} before)`
      : betterNow
        ? `improved: ${after.unfinished} of ${after.attempted} samples did not finish, down from ${before.unfinished} of ${before.attempted}`
        : `both runs have a percentile that did not finish (${before.unfinished} and ${after.unfinished} samples)`;
  } else if (m75 === 'worse') result = 'regressed';
  else if (m95 === 'worse')
    result = m75 === 'better' ? 'regressed (p95), although p75 improved' : 'regressed (p95)';
  else if (m75 === 'unproven' || m95 === 'unproven')
    result = `too few samples to judge (n=${b.n} / ${a.n})`;
  else if (m75 === 'better') {
    // A slower tail is never hidden behind a proven p75 improvement, even when
    // the sample is too small to call it.
    if (m95 === 'worse-candidate')
      result = `p75 improved; p95${pct(deltaP95)} is a regression candidate (inside the noise): re-measure the tail`;
    else if (m95 === 'worse-in-noise')
      result = `p75 improved; p95${pct(deltaP95)} is inside the noise, which n=${b.n} / ${a.n} cannot judge`;
    else result = 'improved';
  } else if (m75 === 'worse-candidate' || m95 === 'worse-candidate') {
    const which = m75 === 'worse-candidate' ? `p75${pct(deltaP75)}` : `p95${pct(deltaP95)}`;
    result = `regression candidate (${which}): likely but inside the noise at n=${b.n} / ${a.n}, re-measure with more samples`;
  } else if (m75 !== 'flat' || m95 !== 'flat') result = 'not distinguishable from noise';
  else {
    // "No change" is only as strong as the samples. If the interval is wider
    // than the 10% bar, a real change of that size could be hiding in it.
    // (Differences below the instrument's resolution are not a hidden change.)
    const widest = noise ? Math.max(Math.abs(noise.low), Math.abs(noise.high)) : 0;
    const reach = noise && b.p75 > 0 && widest >= resolution ? (widest / b.p75) * 100 : null;
    result =
      reach !== null && reach > MATERIAL_PERCENT
        ? `no change detected (cannot exclude ±${Math.round(reach)}%: more samples needed)`
        : 'no material change';
  }
  // A percentile can look fine while a navigation that used to finish now hangs
  // once in forty. That is never left out of the verdict.
  if (before.unfinished > 0 || after.unfinished > 0) {
    result += `; did not finish: ${before.unfinished} of ${before.attempted} before, ${after.unfinished} of ${after.attempted} after`;
  }
  return { ...base, result };
}

/**
 * `drift` is an A/A pair: two runs of one build. The bootstrap only knows the
 * scatter INSIDE a run; it cannot know that the same build measured half an hour
 * later answers 30% slower on one route because the server moved. The A/A pair
 * measures exactly that, per row, and a change no bigger than it is not a change.
 */
export function compareRuns(
  before: RunFile,
  after: RunFile,
  rows: RowSpec[] = ROWS,
  drift?: { a: RunFile; b: RunFile },
): ComparisonRow[] {
  const b = summarizeRun(before, rows);
  const a = summarizeRun(after, rows);
  const aa = drift ? compareRuns(drift.a, drift.b, rows) : null;
  return rows.map((spec, i) => {
    const bRow = b[i] as RowResult;
    const aRow = a[i] as RowResult;
    const judged = judge(spec, bRow, aRow);
    const moved = aa?.[i];
    const floor = moved
      ? {
          p75: moved.deltaP75 === null ? null : Math.abs(moved.deltaP75),
          p95: moved.deltaP95 === null ? null : Math.abs(moved.deltaP95),
        }
      : null;
    let result = judged.result;
    const claims =
      /^(improved|regressed|p75 improved)/.test(result) && !/did not finish \(/.test(result);
    if (floor && claims) {
      const onTail = result.startsWith('regressed (p95)');
      const delta = onTail ? judged.deltaP95 : judged.deltaP75;
      const limit = onTail ? floor.p95 : floor.p75;
      if (delta !== null && limit !== null && Math.abs(delta) <= limit) {
        result = `inside run-to-run drift: with NO change, this row's ${onTail ? 'p95' : 'p75'} moved ${limit.toFixed(1)}% between two runs of one build (was: ${judged.result})`;
      }
    }
    return { spec, before: bRow, after: aRow, ...judged, result, drift: floor };
  });
}

const HARD_KEYS: Array<keyof RunMeta> = [
  'schemaVersion',
  'harnessVersion',
  'kind',
  'host',
  'browser',
  'viewport',
  'devicePixelRatio',
  'network',
  'role',
  'roleLabel',
  'dataset',
  'serverState',
  'hoverMs',
  'settleMs',
  'usefulTimeoutMs',
  'imageWaitMs',
];
const SOFT_KEYS: Array<keyof RunMeta> = [
  'browserVersion',
  'machine',
  'iterations',
  'coldIterations',
];

/**
 * `hard`: differences that make the comparison unfair (it is then not labelled
 * a comparison of equals). `soft`: differences worth knowing about.
 */
export function environmentMismatches(
  before: RunMeta,
  after: RunMeta,
): { hard: string[]; soft: string[] } {
  const describe = (k: keyof RunMeta) =>
    `${k}: before "${String(before[k])}", after "${String(after[k])}"`;
  const hard = HARD_KEYS.filter((k) => before[k] !== after[k]).map(describe);
  const soft = SOFT_KEYS.filter((k) => before[k] !== after[k]).map(describe);
  // The network label is typed by a person; the round trip is measured.
  if (before.rttMs !== null && after.rttMs !== null) {
    const slower = Math.max(before.rttMs, after.rttMs);
    const faster = Math.min(before.rttMs, after.rttMs);
    if (slower - faster > 10 && slower > faster * 1.15)
      hard.push(
        `measured round trip: before ${Math.round(before.rttMs)} ms, after ${Math.round(after.rttMs)} ms`,
      );
  } else {
    soft.push('round trip was not measured on both sides');
  }
  for (const [name, meta] of [
    ['before', before],
    ['after', after],
  ] as const) {
    if (meta.buildAtStart !== meta.buildAtEnd) hard.push(`the ${name} run spans two builds`);
    if (meta.serverState === 'not controlled')
      soft.push(`server state was not controlled on the ${name} run`);
    // Two unverified roles are equal to each other and prove nothing.
    if (meta.role === null) hard.push(`the ${name} run's account role was not verified`);
  }
  return { hard, soft };
}

export function buildComparisonReport(
  before: RunFile,
  after: RunFile,
  drift?: { a: RunFile; b: RunFile },
): { markdown: string; chartSvg: string; rows: ComparisonRow[] } {
  const rows = compareRuns(before, after, ROWS, drift);
  const { hard, soft } = environmentMismatches(before.meta, after.meta);
  for (const id of ['dataset-rows', 'dataset-photos']) {
    const fact = rows.find((r) => r.spec.id === id);
    const b = fact?.before.summary?.p50;
    const a = fact?.after.summary?.p50;
    if (fact && b !== undefined && a !== undefined && b !== a)
      hard.push(`${fact.spec.title}: before ${b}, after ${a}`);
  }
  const rotation = rotationBetweenRuns(before, after);
  const sameBuild =
    before.meta.buildAtStart !== null && before.meta.buildAtStart === after.meta.buildAtStart;
  const line = ({
    spec,
    before: b,
    after: a,
    deltaP75,
    deltaP95,
    noise,
    result,
    drift: floor,
  }: ComparisonRow) => {
    const cell = (v: number | undefined) => formatValue(v, spec.unit);
    const pct = (d: number | null, from: number | undefined, to: number | undefined) =>
      d !== null
        ? `${d > 0 ? '+' : ''}${d.toFixed(1)}%`
        : from === 0 && typeof to === 'number'
          ? `${to > 0 ? '+' : ''}${formatValue(to, spec.unit)} from 0`
          : NOT_MEASURED;
    const n = (r: RowResult) =>
      `${r.summary?.n ?? 0}${r.failed > 0 ? ` (${r.failed} failed)` : ''}`;
    const driftCell = (f: ComparisonRow['drift']) =>
      f === null
        ? 'no A/A pair given'
        : `${f.p75 === null ? 'n/a' : `±${f.p75.toFixed(1)}%`} / ${f.p95 === null ? 'n/a' : `±${f.p95.toFixed(1)}%`}`;
    const interval = noise
      ? `${formatValue(noise.low, spec.unit)} to ${formatValue(noise.high, spec.unit)}`
      : 'n too small';
    return `| ${spec.title} | ${n(b)} | ${cell(b.summary?.p50)} | ${cell(b.summary?.p75)} | ${cell(b.summary?.p95)} | ${n(a)} | ${cell(a.summary?.p50)} | ${cell(a.summary?.p75)} | ${cell(a.summary?.p95)} | ${pct(deltaP75, b.summary?.p75, a.summary?.p75)} | ${pct(deltaP95, b.summary?.p95, a.summary?.p95)} | ${interval} | ${driftCell(floor)} | ${result} |`;
  };
  const lines = [
    `# Before / after: ${before.meta.label} → ${after.meta.label}`,
    '',
    hard.length === 0
      ? 'Same environment on both sides (target, browser, viewport, DPR, network and measured round trip, account, dataset, server state, harness version and method).'
      : `**NOT A FAIR COMPARISON.** The two runs differ in: ${hard.join('; ')}.`,
    ...(soft.length > 0
      ? ['', `Also different (does not by itself void the comparison): ${soft.join('; ')}.`]
      : []),
    ...(sameBuild
      ? [
          '',
          `Both runs measured the SAME build (${before.meta.buildAtStart}). This is an A/A comparison: every label below other than "no material change" is this harness's own noise, and that row needs more samples before it can judge a change.`,
        ]
      : []),
    '',
    '## Before',
    metaBlock(before.meta),
    '',
    '## After',
    metaBlock(after.meta),
    '',
    '| Scenario | Before n | Before p50 | Before p75 | Before p95 | After n | After p50 | After p75 | After p95 | Delta p75 | Delta p95 | 95% interval of the p75 change | Same-build drift (p75 / p95) | Result |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- |',
    ...rows.map(line),
    '',
    `- "improved" / "regressed" need a change of at least ${MATERIAL_PERCENT}% that is also larger than the instrument's resolution (one frame for times) AND larger than the two runs' own scatter. A p95 that gets ${MATERIAL_PERCENT}% worse is a regression even if p75 improved.`,
    drift
      ? `- "Same-build drift" is how far each row moved between two runs of ONE build (${drift.a.meta.label} → ${drift.b.meta.label}). A change no larger than that is reported as drift, whatever the bootstrap says: the bootstrap only knows the scatter inside a run, not that the same server answers differently half an hour later.`
      : '- No A/A pair was supplied (PERF_DRIFT_A / PERF_DRIFT_B), so run-to-run drift is NOT accounted for below. On 2026-09-20 two runs of one build, 30 minutes apart, moved several rows by 15 to 30%. Treat any verdict here as provisional until it is checked against an A/A pair.',
    '- The interval is a DERIVED statistic (seeded bootstrap, 2000 resamples of the raw samples in both files). Every other cell is a raw observation. An interval that contains 0 means the runs cannot be told apart at this sample size.',
    '- An apparent improvement inside the noise is not claimed. An apparent regression inside the noise is still raised as a "regression candidate" to re-measure, because a slow tail is what twenty samples can neither prove nor dismiss.',
    '- A row where any iteration failed is "not comparable": a timeout is the slowest result there is, and dropping it would flatter the run that broke.',
    '',
    '## Signed photo URLs between the two runs',
    '',
    rotation.shared === 0
      ? 'No signed photo was seen in both runs (or the runs were taken on different machines: the fingerprints are keyed per machine).'
      : `${rotation.shared} signed photos were seen in both runs: ${rotation.sameToken} kept the same signed URL, ${rotation.rotated} ROTATED. A rotated URL is a cold browser and optimizer cache for an unchanged photo.`,
    '',
  ];
  return {
    markdown: lines.join('\n'),
    chartSvg: chart(
      `${before.meta.label} → ${after.meta.label}, ${after.meta.host}${hard.length > 0 ? '  (NOT A FAIR COMPARISON: see the report)' : ''}`,
      rows
        .filter((r) => r.spec.unit === 'ms')
        .map((r) => ({
          title: r.spec.title,
          group: r.spec.group,
          budget: r.spec.budget ?? null,
          series: [
            {
              name: `${before.meta.label} (${before.meta.buildAtStart ?? '?'})`,
              summary: r.before.summary,
            },
            {
              name: `${after.meta.label} (${after.meta.buildAtStart ?? '?'})`,
              summary: r.after.summary,
            },
          ],
        })),
    ),
    rows,
  };
}

// ---------------------------------------------------------------------------
// Chart

/** Why a row is not judged, or what its bar is hiding, in a few words for the chart. */
function chartWarning(row: RowResult): string {
  const voided = voidedBy(row);
  if (voided) return `${voided}: not judged`;
  return row.unfinished > 0 ? `${row.unfinished} of ${row.attempted} did not finish` : '';
}

interface ChartRow {
  title: string;
  /** Why the table refuses to judge this row, per series. Empty = judged normally. */
  warnings?: string[];
  group: Group;
  budget: Budget | null;
  series: Array<{ name: string; summary: Summary | null }>;
}

const esc = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const PANEL_TITLE: Record<Group, string> = {
  owner: "Owner's table",
  click: 'Click → visible response',
  navigation: 'Navigation',
  photos: 'Photos',
  'hard-load': 'Hard loads (warm browser cache)',
  'first-visit': 'Empty browser cache',
  network: 'Network',
  health: 'Health',
};

/**
 * Horizontal bars in PANELS, each with its own scale: a 13 ms click and a 2 s
 * cold load on one axis would turn the click into an invisible sliver. One bar
 * per series, drawn to p75, a whisker from p50 to p95 and a dashed tick at the
 * p75 budget. A series with no measurement draws NO bar and says so: a missing
 * bar must never look like a fast one.
 */
function chart(title: string, rows: ChartRow[]): string {
  const left = 400;
  const width = 1240;
  const plot = width - left - 250;
  const barH = 14;
  const gap = 6;
  const rowPad = 16;
  const colors = ['#64748b', '#0f766e'];
  const parts: string[] = [];
  let y = 64;
  const groups = [...new Set(rows.map((r) => r.group))];
  for (const group of groups) {
    const panel = rows.filter((r) => r.group === group);
    const max = Math.max(
      1,
      ...panel.flatMap((r) => [
        ...r.series.map((s) => (s.summary && Number.isFinite(s.summary.p95) ? s.summary.p95 : 0)),
        r.budget?.p75 ?? 0,
      ]),
    );
    const x = (v: number) => left + (Math.min(v, max) / max) * plot;
    parts.push(
      `<text x="16" y="${y}" font-size="13" font-weight="600" fill="#0f172a">${esc(PANEL_TITLE[group])}</text>`,
    );
    parts.push(
      `<text x="${left + plot}" y="${y}" text-anchor="end" font-size="11" fill="#64748b">scale: 0 to ${Math.round(max)} ms</text>`,
    );
    y += 14;
    for (const row of panel) {
      const rowH = row.series.length * (barH + gap);
      parts.push(
        `<text x="${left - 12}" y="${y + rowH / 2}" text-anchor="end" dominant-baseline="middle" font-size="12" fill="#0f172a">${esc(row.title)}</text>`,
      );
      row.series.forEach((series, i) => {
        const top = y + i * (barH + gap);
        const s = series.summary;
        if (!s) {
          parts.push(
            `<text x="${left + 4}" y="${top + barH / 2}" dominant-baseline="middle" font-size="11" fill="#94a3b8">${esc(series.name)}: not measured</text>`,
          );
          return;
        }
        const warning = row.warnings?.[i] ?? '';
        if (!Number.isFinite(s.p75)) {
          // p75 itself did not finish: there is no length to draw.
          parts.push(
            `<text x="${left + 4}" y="${top + barH / 2}" dominant-baseline="middle" font-size="11" fill="#b45309">${esc(series.name)}: p75 did not finish (${esc(warning || `n=${s.n}`)})</text>`,
          );
          return;
        }
        // A row with failed or never-finished samples is drawn HOLLOW, in a
        // warning colour: its survivors are the fast ones, and a solid bar
        // would make a broken run look quick.
        parts.push(
          warning.endsWith('not judged')
            ? `<rect x="${left}" y="${top}" width="${Math.max(1, x(s.p75) - left).toFixed(1)}" height="${barH}" rx="2" fill="none" stroke="#b45309" stroke-width="1.5" stroke-dasharray="4 2"/>`
            : `<rect x="${left}" y="${top}" width="${Math.max(1, x(s.p75) - left).toFixed(1)}" height="${barH}" rx="2" fill="${colors[i % colors.length]}"/>`,
        );
        parts.push(
          `<line x1="${x(s.p50).toFixed(1)}" x2="${x(s.p95).toFixed(1)}" y1="${top + barH / 2}" y2="${top + barH / 2}" stroke="#0f172a" stroke-width="1.5"/>`,
        );
        parts.push(
          `<line x1="${x(s.p95).toFixed(1)}" x2="${x(s.p95).toFixed(1)}" y1="${top + 2}" y2="${top + barH - 2}" stroke="#0f172a" stroke-width="1.5"/>`,
        );
        parts.push(
          `<text x="${left + plot + 8}" y="${top + barH / 2}" dominant-baseline="middle" font-size="11" fill="#334155">p75 ${Math.round(s.p75)} ms, p95 ${Number.isFinite(s.p95) ? `${Math.round(s.p95)} ms` : 'did not finish'}, n=${s.n}${warning ? ` — ${esc(warning)}` : ''}</text>`,
        );
      });
      if (row.budget?.p75 !== undefined) {
        parts.push(
          `<line x1="${x(row.budget.p75).toFixed(1)}" x2="${x(row.budget.p75).toFixed(1)}" y1="${y - 3}" y2="${y + rowH - gap + 3}" stroke="#dc2626" stroke-width="1.5" stroke-dasharray="3 2"/>`,
        );
      }
      y += rowH + rowPad;
    }
    y += 14;
  }
  const legend = (rows[0]?.series ?? [])
    .map(
      (s, i) =>
        `<rect x="${16 + i * 360}" y="34" width="12" height="12" rx="2" fill="${colors[i % colors.length]}"/><text x="${34 + i * 360}" y="44" font-size="12" fill="#0f172a">${esc(s.name)} (bar = p75, line = p50 to p95)</text>`,
    )
    .join('');
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${y + 8}" viewBox="0 0 ${width} ${y + 8}" font-family="ui-sans-serif, system-ui, sans-serif">`,
    `<rect width="100%" height="100%" fill="#ffffff"/>`,
    `<text x="16" y="22" font-size="14" font-weight="600" fill="#0f172a">${esc(title)}</text>`,
    legend,
    `<text x="${width - 16}" y="44" text-anchor="end" font-size="11" fill="#dc2626">dashed red = p75 budget</text>`,
    ...parts,
    '</svg>',
  ].join('\n');
}
