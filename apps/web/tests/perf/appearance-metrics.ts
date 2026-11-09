import type { BrowserContext, CDPSession, Page } from '@playwright/test';

/**
 * What the Liquid Glass performance run measures in the browser (plan 8.4,
 * R12), and the pure arithmetic over it (unit tested in
 * src/test/stage5-perf-metrics.test.ts). appearance.perf.ts drives the
 * pages; appearance-compare.mjs judges the samples.
 *
 *  - TTFB, FCP, LCP, CLS, the app's "usable" mark (lib/perf/marks.ts
 *    PERF_MARK.useful), long animation frames and event timing are read from
 *    the page's own PerformanceObservers, installed before any page script
 *    (an init script), buffered so nothing before install is lost;
 *  - transfer bytes by type from the resource timing entries, and the bytes
 *    of glass rules inside the CSS a page loads (classicGlassCssBytes: what a
 *    Classic visitor downloads for Liquid Glass, plan 4.1 "reported, not
 *    hidden");
 *  - JS heap from CDP Performance.getMetrics; scene photos (/liquid-glass/)
 *    bytes and count; the live blur count: elements on screen whose computed
 *    backdrop-filter is not none (plan 4.3: replaces the never-written
 *    work/blur-count.md, measured per route at run time);
 *  - CPU throttling and the R12 low-end network through CDP.
 */

/** The PerformanceObserver collector, as an init script (runs before the app). */
export const COLLECTOR_SCRIPT = `(() => {
  const w = window;
  if (w.__lgPerf) return;
  const out = { lcp: null, cls: [], loaf: [], events: [], fcp: null };
  w.__lgPerf = out;
  const watch = (type, fn) => {
    try { new PerformanceObserver((list) => list.getEntries().forEach(fn)).observe({ type, buffered: true }); } catch (e) { /* unsupported */ }
  };
  watch('largest-contentful-paint', (e) => { out.lcp = e.startTime; });
  watch('paint', (e) => { if (e.name === 'first-contentful-paint') out.fcp = e.startTime; });
  watch('layout-shift', (e) => { if (!e.hadRecentInput) out.cls.push({ t: e.startTime, v: e.value }); });
  watch('long-animation-frame', (e) => { out.loaf.push({ t: e.startTime, d: e.duration, b: e.blockingDuration || 0 }); });
  try {
    new PerformanceObserver((list) => list.getEntries().forEach((e) => {
      if (e.interactionId) out.events.push({ id: e.interactionId, d: e.duration, name: e.name, t: e.startTime });
    })).observe({ type: 'event', buffered: true, durationThreshold: 16 });
  } catch (e) { /* unsupported */ }
})();`;

export interface LayoutShift {
  t: number;
  v: number;
}
export interface EventEntry {
  id: number;
  d: number;
  name: string;
  t: number;
}
export interface Loaf {
  t: number;
  d: number;
  b: number;
}
interface Collected {
  lcp: number | null;
  fcp: number | null;
  cls: LayoutShift[];
  loaf: Loaf[];
  events: EventEntry[];
}

/**
 * CLS as the web-vitals library defines it: the largest session window of
 * shifts (a window ends after a 1 s gap or once it spans 5 s).
 */
export function cumulativeLayoutShift(shifts: readonly LayoutShift[]): number {
  let best = 0;
  let current = 0;
  let first = -Infinity;
  let last = -Infinity;
  for (const s of [...shifts].sort((a, b) => a.t - b.t)) {
    if (s.t - last < 1000 && s.t - first < 5000) {
      current += s.v;
    } else {
      current = s.v;
      first = s.t;
    }
    last = s.t;
    best = Math.max(best, current);
  }
  return best;
}

/**
 * INP of the entries recorded since `since`: each interaction's latency is
 * its longest event; with fewer than 50 interactions INP is the worst one.
 * Null when there was no interaction.
 */
export function interactionToNextPaint(
  events: readonly EventEntry[],
  since = -Infinity,
): number | null {
  const byId = new Map<number, number>();
  for (const e of events) {
    if (e.t < since) continue;
    byId.set(e.id, Math.max(byId.get(e.id) ?? 0, e.d));
  }
  if (byId.size === 0) return null;
  const all = [...byId.values()].sort((a, b) => b - a);
  // web-vitals: the 98th percentile, i.e. skip one per 50 interactions.
  return all[Math.min(all.length - 1, Math.floor(all.length / 50))]!;
}

/** Frame summary of a scroll: rAF deltas plus the long animation frames in the window. */
export function frameSummary(
  frameDeltas: readonly number[],
  loafs: readonly Loaf[],
  span: { start: number; end: number },
): { maxFrameMs: number; over50: number; over100: number; loafCount: number } {
  const inWindow = loafs.filter((l) => l.t >= span.start && l.t <= span.end);
  const all = [...frameDeltas, ...inWindow.map((l) => l.d)];
  return {
    maxFrameMs: all.length ? Math.max(...all) : 0,
    over50: all.filter((d) => d > 50).length,
    over100: all.filter((d) => d > 100).length,
    loafCount: inWindow.length,
  };
}

/** True when a rule's selector (or an enclosing block) names the glass design. */
const GLASS_SELECTOR = /data-appearance\s*=\s*["']?liquid-glass|data-lg-|data-glass/iu;

/**
 * Bytes of the CSS rules that only Liquid Glass uses: every rule block whose
 * own selector, or an enclosing block's prelude, matches GLASS_SELECTOR.
 * Comments are skipped; strings may hold braces. Counts the block's text
 * from its prelude to its closing brace.
 */
export function glassCssBytes(css: string): number {
  let bytes = 0;
  // Stack of { start, glass } for open blocks.
  const stack: { start: number; glass: boolean }[] = [];
  let preludeStart = 0;
  let i = 0;
  let quote: string | null = null;
  while (i < css.length) {
    const ch = css[i]!;
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      i = end === -1 ? css.length : end + 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      i += 1;
      continue;
    }
    if (ch === '{') {
      const prelude = css.slice(preludeStart, i);
      const parentGlass = stack.length > 0 && stack[stack.length - 1]!.glass;
      stack.push({ start: preludeStart, glass: parentGlass || GLASS_SELECTOR.test(prelude) });
      preludeStart = i + 1;
    } else if (ch === '}') {
      const open = stack.pop();
      if (open) {
        const parentGlass = stack.length > 0 && stack[stack.length - 1]!.glass;
        // Count a glass block once: at its outermost glass level.
        if (open.glass && !parentGlass)
          bytes += Buffer.byteLength(css.slice(open.start, i + 1).trim());
      }
      preludeStart = i + 1;
    } else if (ch === ';' && stack.length === 0) {
      preludeStart = i + 1; // a top-level statement (@import, @charset)
    }
    i += 1;
  }
  return bytes;
}

/** Transfer bytes by kind, from resource timing (plus the document itself). */
export interface ByteCounts {
  jsBytes: number;
  cssBytes: number;
  imgBytes: number;
  sceneBytes: number;
  sceneCount: number;
  cssUrls: string[];
}

export interface ResourceRow {
  name: string;
  initiatorType: string;
  transferSize: number;
  encodedBodySize: number;
}

/** Splits resource rows into the byte kinds of 8.4 (transfer size; a cache hit counts 0). */
export function byteCounts(rows: readonly ResourceRow[], origin: string): ByteCounts {
  const out: ByteCounts = {
    jsBytes: 0,
    cssBytes: 0,
    imgBytes: 0,
    sceneBytes: 0,
    sceneCount: 0,
    cssUrls: [],
  };
  for (const r of rows) {
    let url: URL;
    try {
      url = new URL(r.name);
    } catch {
      continue;
    }
    const size = r.transferSize;
    const path = url.pathname;
    if (url.origin === origin && path.startsWith('/liquid-glass/')) {
      out.sceneBytes += size;
      out.sceneCount += 1;
      out.imgBytes += size;
    } else if (/\.m?js$/u.test(path) || r.initiatorType === 'script') out.jsBytes += size;
    else if (/\.css$/u.test(path) || (r.initiatorType === 'link' && /css/u.test(path))) {
      out.cssBytes += size;
      if (url.origin === origin) out.cssUrls.push(url.href);
    } else if (r.initiatorType === 'img' || /\.(png|jpe?g|webp|avif|gif|svg)$/u.test(path))
      out.imgBytes += size;
  }
  return out;
}

/** Everything one page load gives (null: not reported by this engine or page). */
export interface LoadMetrics {
  ttfb: number | null;
  fcp: number | null;
  lcp: number | null;
  useful: number | null;
  cls: number;
  jsBytes: number;
  cssBytes: number;
  imgBytes: number;
  classicGlassCssBytes: number;
  sceneBytes: number;
  sceneCount: number;
  heapUsed: number | null;
  blurCount: number;
}

/** The app's "usable" mark (lib/perf/marks.ts PERF_MARK.useful). */
export const USEFUL_MARK = 'stockpilot:navigation-useful';

/** Reads the collector, resource timing and the live blur count of the page now. */
export async function readLoad(page: Page, cdp: CDPSession | null): Promise<LoadMetrics> {
  const origin = new URL(page.url()).origin;
  const raw = await page.evaluate((usefulMark) => {
    const w = window as unknown as { __lgPerf?: unknown };
    const nav = performance.getEntriesByType('navigation')[0] as
      PerformanceNavigationTiming | undefined;
    const useful = performance.getEntriesByName(usefulMark)[0];
    const resources = performance.getEntriesByType('resource').map((e) => {
      const r = e as PerformanceResourceTiming;
      return {
        name: r.name,
        initiatorType: r.initiatorType,
        transferSize: r.transferSize,
        encodedBodySize: r.encodedBodySize,
      };
    });
    let blur = 0;
    for (const el of document.querySelectorAll('body *')) {
      const cs = getComputedStyle(el);
      const filter =
        cs.backdropFilter ||
        (cs as unknown as { webkitBackdropFilter?: string }).webkitBackdropFilter ||
        'none';
      if (filter === 'none') continue;
      const box = el.getBoundingClientRect();
      if (box.width === 0 || box.height === 0 || box.bottom < 0 || box.top > innerHeight) continue;
      if (cs.visibility === 'hidden' || cs.display === 'none') continue;
      blur += 1;
    }
    return {
      collected: (w.__lgPerf ?? null) as unknown,
      ttfb: nav ? nav.responseStart : null,
      useful: useful ? useful.startTime : null,
      resources,
      blur,
    };
  }, USEFUL_MARK);
  const collected = (raw.collected ?? {
    lcp: null,
    fcp: null,
    cls: [],
    loaf: [],
    events: [],
  }) as Collected;
  const bytes = byteCounts(raw.resources, origin);
  let classicGlassCssBytes = 0;
  for (const href of bytes.cssUrls) {
    const res = await page.request.get(href).catch(() => null);
    if (res && res.ok()) classicGlassCssBytes += glassCssBytes(await res.text());
  }
  let heapUsed: number | null = null;
  if (cdp) {
    const { metrics } = (await cdp.send('Performance.getMetrics')) as {
      metrics: { name: string; value: number }[];
    };
    heapUsed = metrics.find((m) => m.name === 'JSHeapUsedSize')?.value ?? null;
  }
  return {
    ttfb: raw.ttfb,
    fcp: collected.fcp,
    lcp: collected.lcp,
    useful: raw.useful,
    cls: cumulativeLayoutShift(collected.cls),
    jsBytes: bytes.jsBytes,
    cssBytes: bytes.cssBytes,
    imgBytes: bytes.imgBytes,
    classicGlassCssBytes,
    sceneBytes: bytes.sceneBytes,
    sceneCount: bytes.sceneCount,
    heapUsed,
    blurCount: raw.blur,
  };
}

/** The page's event timing entries and long animation frames so far. */
export async function readCollected(page: Page): Promise<Collected> {
  return page.evaluate(
    () =>
      ((window as unknown as { __lgPerf?: unknown }).__lgPerf ?? {
        lcp: null,
        fcp: null,
        cls: [],
        loaf: [],
        events: [],
      }) as never,
  );
}

/** Lighthouse's "Slow 4G" devtools throttling (R12 low-end profile). */
export const SLOW_4G = {
  offline: false,
  latency: 562.5,
  downloadThroughput: (1474.56 * 1024) / 8,
  uploadThroughput: (675 * 1024) / 8,
};

/** A CDP session on the page with CPU throttling and, for low-end, the slow network. */
export async function throttle(
  context: BrowserContext,
  page: Page,
  options: { cpu: number; slowNetwork: boolean; disableCache?: boolean },
): Promise<CDPSession> {
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: options.cpu });
  await cdp.send('Network.enable');
  if (options.slowNetwork) await cdp.send('Network.emulateNetworkConditions', SLOW_4G);
  if (options.disableCache) await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  return cdp;
}

/**
 * Scrolls `selector` (the app's main pane) down and back for `ms` with
 * requestAnimationFrame, recording each frame's delta. Returns the deltas and
 * the window in page time, for frameSummary with the long animation frames,
 * and `max`, how far the pane could scroll (0: it never moved, so its frames
 * prove nothing; appearance-compare.mjs does not count such a sample).
 */
export async function scriptedScroll(
  page: Page,
  selector: string,
  ms = 5000,
): Promise<{ deltas: number[]; start: number; end: number; max: number }> {
  return page.evaluate(
    ({ sel, duration }) =>
      new Promise<{ deltas: number[]; start: number; end: number; max: number }>((resolve) => {
        const el =
          (document.querySelector(sel) as HTMLElement | null) ?? document.scrollingElement!;
        const max = Math.max(0, el.scrollHeight - el.clientHeight);
        const deltas: number[] = [];
        const start = performance.now();
        let last = start;
        const step = (now: number) => {
          deltas.push(now - last);
          last = now;
          const t = (now - start) / duration;
          // Down for the first half, back up for the second: a steady 1-2 px/ms sweep.
          const pos = t < 0.5 ? t * 2 : (1 - t) * 2;
          el.scrollTop = Math.round(max * Math.min(1, Math.max(0, pos)));
          if (now - start < duration) requestAnimationFrame(step);
          else resolve({ deltas: deltas.slice(1), start, end: now, max });
        };
        requestAnimationFrame(step);
      }),
    { sel: selector, duration: ms },
  );
}

/**
 * Arms a measure of the next look switch: the time from the keydown that
 * picks the menu item to the first frame painted after <html> changed its
 * appearance attribute or theme class. Read it with readSwitchLatency.
 */
export async function armSwitchLatency(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __lgSwitch?: { down: number | null; frame: number | null } };
    const state = { down: null as number | null, frame: null as number | null };
    w.__lgSwitch = state;
    const onKey = (e: KeyboardEvent) => {
      const role = (e.target as HTMLElement | null)?.getAttribute?.('role') ?? '';
      if (e.key === 'Enter' && role.startsWith('menuitem')) state.down = e.timeStamp;
    };
    document.addEventListener('keydown', onKey, { capture: true });
    const mo = new MutationObserver(() => {
      if (state.down === null || state.frame !== null) return;
      requestAnimationFrame((t) => {
        state.frame = t;
        mo.disconnect();
        document.removeEventListener('keydown', onKey, { capture: true });
      });
    });
    mo.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-appearance', 'class'],
    });
  });
}

export async function readSwitchLatency(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const s = (window as unknown as { __lgSwitch?: { down: number | null; frame: number | null } })
      .__lgSwitch;
    return s && s.down !== null && s.frame !== null ? s.frame - s.down : null;
  });
}
