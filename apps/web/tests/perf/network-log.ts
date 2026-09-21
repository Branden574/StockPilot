import { createHmac, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { CDPSession, Page, Request } from '@playwright/test';

import type { NetworkSample, PageFetch } from '../../src/lib/perf/report';
import { toRouteTemplate } from '../../src/lib/perf/route-template';
import { fingerprintKeyPath } from './paths';

/**
 * The network half of a sample: how many requests a navigation cost, of which
 * kind, and how each IMAGE was delivered (status, caching headers, whether the
 * browser served it from its own cache).
 *
 * Image URLs are signed credentials. This file sees them, because the browser's
 * network layer reports them, and it keeps NONE of them: each URL is reduced to
 * the same keyed-hash prefix the in-page collector computes, and only that prefix,
 * a handful of caching headers and byte counts are stored.
 */

export type RequestKind =
  'document' | 'rsc' | 'rsc-prefetch' | 'server-action' | 'image' | 'script' | 'other';

export interface ImageDelivery {
  status: number | null;
  /** Chromium only: the browser answered from its memory or disk cache. */
  servedFromBrowserCache: boolean | null;
  cacheControl: string | null;
  age: string | null;
  cfCacheStatus: string | null;
  vercelCache: string | null;
  contentType: string | null;
  contentLength: number | null;
  hasEtag: boolean;
  /** Bytes on the wire (headers + body), from the DevTools protocol. Chromium only; null elsewhere. */
  wireBytes: number | null;
  /** How the browser got it. Chromium only; null elsewhere. */
  cache: 'memory' | 'disk' | 'revalidated' | 'network' | null;
}

export type NetworkSummary = NetworkSample;

/**
 * 32 random bytes, created once per machine in the gitignored `.auth` folder.
 * It keys every URL fingerprint (here and in the page), so the prefixes in a
 * results file cannot be matched against a guessed URL by anyone without it.
 */
export function fingerprintKey(): string {
  const file = fingerprintKeyPath();
  if (existsSync(file)) {
    const saved = readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f]{64}$/.test(saved)) return saved;
  }
  const fresh = randomBytes(32).toString('hex');
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, fresh, { mode: 0o600 });
  chmodSync(file, 0o600);
  return fresh;
}

let cachedKey: Buffer | null = null;
const fingerprint = (url: string): string => {
  cachedKey ??= Buffer.from(fingerprintKey(), 'hex');
  return createHmac('sha256', cachedKey).update(url).digest('hex').slice(0, 16);
};

function kindOf(request: Request): RequestKind {
  const headers = request.headers();
  if (headers['next-action']) return 'server-action';
  if (headers['next-router-prefetch']) return 'rsc-prefetch';
  if (headers['rsc'] || new URL(request.url()).searchParams.has('_rsc')) return 'rsc';
  const type = request.resourceType();
  if (type === 'document') return 'document';
  if (type === 'image') return 'image';
  if (type === 'script') return 'script';
  return 'other';
}

type RequestEntry = {
  kind: RequestKind;
  fetch: PageFetch | null;
  failed: boolean;
};

async function recordPageFetch(
  request: Request,
  entry: RequestEntry,
  wire: number | null,
): Promise<void> {
  const timing = request.timing();
  const response = await request.response().catch(() => null);
  const vercelId = (await response?.headerValue('x-vercel-id').catch(() => null)) ?? null;
  const span = (end: number) =>
    timing.requestStart >= 0 && end >= 0 ? end - timing.requestStart : null;
  entry.fetch = {
    kind: entry.kind,
    route: toRouteTemplate(request.url()),
    status: response?.status() ?? null,
    ttfbMs: span(timing.responseStart),
    totalMs: span(timing.responseEnd),
    // Browser wall clock, the same clock as the page's performance.timeOrigin.
    requestSentAt:
      timing.startTime > 0 && timing.requestStart >= 0
        ? timing.startTime + timing.requestStart
        : null,
    firstByteAt:
      timing.startTime > 0 && timing.responseStart >= 0
        ? timing.startTime + timing.responseStart
        : null,
    wireBytes: wire,
    vercelCache: (await response?.headerValue('x-vercel-cache').catch(() => null)) ?? null,
    // `sfo1::iad1::<request id>`: keep the regions, drop the id.
    regions: vercelId ? vercelId.split('::').slice(0, -1).join('::') || null : null,
  };
  if ((response?.status() ?? 0) >= 400) entry.failed = true;
}

export class NetworkLog {
  private readonly requests: Array<{
    kind: RequestKind;
    startedAt: number;
    wireBytes: number | null;
    route: string | null;
    action: string | null;
    fetch: PageFetch | null;
    /** Image requests only: answered by the browser's own cache (Chromium). */
    cached: boolean | null;
    failed: boolean;
  }> = [];
  private readonly images = new Map<string, ImageDelivery>();
  private readonly imageStartedAt = new Map<string, number>();
  private cdp: CDPSession | null = null;

  static async attach(page: Page, browserName: string): Promise<NetworkLog> {
    const log = new NetworkLog();
    type Entry = (typeof log.requests)[number];
    const byRequest = new WeakMap<Request, Entry>();
    page.on('request', (request) => {
      const kind = kindOf(request);
      const entry: Entry = {
        kind,
        startedAt: Date.now(),
        wireBytes: null,
        route: kind === 'rsc' || kind === 'rsc-prefetch' ? toRouteTemplate(request.url()) : null,
        action:
          kind === 'server-action' ? (request.headers()['next-action'] ?? '').slice(0, 12) : null,
        fetch: null,
        cached: null,
        failed: false,
      };
      log.requests.push(entry);
      byRequest.set(request, entry);
      if (kind === 'image') log.imageStartedAt.set(fingerprint(request.url()), entry.startedAt);
    });
    page.on('requestfinished', (request) => {
      const entry = byRequest.get(request);
      if (!entry) return;
      void (async () => {
        // Node's receipt time stands in until the browser's own start time is known.
        const began = request.timing().startTime;
        if (began > 0) entry.startedAt = began;
        const sizes = await request.sizes().catch(() => null);
        const wire =
          sizes && browserName === 'chromium'
            ? sizes.responseHeadersSize + sizes.responseBodySize
            : null;
        entry.wireBytes = wire;
        if (entry.kind === 'rsc' || entry.kind === 'document') {
          await recordPageFetch(request, entry, wire);
          return;
        }
        if (entry.kind !== 'image') return;
        const response = await request.response();
        if (!response) return;
        const headers = await response.allHeaders();
        const length = Number(headers['content-length']);
        const fp = fingerprint(request.url());
        const known = log.images.get(fp);
        log.images.set(fp, {
          status: response.status(),
          servedFromBrowserCache: known?.servedFromBrowserCache ?? null,
          cache: known?.cache ?? null,
          cacheControl: headers['cache-control'] ?? null,
          age: headers['age'] ?? null,
          cfCacheStatus: headers['cf-cache-status'] ?? null,
          vercelCache: headers['x-vercel-cache'] ?? null,
          contentType: headers['content-type'] ?? null,
          contentLength: Number.isFinite(length) ? length : null,
          hasEtag: Boolean(headers['etag']),
          // Only the protocol's byte count is trusted: other engines report a
          // body size even for a cache hit.
          wireBytes: known?.wireBytes ?? null,
        });
      })().catch(() => {});
    });

    page.on('requestfailed', (request) => {
      const entry = byRequest.get(request);
      if (!entry || (entry.kind !== 'rsc' && entry.kind !== 'document')) return;
      // The router routinely CANCELS a page-data stream once it has what it
      // needs, and the browser reports that as a failed request. An abort after
      // the headers arrived is a normal navigation: keep its timing, do not
      // count it. Anything else (DNS, reset, timeout) is a real failure.
      const aborted = /ERR_ABORTED|cancel/i.test(request.failure()?.errorText ?? '');
      void recordPageFetch(request, entry, null)
        .then(() => {
          if (!aborted || entry.fetch?.status === null) entry.failed = true;
        })
        .catch(() => {
          entry.failed = true;
        });
    });

    if (browserName === 'chromium') {
      // Playwright has no "served from cache" flag; the DevTools protocol does.
      const cdp = await page.context().newCDPSession(page);
      log.cdp = cdp;
      await cdp.send('Network.enable');
      const byRequestId = new Map<string, string>();
      cdp.on('Network.requestWillBeSent', (e) => {
        if (e.type !== 'Image') return;
        const fp = fingerprint(e.request.url);
        byRequestId.set(e.requestId, fp);
        // A memory-cache hit can reach the DevTools protocol without ever
        // raising Playwright's own `request` event.
        if (!log.imageStartedAt.has(fp)) log.imageStartedAt.set(fp, Date.now());
      });
      // Four different answers to "did this photo cost the network anything?":
      //   memory / disk : served by the browser alone (a true cache hit)
      //   revalidated   : the browser HAD the bytes but had to ask (304). One
      //                   round trip per photo, which is what a missing or
      //                   short Cache-Control costs. Playwright reports these
      //                   as plain 200s; only the protocol shows the 304.
      //   network       : downloaded
      const mark = (requestId: string, update: Partial<ImageDelivery>) => {
        const fp = byRequestId.get(requestId);
        if (!fp) return;
        log.images.set(fp, { ...(log.images.get(fp) ?? EMPTY_DELIVERY), ...update });
      };
      cdp.on('Network.requestServedFromCache', (e) =>
        mark(e.requestId, { cache: 'memory', servedFromBrowserCache: true }),
      );
      cdp.on('Network.responseReceived', (e) => {
        if (e.response.fromDiskCache || e.response.fromPrefetchCache)
          mark(e.requestId, { cache: 'disk', servedFromBrowserCache: true });
      });
      cdp.on('Network.responseReceivedExtraInfo', (e) => {
        if (e.statusCode === 304)
          mark(e.requestId, { cache: 'revalidated', servedFromBrowserCache: false });
      });
      cdp.on('Network.loadingFinished', (e) => {
        const fp = byRequestId.get(e.requestId);
        if (!fp) return;
        const current = log.images.get(fp) ?? EMPTY_DELIVERY;
        log.images.set(fp, {
          ...current,
          wireBytes: e.encodedDataLength,
          cache: current.cache ?? 'network',
          servedFromBrowserCache: current.servedFromBrowserCache ?? false,
        });
      });
    }
    return log;
  }

  image(urlFingerprint: string): ImageDelivery | null {
    return this.images.get(urlFingerprint) ?? null;
  }

  /** Requests that started at or after `sinceEpochMs` (the click, converted to the wall clock). */
  summarize(sinceEpochMs: number, untilEpochMs = Number.POSITIVE_INFINITY): NetworkSummary {
    const kinds: RequestKind[] = [
      'document',
      'rsc',
      'rsc-prefetch',
      'server-action',
      'image',
      'script',
      'other',
    ];
    const counts = Object.fromEntries(kinds.map((k) => [k, 0])) as Record<RequestKind, number>;
    const bytes = Object.fromEntries(kinds.map((k) => [k, null])) as Record<
      RequestKind,
      number | null
    >;
    let wire = 0;
    let sawBytes = false;
    let total = 0;
    let failedPageFetches = 0;
    const rscRoutes: Record<string, number> = {};
    const prefetchRoutes: Record<string, number> = {};
    const serverActions = new Set<string>();
    const pageFetches: PageFetch[] = [];
    for (const r of this.requests) {
      if (r.startedAt < sinceEpochMs || r.startedAt > untilEpochMs) continue;
      counts[r.kind] += 1;
      total += 1;
      if (r.route) {
        const bucket = r.kind === 'rsc' ? rscRoutes : prefetchRoutes;
        bucket[r.route] = (bucket[r.route] ?? 0) + 1;
      }
      if (r.action) serverActions.add(r.action);
      if (r.fetch) pageFetches.push(r.fetch);
      if (r.failed) failedPageFetches += 1;
      if (r.wireBytes !== null) {
        wire += r.wireBytes;
        sawBytes = true;
        bytes[r.kind] = (bytes[r.kind] ?? 0) + r.wireBytes;
      }
    }

    // Every image the window fetched, not only the ones on screen: the list
    // loads photos for rows below the fold too, and those cost bytes as well.
    const deliveries = [...this.images.entries()]
      .filter(([fp]) => {
        const at = this.imageStartedAt.get(fp) ?? 0;
        return at >= sinceEpochMs && at <= untilEpochMs;
      })
      .map(([, delivery]) => delivery);
    const known = deliveries.filter((d) => d.servedFromBrowserCache !== null);
    const imageBytes = deliveries.map((d) => d.wireBytes).filter((b): b is number => b !== null);
    return {
      counts,
      bytes,
      total,
      wireBytes: sawBytes ? wire : null,
      rscRoutes,
      prefetchRoutes,
      serverActions: [...serverActions],
      pageFetches,
      failedPageFetches,
      images: {
        requests: counts.image,
        fromBrowserCache:
          known.length === 0 ? null : known.filter((d) => d.servedFromBrowserCache).length,
        notFromCache:
          known.length === 0 ? null : known.filter((d) => !d.servedFromBrowserCache).length,
        revalidated: deliveries.filter((d) => d.cache === 'revalidated').length,
        wireBytes: imageBytes.length === 0 ? null : imageBytes.reduce((sum, b) => sum + b, 0),
      },
    };
  }

  /**
   * The navigation's own page-data fetch: kind `rsc` (it carries the `rsc` header
   * and NOT `next-router-prefetch`) for the arrived route. Told apart by header,
   * because a prefetch of another tab of the same page shares its pathname.
   */
  navigationFetch(route: string, sinceEpochMs: number): PageFetch | null {
    return (
      this.requests.find(
        (r) => r.kind === 'rsc' && r.fetch?.route === route && r.startedAt >= sinceEpochMs,
      )?.fetch ?? null
    );
  }

  async detach(): Promise<void> {
    await this.cdp?.detach().catch(() => {});
  }
}

const EMPTY_DELIVERY: ImageDelivery = {
  status: null,
  servedFromBrowserCache: null,
  cacheControl: null,
  age: null,
  cfCacheStatus: null,
  vercelCache: null,
  contentType: null,
  contentLength: null,
  hasEtag: false,
  wireBytes: null,
  cache: null,
};
