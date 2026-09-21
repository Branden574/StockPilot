// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * rum.ts is the last piece of OUR code a performance number passes through
 * before it leaves the browser, so this suite is mostly about what may NOT
 * come out of it. `capture` (the analytics wrapper) is the only thing mocked:
 * marks.ts, route-template.ts and stats.ts are real, because the promise under
 * test is about the payload that reaches `capture`, whoever helped build it.
 *
 * This file lives under src/lib (the `node` project) and opts into a DOM with
 * the docblock above; rum.ssr.test.ts is its no-DOM twin.
 */

const { captureMock, buildRef } = vi.hoisted(() => ({
  captureMock: vi.fn(),
  buildRef: { value: '' },
}));

vi.mock('@/lib/analytics', () => ({ capture: captureMock }));
// A getter, so one test can flip the build hash without re-importing rum.ts.
vi.mock('@/lib/build-info', () => ({
  get LOADED_BUILD() {
    return buildRef.value;
  },
}));

import type { ImageClass } from './image-class';
import {
  __resetForTests as resetMarks,
  markNavigationClick,
  markNavigationUseful,
  type NavigationSummary,
} from './marks';
import {
  __resetForTests as resetRum,
  MAX_IMAGE_SAMPLES,
  PERF_SAMPLE_RATE,
  reportImageError,
  reportImages,
  reportNavigation,
  reportWebVital,
  startPerfRum,
  type ImageSample,
} from './rum';

const UUID = '3f2c1a9e-7b4d-4c1e-9a2f-0d5e6f7a8b9c';

let landedOn: string | null = null;
let clock = 0;

function goTo(path: string): void {
  window.history.replaceState(null, '', path);
}

interface Sent {
  event: string;
  properties: Record<string, unknown>;
}

function sent(): Sent[] {
  return captureMock.mock.calls.map(([event, properties]) => ({
    event: event as string,
    properties: properties as Record<string, unknown>,
  }));
}

function only(): Sent {
  expect(captureMock).toHaveBeenCalledTimes(1);
  return sent()[0] as Sent;
}

const THUMB_VIA_OPTIMIZER: ImageClass = {
  delivery: 'optimizer',
  upstream: 'storage-signed',
  variant: 'thumb',
  requestedWidth: 384,
  requestedQuality: 75,
  signed: true,
};

function sample(over: Partial<ImageSample> = {}): ImageSample {
  return {
    delivery: 'optimizer',
    variant: 'thumb',
    durationMs: 100,
    sizesKnown: true,
    cacheHit: false,
    ...over,
  };
}

beforeEach(() => {
  resetRum();
  resetMarks();
  captureMock.mockReset();
  buildRef.value = '';
  landedOn = null;
  clock = 0;
  goTo('/dashboard');
  // setup.ts restores every spy after each test, so they are re-made here.
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  const realGetEntriesByType = performance.getEntriesByType.bind(performance);
  vi.spyOn(performance, 'getEntriesByType').mockImplementation((type: string) => {
    if (type !== 'navigation') return realGetEntriesByType(type);
    return landedOn === null
      ? []
      : ([{ name: `http://localhost:3000${landedOn}` }] as unknown as PerformanceEntryList);
  });
  // marks.ts refuses to report a navigation that was ever hidden; pin it visible.
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => 'visible',
  });
});

describe('reportNavigation', () => {
  it('sends a soft navigation as perf_navigation: templates, whole milliseconds, nothing else', () => {
    reportNavigation({
      kind: 'soft-nav',
      fromRoute: '/dashboard',
      toRoute: '/dashboard/inventory/[id]',
      clickToFeedbackMs: 18.4,
      clickToUsefulMs: 741.6,
      intentLeadMs: 2400.5,
    });
    expect(only()).toEqual({
      event: 'perf_navigation',
      properties: {
        nav_kind: 'soft-nav',
        route: '/dashboard/inventory/[id]',
        from_route: '/dashboard',
        click_to_feedback_ms: 18,
        click_to_useful_ms: 742,
        intent_lead_ms: 2401,
      },
    });
  });

  it('templates the routes AGAIN, whatever the caller claims they already are', () => {
    reportNavigation({
      kind: 'soft-nav',
      fromRoute: `/dashboard/orders/1042?tab=picked`,
      toRoute: `https://app.stockpilotusa.com/dashboard/inventory/${UUID}?q=acme#photos`,
      clickToFeedbackMs: 10,
      clickToUsefulMs: 20,
      intentLeadMs: null,
    });
    const { properties } = only();
    expect(properties.route).toBe('/dashboard/inventory/[id]');
    expect(properties.from_route).toBe('/dashboard/orders/[id]');
  });

  it('omits what was not measured instead of sending a zero', () => {
    reportNavigation({
      kind: 'soft-nav',
      fromRoute: '/dashboard',
      toRoute: '/dashboard/orders',
      clickToFeedbackMs: null,
      clickToUsefulMs: 300,
      intentLeadMs: null,
    });
    const { properties } = only();
    expect(properties).not.toHaveProperty('click_to_feedback_ms');
    expect(properties).not.toHaveProperty('intent_lead_ms');
    expect(properties.click_to_useful_ms).toBe(300);
  });

  it('sends a hard load as perf_page_useful', () => {
    reportNavigation({
      kind: 'hard-load',
      route: `/dashboard/inventory/${UUID}`,
      usefulMs: 1834.49,
    });
    expect(only()).toEqual({
      event: 'perf_page_useful',
      properties: { nav_kind: 'hard-load', route: '/dashboard/inventory/[id]', useful_ms: 1834 },
    });
  });

  it('sends nothing for a summary without a sane headline number, an unknown kind, or junk', () => {
    const soft = { kind: 'soft-nav', fromRoute: '/dashboard', toRoute: '/dashboard/orders' };
    for (const clickToUsefulMs of [Number.NaN, Number.POSITIVE_INFINITY, -1, '300', null]) {
      reportNavigation({ ...soft, clickToUsefulMs } as unknown as NavigationSummary);
    }
    reportNavigation({ kind: 'hard-load', route: '/dashboard', usefulMs: Number.NaN });
    reportNavigation({ kind: 'teleport', route: '/dashboard' } as unknown as NavigationSummary);
    reportNavigation(null as unknown as NavigationSummary);
    reportNavigation('soft-nav' as unknown as NavigationSummary);
    expect(captureMock).not.toHaveBeenCalled();
  });
});

describe('reportWebVital', () => {
  it('sends the five scalar fields, rounded, under the route the DOCUMENT was loaded on', () => {
    landedOn = `/dashboard/inventory/${UUID}?q=acme`;
    goTo('/dashboard/orders'); // many soft navigations later, when LCP is finalized
    reportWebVital({
      name: 'LCP',
      value: 1234.56,
      delta: 200.4,
      rating: 'needs-improvement',
      navigationType: 'back-forward-cache',
    });
    expect(only()).toEqual({
      event: 'perf_web_vital',
      properties: {
        metric: 'LCP',
        value: 1235,
        delta: 200,
        rating: 'needs-improvement',
        navigation_type: 'back-forward-cache',
        route: '/dashboard/inventory/[id]',
      },
    });
  });

  it('falls back to the template of the current location when there is no Navigation Timing entry', () => {
    goTo(`/dashboard/inventory/${UUID}?q=acme`);
    reportWebVital({ name: 'TTFB', value: 88.2, delta: 88.2, rating: 'good' });
    expect(only().properties.route).toBe('/dashboard/inventory/[id]');
  });

  it('keeps three decimals of CLS (a score around 0.1) and whole milliseconds of everything else', () => {
    reportWebVital({ name: 'CLS', value: 0.123456, delta: 0.0004, rating: 'good' });
    reportWebVital({ name: 'INP', value: 199.5, delta: 0.4, rating: 'good' });
    const [cls, inp] = sent();
    expect(cls?.properties.value).toBe(0.123);
    expect(cls?.properties.delta).toBe(0);
    expect(inp?.properties.value).toBe(200);
    expect(inp?.properties.delta).toBe(0);
  });

  it('accepts every vital Next reports', () => {
    for (const name of ['TTFB', 'FCP', 'LCP', 'FID', 'CLS', 'INP']) {
      reportWebVital({ name, value: 1, delta: 1, rating: 'good', navigationType: 'navigate' });
    }
    expect(sent().map((s) => s.properties.metric)).toEqual([
      'TTFB',
      'FCP',
      'LCP',
      'FID',
      'CLS',
      'INP',
    ]);
  });

  it('ignores a metric name it does not know, rather than passing the string through', () => {
    const names = [
      'Next.js-hydration',
      'lcp',
      'LCP ',
      '',
      `https://evil.example/${UUID}`,
      42,
      null,
      undefined,
      {},
    ];
    for (const name of names) {
      reportWebVital({ name, value: 10, delta: 10, rating: 'good' });
    }
    reportWebVital(null);
    reportWebVital(undefined);
    reportWebVital('LCP' as unknown as { name: string });
    expect(captureMock).not.toHaveBeenCalled();
  });

  it('ignores a value that is not a sane non-negative number', () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, -0.1, '1200', null, undefined]) {
      reportWebVital({ name: 'LCP', value, delta: 1, rating: 'good' });
    }
    expect(captureMock).not.toHaveBeenCalled();
  });

  it('drops an unknown rating, navigation type or delta and still sends the measurement', () => {
    reportWebVital({
      name: 'FCP',
      value: 640,
      delta: Number.NaN,
      rating: 'excellent',
      navigationType: 'teleport',
    });
    expect(only().properties).toEqual({ metric: 'FCP', value: 640, route: '/dashboard' });
  });

  it('never even READS entries or id: the LCP entry carries a signed photo URL', () => {
    const entries = vi.fn(() => [{ url: 'https://x.supabase.co/object/sign/a.jpg?token=SECRET' }]);
    const id = vi.fn(() => 'v4-1726850000000-1234567890123');
    const metric = { name: 'LCP', value: 900, delta: 900, rating: 'good' };
    Object.defineProperty(metric, 'entries', { enumerable: true, get: entries });
    Object.defineProperty(metric, 'id', { enumerable: true, get: id });
    reportWebVital(metric);
    expect(captureMock).toHaveBeenCalledTimes(1);
    expect(entries).not.toHaveBeenCalled();
    expect(id).not.toHaveBeenCalled();
  });
});

describe('reportImageError', () => {
  it('sends the CLASS of the image and the route template', () => {
    reportImageError(`/dashboard/inventory/${UUID}`, THUMB_VIA_OPTIMIZER);
    expect(only()).toEqual({
      event: 'perf_image_error',
      properties: {
        route: '/dashboard/inventory/[id]',
        delivery: 'optimizer',
        upstream: 'storage-signed',
        variant: 'thumb',
        requested_width: 384,
        requested_quality: 75,
        signed: true,
      },
    });
  });

  it('omits what a direct Storage image does not have (no upstream, no w/q)', () => {
    reportImageError('/dashboard/books', {
      delivery: 'storage-signed',
      upstream: null,
      variant: 'master',
      requestedWidth: null,
      requestedQuality: null,
      signed: true,
    });
    expect(only().properties).toEqual({
      route: '/dashboard/books',
      delivery: 'storage-signed',
      variant: 'master',
      signed: true,
    });
  });

  it('bounds the numbers parsed out of a URL: a width is a width, not a free-form number', () => {
    reportImageError('/dashboard', {
      ...THUMB_VIA_OPTIMIZER,
      requestedWidth: 5_551_234_567, // a phone number typed into ?w=
      requestedQuality: 101,
    });
    const { properties } = only();
    expect(properties).not.toHaveProperty('requested_width');
    expect(properties).not.toHaveProperty('requested_quality');
  });

  it('reports a missing or malformed class as unknown instead of throwing', () => {
    reportImageError(null, null as unknown as ImageClass);
    reportImageError(undefined, { delivery: 'cdn', variant: 'huge' } as unknown as ImageClass);
    for (const { properties } of sent()) {
      expect(properties).toEqual({
        route: '/[unknown]',
        delivery: 'unknown',
        variant: 'not-an-item-photo',
        signed: false,
      });
    }
    expect(captureMock).toHaveBeenCalledTimes(2);
  });
});

describe('reportImages', () => {
  it('sends ONE event per view: counts per class, observed p50/max, cache hits with their denominator', () => {
    reportImages(`/dashboard/inventory?q=acme`, [
      sample({ durationMs: 40.4, cacheHit: true }),
      sample({ durationMs: 120.6 }),
      sample({ durationMs: 300 }),
      sample({
        delivery: 'storage-signed',
        variant: 'master',
        durationMs: 900.2,
        sizesKnown: false,
      }),
    ]);
    expect(only()).toEqual({
      event: 'perf_images',
      properties: {
        route: '/dashboard/inventory',
        image_count: 4,
        capped: false,
        images_optimizer_thumb: 3,
        images_storage_signed_master: 1,
        // Nearest-rank over [40, 121, 300, 900]: a duration that was observed, never a blend.
        duration_p50_ms: 121,
        duration_max_ms: 900,
        sizes_known_count: 3,
        cache_hit_count: 1,
      },
    });
  });

  it('never counts a cache hit the browser could not have known about (sizes unknown)', () => {
    reportImages('/dashboard', [sample({ sizesKnown: false, cacheHit: true })]);
    const { properties } = only();
    expect(properties.sizes_known_count).toBe(0);
    expect(properties.cache_hit_count).toBe(0);
  });

  it('sends nothing for a view that loaded no images', () => {
    reportImages('/dashboard', []);
    reportImages('/dashboard', null as unknown as ImageSample[]);
    reportImages('/dashboard', 'images' as unknown as ImageSample[]);
    expect(captureMock).not.toHaveBeenCalled();
  });

  it(`reports the first ${MAX_IMAGE_SAMPLES} and says it was capped`, () => {
    const many = Array.from({ length: MAX_IMAGE_SAMPLES + 50 }, () => sample());
    reportImages('/dashboard/inventory', many);
    const { properties } = only();
    expect(properties.image_count).toBe(MAX_IMAGE_SAMPLES);
    expect(properties.images_optimizer_thumb).toBe(MAX_IMAGE_SAMPLES);
    expect(properties.capped).toBe(true);
  });

  it('honours a cap the component applied before the samples got here', () => {
    reportImages('/dashboard/inventory', [sample()], true);
    expect(only().properties.capped).toBe(true);
  });

  it('files junk samples under unknown and omits durations it does not have', () => {
    const junk = [null, undefined, 'https://x/y.jpg', 42, { delivery: 'cdn', durationMs: 'slow' }];
    reportImages('/dashboard', junk as unknown as ImageSample[]);
    expect(only().properties).toEqual({
      route: '/dashboard',
      image_count: 5,
      capped: false,
      images_unknown_not_an_item_photo: 5,
      sizes_known_count: 0,
      cache_hit_count: 0,
    });
  });
});

describe('what never gets sent, whoever asks', () => {
  function reportEverything(): void {
    reportNavigation({
      kind: 'soft-nav',
      fromRoute: '/dashboard',
      toRoute: '/dashboard/orders',
      clickToFeedbackMs: 10,
      clickToUsefulMs: 20,
      intentLeadMs: null,
    });
    reportNavigation({ kind: 'hard-load', route: '/dashboard', usefulMs: 500 });
    reportWebVital({ name: 'LCP', value: 900, delta: 900, rating: 'good' });
    reportImageError('/dashboard', THUMB_VIA_OPTIMIZER);
    reportImages('/dashboard', [sample()]);
  }

  it('sends all five events from an ordinary route (so the silences below mean something)', () => {
    reportEverything();
    expect(sent().map((s) => s.event)).toEqual([
      'perf_navigation',
      'perf_page_useful',
      'perf_web_vital',
      'perf_image_error',
      'perf_images',
    ]);
  });

  it.each([['/r/abcdef0123456789'], ['/m/abcdef0123456789'], ['/r/track']])(
    'MUTATION GUARD: never calls capture on a share path (%s), even for a dashboard route',
    (sharePath) => {
      goTo(sharePath);
      startPerfRum();
      reportEverything();
      // A navigation measured by marks.ts while the address bar is on a share path.
      clock = 1_000;
      markNavigationClick('/dashboard/orders');
      clock = 1_200;
      markNavigationUseful('/dashboard/orders');
      expect(captureMock).not.toHaveBeenCalled();
    },
  );

  it('SAMPLING: a page load that lost the coin flip sends nothing, and the flip is never repeated', () => {
    // Math.random() is [0, 1), so at a rate of 1 only an out-of-range 1 can lose. The point
    // is the comparison and the memo, which are what change when the rate is lowered.
    expect(PERF_SAMPLE_RATE).toBeGreaterThan(0);
    expect(PERF_SAMPLE_RATE).toBeLessThanOrEqual(1);
    const random = vi.spyOn(Math, 'random').mockReturnValue(1);
    reportEverything();
    random.mockReturnValue(0); // a later event must not get a second chance
    reportEverything();
    expect(captureMock).not.toHaveBeenCalled();
    expect(random).toHaveBeenCalledTimes(1);
  });

  it('SAMPLING: a page load that won the coin flip reports everything, on ONE flip', () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    reportEverything();
    random.mockReturnValue(1); // and cannot be un-sampled halfway through a session
    reportEverything();
    expect(captureMock).toHaveBeenCalledTimes(10);
    expect(random).toHaveBeenCalledTimes(1);
  });

  it('attaches the build hash itself, and only when it looks like one', () => {
    buildRef.value = 'ef38e3a6';
    reportImageError('/dashboard', THUMB_VIA_OPTIMIZER);
    expect(sent()[0]?.properties.build).toBe('ef38e3a6');

    for (const notAHash of ['', 'main', 'ef38e3a6?token=SECRET', 'EF38E3A6', 'ef38']) {
      captureMock.mockReset();
      buildRef.value = notAHash;
      reportImageError('/dashboard', THUMB_VIA_OPTIMIZER);
      expect(only().properties).not.toHaveProperty('build');
    }
  });

  it('never throws into the page: not when capture throws, not when its input does', () => {
    captureMock.mockImplementation(() => {
      throw new Error('posthog exploded');
    });
    expect(reportEverything).not.toThrow();

    captureMock.mockReset();
    const booby = (): never => {
      throw new Error('getter exploded');
    };
    const trapped = new Proxy({}, { get: booby, has: booby, ownKeys: booby });
    expect(() => {
      reportNavigation(trapped as NavigationSummary);
      reportWebVital(trapped);
      reportImageError('/dashboard', trapped as ImageClass);
      reportImages('/dashboard', [trapped as ImageSample]);
    }).not.toThrow();
    expect(captureMock).not.toHaveBeenCalled();
  });
});

describe('startPerfRum', () => {
  function navigate(toRoute: string, clickAt: number, usefulAt: number): void {
    clock = clickAt;
    markNavigationClick(toRoute);
    clock = usefulAt;
    goTo(toRoute);
    markNavigationUseful(toRoute);
  }

  it('connects the navigation marks to analytics', () => {
    startPerfRum();
    navigate(`/dashboard/inventory/${UUID}`, 1_000, 1_750);
    expect(only()).toEqual({
      event: 'perf_navigation',
      properties: {
        nav_kind: 'soft-nav',
        route: '/dashboard/inventory/[id]',
        from_route: '/dashboard',
        click_to_useful_ms: 750,
      },
    });
  });

  it('is idempotent: the root layout re-mounting does not double every event', () => {
    startPerfRum();
    startPerfRum();
    startPerfRum();
    navigate('/dashboard/orders', 1_000, 1_300);
    expect(captureMock).toHaveBeenCalledTimes(1);
  });

  it('receives a hard load that was measured before it started (effect ordering on first paint)', () => {
    landedOn = '/dashboard';
    clock = 1_834;
    markNavigationUseful('/dashboard');
    expect(captureMock).not.toHaveBeenCalled();
    startPerfRum();
    expect(only()).toEqual({
      event: 'perf_page_useful',
      properties: { nav_kind: 'hard-load', route: '/dashboard', useful_ms: 1834 },
    });
  });

  it('does nothing until it is called, and the test seam really disconnects it', () => {
    navigate('/dashboard/orders', 1_000, 1_300);
    expect(captureMock).not.toHaveBeenCalled();

    resetMarks(); // drop the summary marks.ts is holding for a late listener
    startPerfRum();
    resetRum();
    navigate('/dashboard/books', 2_000, 2_300);
    expect(captureMock).not.toHaveBeenCalled();
  });
});

/**
 * The owner's rule, as an attack. Every value below is something a component
 * near this code really holds: a signed photo URL, a customer's email, a SKU,
 * the address bar of an item page reached from a search. Each is pushed
 * through EVERY public entry point, in EVERY field, plus fields that do not
 * exist, and then the wire is searched for any trace of them.
 */
describe('HOSTILE INPUT: nothing a caller hands in can reach the wire', () => {
  const SIGNED_URL =
    'https://x.supabase.co/storage/v1/object/sign/item-images/a/b.jpg?token=SECRET';
  const EMAIL = 'jane.doe@example.com';
  const SKU = 'SKU-AB-1042';
  const ITEM_PATH = `/dashboard/inventory/${UUID}?q=search+term`;
  const HOSTILE = [
    SIGNED_URL,
    EMAIL,
    SKU,
    ITEM_PATH,
    `/dashboard/customers/${EMAIL}`,
    `/dashboard/inventory/${SKU}`,
    `/_next/image?url=${encodeURIComponent(SIGNED_URL)}&w=384&q=75`,
  ];
  const FORBIDDEN = [
    'SECRET',
    'token=',
    'supabase.co',
    '@',
    UUID,
    'search',
    '?',
    // Beyond the brief's list: the rest of what those values are made of.
    'jane',
    'example.com',
    SKU,
    '1042',
    'b.jpg',
    'http',
    '%',
  ];

  const ROUTE_TEMPLATE_RE = /^\/$|^(?:\/(?:[a-z][a-z-]{0,39}|\[id\]|\[token\]|\[unknown\]))+$/;
  const ENUMS = new Set([
    'optimizer',
    'storage-signed',
    'storage-transform',
    'storage-other',
    'same-origin',
    'external',
    'inline',
    'unknown',
    'thumb',
    'master',
    'not-an-item-photo',
    'good',
    'needs-improvement',
    'poor',
    'TTFB',
    'FCP',
    'LCP',
    'FID',
    'CLS',
    'INP',
    'soft-nav',
    'hard-load',
    'navigate',
    'reload',
    'back-forward',
    'back-forward-cache',
    'prerender',
    'restore',
  ]);
  const KEY_RE = /^[a-z][a-z0-9_]{0,59}$/;

  function attackWith(h: string): void {
    const extras = { url: h, src: h, name: h, title: h, sku: h, email: h, q: h, id: h, href: h };
    const as = <T>(value: unknown): T => value as T;

    reportNavigation(
      as<NavigationSummary>({
        ...extras,
        kind: 'soft-nav',
        fromRoute: h,
        toRoute: h,
        clickToFeedbackMs: h,
        clickToUsefulMs: 20,
        intentLeadMs: h,
      }),
    );
    reportNavigation(
      as<NavigationSummary>({ ...extras, kind: 'hard-load', route: h, usefulMs: 500 }),
    );
    reportNavigation(
      as<NavigationSummary>({ ...extras, kind: h, route: h, toRoute: h, usefulMs: 1 }),
    );

    reportWebVital({
      ...extras,
      name: 'LCP',
      value: 900,
      delta: h,
      rating: h,
      navigationType: h,
      entries: [{ url: h, element: { src: h, currentSrc: h }, name: h }],
      attribution: { url: h, target: h },
    } as Parameters<typeof reportWebVital>[0]);
    reportWebVital({ ...extras, name: h, value: 900 });

    reportImageError(
      h,
      as<ImageClass>({
        ...extras,
        delivery: h,
        upstream: h,
        variant: h,
        requestedWidth: h,
        requestedQuality: h,
        signed: h,
      }),
    );
    reportImages(
      h,
      as<ImageSample[]>([
        { ...extras, delivery: h, variant: h, durationMs: 40, sizesKnown: h, cacheHit: h },
        { ...extras, delivery: 'optimizer', variant: 'thumb', durationMs: h, sizesKnown: true },
        h,
      ]),
      as<boolean>(h),
    );
  }

  it('sends events, and none of them contains a trace of what it was fed', () => {
    // The address bar and the document's own URL are hostile too: both feed a fallback.
    goTo(ITEM_PATH);
    landedOn = ITEM_PATH;
    startPerfRum();

    for (const h of HOSTILE) attackWith(h);
    // And through the front door: a navigation measured by marks.ts to a hostile href.
    clock = 1_000;
    markNavigationClick(`/dashboard/inventory/${UUID}/edit?q=search+term#${EMAIL}`);
    clock = 1_250;
    goTo(`/dashboard/inventory/${UUID}/edit?q=search+term`);
    markNavigationUseful(`/dashboard/inventory/${UUID}/edit`);

    // Not vacuous: the attack produced real traffic, of every kind.
    expect(new Set(sent().map((s) => s.event))).toEqual(
      new Set([
        'perf_navigation',
        'perf_page_useful',
        'perf_web_vital',
        'perf_image_error',
        'perf_images',
      ]),
    );
    expect(captureMock.mock.calls.length).toBeGreaterThanOrEqual(HOSTILE.length * 5);

    for (const call of captureMock.mock.calls) {
      const wire = JSON.stringify(call);
      for (const forbidden of FORBIDDEN) {
        expect(wire, `"${forbidden}" reached capture()`).not.toContain(forbidden);
      }
    }
  });

  it('sends a FLAT bag: template routes, closed-vocabulary strings, rounded numbers, booleans', () => {
    goTo(ITEM_PATH);
    landedOn = ITEM_PATH;
    for (const h of HOSTILE) attackWith(h);

    expect(captureMock).toHaveBeenCalled();
    for (const { event, properties } of sent()) {
      expect(event).toMatch(/^perf_[a-z_]+$/);
      for (const [key, value] of Object.entries(properties)) {
        expect(key).toMatch(KEY_RE);
        if (typeof value === 'string') {
          if (key === 'route' || key === 'from_route') expect(value).toMatch(ROUTE_TEMPLATE_RE);
          else expect(ENUMS.has(value), `${key}=${value} is not in the vocabulary`).toBe(true);
        } else if (typeof value === 'number') {
          expect(Number.isFinite(value)).toBe(true);
          expect(value).toBeGreaterThanOrEqual(0);
          // Whole, except a CLS score, which keeps three decimals.
          expect(Math.round(value * 1000) / 1000).toBe(value);
        } else {
          expect(typeof value, `${key} is a ${typeof value}`).toBe('boolean');
        }
      }
    }
  });
});

/**
 * LAYER 2, on its own. Through the public API it is unreachable: every reporter
 * templates its routes and picks its strings from the vocabulary, so `emit`
 * never sees a bad value and deleting its checks fails no test above (tried).
 * It exists for the day layer 1 is wrong, so that day is simulated: the
 * templating function regresses to "return the input", for rum.ts AND for
 * marks.ts (`landingRoute`). `emit` must then drop the route rather than send it.
 */
describe('LAYER 2: emit refuses what a broken reporter hands it', () => {
  it('MUTATION GUARD: a raw path under a route key is dropped, and the rest of the event survives', async () => {
    vi.resetModules();
    vi.doMock('./route-template', () => ({ toRouteTemplate: (input: unknown) => input }));
    try {
      const broken = await import('./rum');
      const itemPath = `/dashboard/inventory/${UUID}?q=search+term`;
      const signedUrl =
        'https://x.supabase.co/storage/v1/object/sign/item-images/a/b.jpg?token=SECRET';
      goTo(itemPath);
      landedOn = itemPath;

      broken.reportNavigation({
        kind: 'soft-nav',
        fromRoute: itemPath,
        toRoute: signedUrl,
        clickToFeedbackMs: 10,
        clickToUsefulMs: 20,
        intentLeadMs: null,
      });
      broken.reportNavigation({ kind: 'hard-load', route: 'jane.doe@example.com', usefulMs: 500 });
      broken.reportWebVital({ name: 'LCP', value: 900, delta: 900, rating: 'good' });
      broken.reportImageError(itemPath, THUMB_VIA_OPTIMIZER);
      broken.reportImages(signedUrl, [sample()]);

      expect(captureMock).toHaveBeenCalledTimes(5);
      for (const { properties } of sent()) {
        expect(properties).not.toHaveProperty('route');
        expect(properties).not.toHaveProperty('from_route');
      }
      const wire = JSON.stringify(captureMock.mock.calls);
      for (const forbidden of [
        'SECRET',
        'token=',
        'supabase.co',
        '@',
        UUID,
        'search',
        '?',
        'http',
      ]) {
        expect(wire, `"${forbidden}" reached capture()`).not.toContain(forbidden);
      }
      // The measurement itself is still worth having.
      expect(sent()[0]?.properties).toEqual({
        nav_kind: 'soft-nav',
        click_to_feedback_ms: 10,
        click_to_useful_ms: 20,
      });
    } finally {
      vi.doUnmock('./route-template');
      vi.resetModules();
    }
  });

  it('a route template is only believed under a route key, and a vocabulary word only as a value', async () => {
    // The one place a KEY is computed: `images_<delivery>_<variant>`. A sample
    // whose class is not in the vocabulary must not mint a key of its own.
    reportImages('/dashboard', [
      sample({ delivery: '/dashboard/inventory' as ImageSample['delivery'] }),
      sample({ variant: 'sku_ab_1042' as ImageSample['variant'] }),
    ]);
    const keys = Object.keys(only().properties).filter((key) => key.startsWith('images_'));
    expect(keys.sort()).toEqual(['images_optimizer_not_an_item_photo', 'images_unknown_thumb']);
  });
});
