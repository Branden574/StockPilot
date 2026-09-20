/**
 * The in-page half of the performance harness.
 *
 * `collectorScript()` returns JavaScript that Playwright installs with
 * `addInitScript`, so it runs before any app code on every document. It needs
 * NOTHING from the app: no marks, no test ids, no build flag. That is the point.
 * The BEFORE baseline has to be taken on the production build as it stands, and
 * an instrument that needs a deploy cannot measure "before".
 *
 * What it times, all on the page's own clock (`performance.now()`):
 *
 *   click      the trusted click event's timeStamp
 *   feedback   first moment a known "I heard you" element exists and is visible
 *              (link spinner, top progress bar, or the URL already changed)
 *   useful     first moment the scenario's real-content marker is visible
 *              (a data row, a detail heading: never a skeleton)
 *
 * Each is recorded twice: when the DOM changed, and two animation frames later,
 * by which time the change has been painted (one frame late at worst, never
 * early). The click's own Event Timing entry is kept as an independent check.
 * Detection runs inside a MutationObserver, so there is no polling interval to
 * round the numbers up to.
 *
 * PRIVACY: image URLs are signed credentials. They are classified and hashed
 * here, inside the page, and only the class and the hash leave it.
 *
 * `collector` is serialized with toString(): it must stay self-contained.
 */
import { classifyImageUrl } from '../../src/lib/perf/image-class';

export interface ArmConfig {
  /** Any of these becoming visible counts as click feedback. */
  feedbackSelectors: string[];
  /** Regex source the pathname must match before `useful` can fire. */
  targetPath: string;
  /** Real-content marker. With `hrefPattern`, the match must be a link whose href fits it. */
  usefulSelector: string;
  usefulHrefPattern?: string;
  /** The route's loading skeleton, to time "click -> loading shell". Optional. */
  shellSelector?: string;
  /** Hard loads have no click: time from navigation start instead. */
  fromNavigationStart?: boolean;
}

export interface PageImageRecord {
  order: number;
  /** 0-based index of the table row the image sits in, or null outside a table. */
  row: number | null;
  /** One of the scenario's "first" photos: the first N rows, or the first N on screen. */
  first: boolean;
  inViewport: boolean;
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
  /** `load` event time on the page clock, when the listener was attached in time. */
  loadAt: number | null;
  /** Resource Timing, on the page clock. Null when the browser has no entry. */
  fetchStart: number | null;
  responseEnd: number | null;
  transferSize: number | null;
  encodedBodySize: number | null;
  deliveryType: string | null;
  protocol: string | null;
  klass: ReturnType<typeof classifyImageUrl>;
  /** Keyed-hash prefixes: join key to the network log, and rotation evidence across runs. */
  urlFingerprint: string;
  objectFingerprint: string | null;
  tokenFingerprint: string | null;
}

export interface PageResult {
  timeOrigin: number;
  clickAt: number | null;
  feedbackAt: number | null;
  feedbackPaintAt: number | null;
  feedbackBy: string | null;
  usefulAt: number | null;
  usefulPaintAt: number | null;
  /** First moment the loading skeleton was on screen. Null when content arrived without one. */
  shellAt: number | null;
  shellPaintAt: number | null;
  /** Event Timing for the click: processing delay and time to the next paint (8ms grain). */
  clickEventDuration: number | null;
  clickInputDelay: number | null;
  ttfb: number | null;
  fcp: number | null;
  lcp: number | null;
  /**
   * Layout shift (no recent input) and long-task time over 50ms, between click
   * and useful + settle. NULL when this engine cannot report the entry type:
   * "cannot say" must never be printed as a measured 0.
   */
  cls: number | null;
  longTaskBlocking: number | null;
  /** Entry types this engine does not support, so a "not measured" cell explains itself. */
  unsupported: string[];
  /** How long the pointer had been on the clicked link: the head start intent warming really got. */
  hoverLead: number | null;
  /** Rows in the first table of <main>: a measured fact about the dataset. */
  listRows: number | null;
  pathname: string;
}

export interface PageImages {
  records: PageImageRecord[];
  /** On-screen photos still loading when the wait ran out. */
  unfinished: number;
}

function collector(fingerprintKeyHex: string): void {
  const w = window as any;
  if (w.__spPerf) return;
  try {
    performance.setResourceTimingBufferSize(3000);
  } catch {
    /* older engines */
  }

  const state: any = {
    config: null,
    clickAt: null,
    pointerOverAt: null,
    hoverLead: null,
    feedbackAt: null,
    feedbackPaintAt: null,
    feedbackBy: null,
    usefulAt: null,
    usefulPaintAt: null,
    shellAt: null,
    shellPaintAt: null,
    shellBefore: new WeakSet<Element>(),
    lcp: null,
    shifts: [] as Array<{ t: number; v: number }>,
    longTasks: [] as Array<{ t: number; d: number }>,
    events: [] as Array<{ name: string; start: number; duration: number; delay: number }>,
    imgLoads: new WeakMap<Element, number>(),
  };

  const visible = (el: Element | null): boolean => {
    if (!el) return false;
    const rects = (el as HTMLElement).getClientRects();
    if (rects.length === 0) return false;
    // React streams finished content into a hidden container before swapping it
    // into place; a match in there is not on screen yet.
    return !el.closest('[hidden]');
  };

  // DOUBLE requestAnimationFrame. The first callback runs at the START of the
  // frame that will contain the change, before it is painted; the second runs
  // at the start of the frame after it, by which time the change has been on
  // screen. One frame late at worst, never early: a budget check should err
  // toward the slower number.
  const nextFrame = (key: 'feedbackPaintAt' | 'usefulPaintAt' | 'shellPaintAt') => {
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (state[key] === null) state[key] = performance.now();
      }),
    );
  };

  const check = () => {
    const cfg = state.config ?? w.__spPerfAutoArm ?? null;
    if (!cfg) return;
    if (state.config === null) state.config = cfg;
    const started = cfg.fromNavigationStart ? 0 : state.clickAt;
    if (started === null) return;
    // Done: stop querying, so the instrument costs the page nothing afterwards.
    if (state.usefulAt !== null && (state.feedbackAt !== null || cfg.fromNavigationStart)) return;
    const onTarget = new RegExp(cfg.targetPath).test(location.pathname);

    if (state.feedbackAt === null && !cfg.fromNavigationStart) {
      let by: string | null = null;
      for (const sel of cfg.feedbackSelectors) {
        if (visible(document.querySelector(sel))) {
          by = sel;
          break;
        }
      }
      if (by === null && onTarget) by = 'url-changed';
      if (by !== null) {
        state.feedbackAt = performance.now();
        state.feedbackBy = by;
        nextFrame('feedbackPaintAt');
      }
    }

    // A loading skeleton counts only if it was NOT already on the page when the
    // click was armed: the start page can carry pulsing placeholders of its own.
    if (state.shellAt === null && state.usefulAt === null && cfg.shellSelector) {
      const fresh = Array.from(document.querySelectorAll(cfg.shellSelector)).find(
        (el) => !state.shellBefore.has(el) && visible(el as Element),
      );
      if (fresh) {
        state.shellAt = performance.now();
        nextFrame('shellPaintAt');
      }
    }

    if (state.usefulAt === null && onTarget) {
      const pattern = cfg.usefulHrefPattern ? new RegExp(cfg.usefulHrefPattern) : null;
      const nodes = document.querySelectorAll(cfg.usefulSelector);
      for (const node of Array.from(nodes)) {
        if (pattern && !pattern.test(node.getAttribute('href') ?? '')) continue;
        if (!visible(node)) continue;
        state.usefulAt = performance.now();
        nextFrame('usefulPaintAt');
        break;
      }
    }
  };

  const watchImage = (img: HTMLImageElement) => {
    if (state.imgLoads.has(img) || img.complete) return;
    img.addEventListener('load', () => state.imgLoads.set(img, performance.now()), { once: true });
  };

  new MutationObserver((records) => {
    for (const record of records) {
      for (const node of Array.from(record.addedNodes)) {
        if (!(node instanceof Element)) continue;
        if (node instanceof HTMLImageElement) watchImage(node);
        for (const img of Array.from(node.querySelectorAll('img'))) watchImage(img);
      }
    }
    check();
  }).observe(document, { childList: true, subtree: true, attributes: true });

  // When the pointer ARRIVED on a link: what intent warming reacts to.
  document.addEventListener(
    'pointerover',
    (event) => {
      if (event.isTrusted && (event.target as Element | null)?.closest?.('a'))
        state.pointerOverAt = event.timeStamp;
    },
    { capture: true },
  );

  // Capture phase, so the timestamp is taken before any app handler runs.
  document.addEventListener(
    'click',
    (event) => {
      if (!event.isTrusted || state.config === null || state.clickAt !== null) return;
      state.clickAt = event.timeStamp;
      state.hoverLead = state.pointerOverAt === null ? null : event.timeStamp - state.pointerOverAt;
      // The link spinner can be committed synchronously inside this same task.
      queueMicrotask(check);
    },
    { capture: true },
  );

  const observe = (
    type: string,
    handle: (entry: any) => void,
    extra: Record<string, unknown> = {},
  ) => {
    try {
      new PerformanceObserver((list) => list.getEntries().forEach(handle)).observe({
        type,
        buffered: true,
        ...extra,
      } as PerformanceObserverInit);
    } catch {
      /* this engine does not report that entry type */
    }
  };
  observe('largest-contentful-paint', (e) => (state.lcp = e.startTime));
  observe('layout-shift', (e) => {
    state.shifts.push({ t: e.startTime, v: e.value, input: Boolean(e.hadRecentInput) });
  });
  observe('longtask', (e) => state.longTasks.push({ t: e.startTime, d: e.duration }));
  observe(
    'event',
    (e) => {
      if (e.name === 'click' || e.name === 'pointerdown' || e.name === 'pointerup') {
        state.events.push({
          name: e.name,
          start: e.startTime,
          duration: e.duration,
          delay: e.processingStart - e.startTime,
        });
      }
    },
    { durationThreshold: 16 },
  );

  // Keyed (HMAC), not a bare hash: an unsalted digest of a low-entropy URL can
  // be reversed by enumeration. The key is a per-machine secret the runner
  // passes into THIS CLOSURE (never onto `window`, where the page's own scripts
  // and every third-party frame could read it), and it is imported as a
  // non-extractable CryptoKey. The same key in network-log.ts keeps the two
  // halves joinable, and
  // keeps "same photo, different token" comparable between runs on this machine.
  let hmacKey: Promise<CryptoKey> | null = null;
  const sha = async (text: string): Promise<string> => {
    if (hmacKey === null) {
      const raw = new Uint8Array(
        fingerprintKeyHex.match(/../g)!.map((h: string) => parseInt(h, 16)),
      );
      hmacKey = crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, [
        'sign',
      ]);
    }
    const bytes = await crypto.subtle.sign('HMAC', await hmacKey, new TextEncoder().encode(text));
    return Array.from(new Uint8Array(bytes))
      .slice(0, 8)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  };

  w.__spPerf = {
    arm(config: any) {
      state.config = config;
      state.clickAt = null;
      state.hoverLead = null;
      state.feedbackAt = state.feedbackPaintAt = state.feedbackBy = null;
      state.usefulAt = state.usefulPaintAt = null;
      state.shellAt = state.shellPaintAt = null;
      state.shellBefore = new WeakSet<Element>();
      if (config.shellSelector) {
        for (const el of Array.from(document.querySelectorAll(config.shellSelector)))
          state.shellBefore.add(el);
      }
    },

    isUseful(): boolean {
      check();
      return state.usefulAt !== null && state.usefulPaintAt !== null;
    },

    result(settleUntil: number | null) {
      const from = state.config?.fromNavigationStart ? 0 : state.clickAt;
      const until = settleUntil ?? performance.now();
      const within = (t: number) => from !== null && t >= from && t <= until;
      const nav = performance.getEntriesByType('navigation')[0] as
        PerformanceNavigationTiming | undefined;
      const fcp = performance.getEntriesByName('first-contentful-paint')[0];
      const click = state.events.find(
        (e: any) =>
          e.name === 'click' && state.clickAt !== null && Math.abs(e.start - state.clickAt) < 2,
      );
      const supported: string[] = (PerformanceObserver as any).supportedEntryTypes ?? [];
      const has = (type: string) => supported.includes(type);
      const wanted = ['largest-contentful-paint', 'layout-shift', 'longtask', 'event'];

      const table = document.querySelector('main table tbody');
      return {
        timeOrigin: performance.timeOrigin,
        clickAt: state.clickAt,
        feedbackAt: state.feedbackAt,
        feedbackPaintAt: state.feedbackPaintAt,
        feedbackBy: state.feedbackBy,
        usefulAt: state.usefulAt,
        usefulPaintAt: state.usefulPaintAt,
        shellAt: state.shellAt,
        shellPaintAt: state.shellPaintAt,
        clickEventDuration: click ? click.duration : null,
        clickInputDelay: click ? click.delay : null,
        hoverLead: state.hoverLead,
        ttfb: nav ? nav.responseStart : null,
        fcp: fcp ? fcp.startTime : null,
        lcp: has('largest-contentful-paint') ? state.lcp : null,
        cls: has('layout-shift')
          ? state.shifts
              // Web Vitals ignores shifts right after input. On a soft navigation the
              // click IS the scenario, so the shifts it causes are the ones wanted.
              .filter((s: any) => within(s.t) && (!s.input || !state.config?.fromNavigationStart))
              .reduce((sum: number, s: any) => sum + s.v, 0)
          : null,
        longTaskBlocking: has('longtask')
          ? state.longTasks
              .filter((t: any) => within(t.t))
              .reduce((sum: number, t: any) => sum + Math.max(0, t.d - 50), 0)
          : null,
        unsupported: wanted.filter((type) => !has(type)),
        listRows: table ? table.querySelectorAll(':scope > tr').length : null,
        pathname: location.pathname,
      };
    },

    /**
     * Waits (bounded) for the photos in `scope` that are on screen, then
     * describes them. Inline `data:` images are left out entirely: they are
     * blur placeholders, not photos, and have nothing to load.
     */
    async images(
      scope: string,
      firstCount: number,
      maxWaitMs: number,
      settledWhenGone: string | null,
    ) {
      const root = document.querySelector(scope) ?? document.body;
      const onScreen = (img: Element) => {
        const r = img.getBoundingClientRect();
        return (
          r.width > 0 &&
          r.height > 0 &&
          r.bottom > 0 &&
          r.right > 0 &&
          r.top < innerHeight &&
          r.left < innerWidth
        );
      };
      const isPhoto = (img: HTMLImageElement) => {
        const src = img.currentSrc || img.src;
        return Boolean(src) && !src.startsWith('data:') && !src.startsWith('blob:');
      };
      // The SET has to settle, not just the photos in it: a strip that loads its
      // own data (the storefront's "Frequently ordered") adds photos after the
      // first card appears. Done = no skeleton left in scope, nothing pending,
      // and the same on-screen photos for three polls in a row.
      const deadline = performance.now() + maxWaitMs;
      let unfinished = 0;
      let stable = 0;
      let lastSet = '';
      for (;;) {
        const shown = Array.from(root.querySelectorAll('img')).filter(
          (i) => isPhoto(i) && onScreen(i),
        );
        const pending = shown.filter((i) => !i.complete);
        unfinished = pending.length;
        const skeleton = settledWhenGone !== null && root.querySelector(settledWhenGone) !== null;
        const signature =
          String(shown.length) + ':' + shown.map((i) => (i.currentSrc || i.src).length).join(',');
        stable = signature === lastSet && pending.length === 0 && !skeleton ? stable + 1 : 0;
        lastSet = signature;
        if (stable >= 3 || performance.now() > deadline) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      const rows = Array.from(root.querySelectorAll('tbody tr'));
      const out: any[] = [];
      let order = 0;
      let onScreenSeen = 0;
      for (const img of Array.from(root.querySelectorAll('img'))) {
        if (!isPhoto(img)) continue;
        const src = img.currentSrc || img.src;
        const entry = performance.getEntriesByName(src).pop() as
          PerformanceResourceTiming | undefined;
        const rect = img.getBoundingClientRect();
        const tr = img.closest('tr');
        let objectFingerprint: string | null = null;
        let tokenFingerprint: string | null = null;
        try {
          const outer = new URL(src, location.origin);
          const inner =
            outer.pathname === '/_next/image'
              ? new URL(outer.searchParams.get('url') ?? '', location.origin)
              : outer;
          objectFingerprint = await sha(inner.origin + inner.pathname);
          const token = inner.searchParams.get('token');
          tokenFingerprint = token ? await sha(token) : null;
        } catch {
          /* not a URL we can split; the class already says "unknown" */
        }
        const visibleNow = onScreen(img);
        const rowIndex = tr ? rows.indexOf(tr) : null;
        // In a table "first" means the first N ROWS; in a card grid, the
        // first N photos on screen in document order.
        const first =
          rowIndex !== null ? rowIndex < firstCount : visibleNow && onScreenSeen < firstCount;
        if (visibleNow) onScreenSeen += 1;
        out.push({
          order: order++,
          row: rowIndex,
          first,
          inViewport: visibleNow,
          renderedWidth: Math.round(rect.width),
          renderedHeight: Math.round(rect.height),
          naturalWidth: img.naturalWidth,
          naturalHeight: img.naturalHeight,
          devicePixelRatio: devicePixelRatio,
          loading: img.loading,
          fetchPriority: img.getAttribute('fetchpriority'),
          hasBlurPlaceholder: /url\(/.test(img.style.backgroundImage ?? ''),
          complete: img.complete,
          failed: img.complete && img.naturalWidth === 0,
          loadAt: state.imgLoads.get(img) ?? null,
          fetchStart: entry ? entry.fetchStart : null,
          responseEnd: entry ? entry.responseEnd : null,
          transferSize: entry ? entry.transferSize : null,
          encodedBodySize: entry ? entry.encodedBodySize : null,
          deliveryType: entry ? ((entry as any).deliveryType ?? null) : null,
          protocol: entry ? entry.nextHopProtocol : null,
          klass: w.__spClassify(src, location.origin),
          urlFingerprint: await sha(src),
          objectFingerprint,
          tokenFingerprint,
        });
      }
      return { records: out, unfinished };
    },
  };
}

export function collectorScript(fingerprintKeyHex: string): string {
  if (!/^[0-9a-f]{64}$/.test(fingerprintKeyHex))
    throw new Error('fingerprint key must be 32 bytes of hex');
  return [
    `window.__spClassify = ${classifyImageUrl.toString()};`,
    `(${collector.toString()})('${fingerprintKeyHex}');`,
  ].join('\n');
}
