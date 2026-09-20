import { act, render } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * This component is the one place in the performance code that HOLDS raw image
 * URLs (30-day signed credentials whose path names an organization and an
 * item), so the suite is about what it lets go of: a class, a duration, a
 * count. rum.ts and image-class.ts are REAL and only `capture` is a spy, so
 * every assertion is about the payload that would actually leave the browser.
 * `classifyImageUrl` is wrapped (not replaced) to count the URL parses, which
 * is how "bounded work per view" is measured.
 */

const { pathnameRef, captureMock, classifySpy } = vi.hoisted(() => ({
  pathnameRef: { value: '/dashboard/inventory' as string | null },
  captureMock: vi.fn(),
  classifySpy: vi.fn(),
}));

vi.mock('next/navigation', () => ({ usePathname: () => pathnameRef.value }));
vi.mock('@/lib/analytics', () => ({ capture: captureMock }));
vi.mock('@/lib/perf/image-class', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/perf/image-class')>();
  return {
    ...actual,
    classifyImageUrl: (rawUrl: string, pageOrigin: string) => {
      classifySpy();
      return actual.classifyImageUrl(rawUrl, pageOrigin);
    },
  };
});

import { __resetForTests as resetMarks } from '@/lib/perf/marks';
import { MAX_IMAGE_SAMPLES, __resetForTests as resetRum } from '@/lib/perf/rum';

import { ImageDiagnostics, __resetImageDiagnosticsForTests } from './image-diagnostics';

const ORG = '7d9f2b1c-5a3e-4f60-8b7a-1c2d3e4f5a6b';
const ITEM = '3f2c1a9e-7b4d-4c1e-9a2f-0d5e6f7a8b9c';
const FILE = 'c0ffee00-1111-4222-8333-444455556666';
const THUMB_URL = `https://x.supabase.co/storage/v1/object/sign/item-images/${ORG}/items/${ITEM}/${FILE}-thumb.webp?token=SECRET`;
const MASTER_URL = `https://x.supabase.co/storage/v1/object/sign/item-images/${ORG}/items/${ITEM}/${FILE}.jpg?token=SECRET`;
/** Every identifying piece of those URLs. The CLASS words (storage, signed, thumb) are allowed out. */
const URL_PIECES = [
  'SECRET',
  'token',
  'supabase',
  'x.supabase.co',
  ORG,
  ITEM,
  FILE,
  'webp',
  'jpg',
  'http',
  '?',
  '=',
];

interface FakeEntry {
  initiatorType: string;
  name: string;
  startTime: number;
  duration: number;
  transferSize: number;
  decodedBodySize: number;
}

/** The one observer the component creates, captured so the test can play the browser. */
let observers: FakeObserver[] = [];

class FakeObserver {
  disconnected = false;
  observedWith: unknown = null;
  constructor(private readonly callback: (list: { getEntries: () => FakeEntry[] }) => void) {
    observers.push(this);
  }
  observe(options: unknown): void {
    this.observedWith = options;
  }
  disconnect(): void {
    this.disconnected = true;
  }
  deliver(entries: FakeEntry[]): void {
    if (this.disconnected) return;
    this.callback({ getEntries: () => entries });
  }
}

let clock = 0;
let visibility: DocumentVisibilityState = 'visible';
let landedOn: string | null = null;

function goTo(path: string): void {
  window.history.replaceState(null, '', path);
  pathnameRef.value = path.split('?')[0] ?? path;
}

function setVisibility(state: DocumentVisibilityState): void {
  visibility = state;
  document.dispatchEvent(new Event('visibilitychange'));
}

function imgEntry(over: Partial<FakeEntry> = {}): FakeEntry {
  return {
    initiatorType: 'img',
    name: THUMB_URL,
    startTime: clock,
    duration: 80,
    transferSize: 4_000,
    decodedBodySize: 12_000,
    ...over,
  };
}

function brokenImage(src: string): HTMLImageElement {
  const img = document.createElement('img');
  img.setAttribute('src', src);
  img.setAttribute('alt', 'Acme Widget (SKU AB-1042)');
  document.body.appendChild(img);
  // A resource error: does not bubble, which is why the component listens in the capture phase.
  img.dispatchEvent(new Event('error'));
  return img;
}

function sent(event: string): Array<Record<string, unknown>> {
  return captureMock.mock.calls
    .filter(([name]) => name === event)
    .map(([, properties]) => properties as Record<string, unknown>);
}

function expectNoUrlOnTheWire(): void {
  const wire = JSON.stringify(captureMock.mock.calls);
  for (const piece of URL_PIECES) {
    expect(wire, `"${piece}" reached capture()`).not.toContain(piece);
  }
  expect(wire).not.toContain('Acme');
  expect(wire).not.toContain('AB-1042');
}

beforeEach(() => {
  resetRum();
  resetMarks();
  __resetImageDiagnosticsForTests();
  captureMock.mockReset();
  classifySpy.mockReset();
  observers = [];
  clock = 5_000;
  visibility = 'visible';
  landedOn = null;
  goTo('/dashboard/inventory');
  vi.stubGlobal('PerformanceObserver', FakeObserver);
  // setup.ts restores every spy after each test, so they are re-made here.
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  const realGetEntriesByType = performance.getEntriesByType.bind(performance);
  vi.spyOn(performance, 'getEntriesByType').mockImplementation((type: string) => {
    if (type !== 'navigation') return realGetEntriesByType(type);
    return landedOn === null
      ? []
      : ([{ name: `http://localhost:3000${landedOn}` }] as unknown as PerformanceEntryList);
  });
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibility,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('<ImageDiagnostics /> load failures', () => {
  it('reports the CLASS of a broken <img> and the route template, and no part of its URL', () => {
    goTo(`/dashboard/inventory/${ITEM}?q=acme`);
    render(<ImageDiagnostics />);
    brokenImage(THUMB_URL);

    expect(captureMock).toHaveBeenCalledTimes(1);
    expect(captureMock).toHaveBeenCalledWith('perf_image_error', {
      route: '/dashboard/inventory/[id]',
      delivery: 'storage-signed',
      variant: 'thumb',
      signed: true,
    });
    expectNoUrlOnTheWire();
  });

  it('classifies what the optimizer was asked for, without the URL it wraps', () => {
    render(<ImageDiagnostics />);
    brokenImage(`/_next/image?url=${encodeURIComponent(MASTER_URL)}&w=384&q=75`);

    expect(sent('perf_image_error')).toEqual([
      {
        route: '/dashboard/inventory',
        delivery: 'optimizer',
        upstream: 'storage-signed',
        variant: 'master',
        requested_width: 384,
        requested_quality: 75,
        signed: true,
      },
    ]);
    expectNoUrlOnTheWire();
  });

  it('ignores every error that is not an <img>: scripts, stylesheets, runtime errors on window', () => {
    render(<ImageDiagnostics />);

    const script = document.createElement('script');
    script.setAttribute('data-src', THUMB_URL);
    document.body.appendChild(script);
    script.dispatchEvent(new Event('error'));

    const link = document.createElement('link');
    document.body.appendChild(link);
    link.dispatchEvent(new Event('error'));

    const video = document.createElement('video');
    document.body.appendChild(video);
    video.dispatchEvent(new Event('error'));

    window.dispatchEvent(new Event('error'));

    expect(captureMock).not.toHaveBeenCalled();
    expect(classifySpy).not.toHaveBeenCalled();
  });

  it('a page of broken thumbnails is one finding: 20 events per view, then silence, then a fresh view', () => {
    const { rerender } = render(<ImageDiagnostics />);
    for (let i = 0; i < 45; i += 1) brokenImage(THUMB_URL);
    expect(sent('perf_image_error')).toHaveLength(20);
    // Bounded WORK, not only bounded events: past the cap the URL is not even parsed.
    expect(classifySpy).toHaveBeenCalledTimes(20);

    goTo('/dashboard/books');
    rerender(<ImageDiagnostics />);
    brokenImage(THUMB_URL);
    expect(sent('perf_image_error')).toHaveLength(21);
    expect(sent('perf_image_error')[20]?.route).toBe('/dashboard/books');
  });

  it('the cap holds with no route view at all (no pathname), where it used to have no ceiling', () => {
    pathnameRef.value = null;
    render(<ImageDiagnostics />);
    for (let i = 0; i < 45; i += 1) brokenImage(THUMB_URL);
    expect(sent('perf_image_error')).toHaveLength(20);
    // With no view, the route is the address bar's template.
    expect(sent('perf_image_error')[0]?.route).toBe('/dashboard/inventory');
  });

  it('removes its listeners and disconnects its observer on unmount', () => {
    const added = vi.spyOn(window, 'addEventListener');
    const removed = vi.spyOn(window, 'removeEventListener');
    const docRemoved = vi.spyOn(document, 'removeEventListener');

    const { unmount } = render(<ImageDiagnostics />);
    const errorListener = added.mock.calls.find(([type]) => type === 'error');
    expect(errorListener).toBeDefined();
    expect(errorListener?.[2]).toBe(true); // capture phase
    expect(observers).toHaveLength(1);
    expect(observers[0]?.observedWith).toEqual({ type: 'resource', buffered: true });

    unmount();

    // The SAME function, with the SAME capture flag, or the browser keeps it.
    expect(removed).toHaveBeenCalledWith('error', errorListener?.[1], true);
    expect(docRemoved.mock.calls.some(([type]) => type === 'visibilitychange')).toBe(true);
    expect(observers[0]?.disconnected).toBe(true);

    brokenImage(THUMB_URL);
    setVisibility('hidden');
    expect(captureMock).not.toHaveBeenCalled();
  });
});

describe('<ImageDiagnostics /> load timings', () => {
  it('sends ONE perf_images event for a route view, when the route changes', () => {
    const { rerender } = render(<ImageDiagnostics />);
    const observer = observers[0] as FakeObserver;

    clock = 5_100;
    observer.deliver([
      imgEntry({ duration: 40.4, transferSize: 0 }), // browser cache
      imgEntry({ duration: 120.6 }),
      imgEntry({ name: MASTER_URL, duration: 900.2, transferSize: 0, decodedBodySize: 0 }), // no TAO
      imgEntry({ initiatorType: 'script', name: '/_next/static/chunks/main.js' }),
      imgEntry({ initiatorType: 'fetch', name: `/api/items/search?q=acme` }),
    ]);
    expect(captureMock).not.toHaveBeenCalled(); // nothing is sent per image

    goTo(`/dashboard/inventory/${ITEM}`);
    rerender(<ImageDiagnostics />);

    expect(sent('perf_images')).toEqual([
      {
        route: '/dashboard/inventory',
        image_count: 3,
        capped: false,
        images_storage_signed_thumb: 2,
        images_storage_signed_master: 1,
        duration_p50_ms: 121,
        duration_max_ms: 900,
        sizes_known_count: 2,
        cache_hit_count: 1,
      },
    ]);
    expectNoUrlOnTheWire();
  });

  it('at most one event per view: hidden flushes it, and later entries, hides and the unmount add nothing', () => {
    const { unmount } = render(<ImageDiagnostics />);
    const observer = observers[0] as FakeObserver;

    observer.deliver([imgEntry(), imgEntry()]);
    setVisibility('hidden');
    expect(sent('perf_images')).toHaveLength(1);
    expect(sent('perf_images')[0]?.image_count).toBe(2);

    // Back in the tab, scrolling the same list: a second, partial batch would
    // be double-counted against the first, so the closed view takes no more.
    setVisibility('visible');
    observer.deliver([imgEntry(), imgEntry(), imgEntry()]);
    setVisibility('hidden');
    setVisibility('visible');
    unmount();

    expect(sent('perf_images')).toHaveLength(1);
  });

  it('a view hidden before its first photo arrived stays open, and still sends only one event', () => {
    const { unmount } = render(<ImageDiagnostics />);
    const observer = observers[0] as FakeObserver;

    setVisibility('hidden'); // nothing to send: not an event, and not a closed view
    setVisibility('visible');
    expect(captureMock).not.toHaveBeenCalled();

    observer.deliver([imgEntry()]);
    unmount();
    expect(sent('perf_images')).toHaveLength(1);
    expect(sent('perf_images')[0]?.image_count).toBe(1);
  });

  it('each route view gets its own event, under its own route', () => {
    const { rerender, unmount } = render(<ImageDiagnostics />);
    const observer = observers[0] as FakeObserver;

    observer.deliver([imgEntry()]);
    clock = 6_000;
    goTo(`/dashboard/inventory/${ITEM}`);
    rerender(<ImageDiagnostics />);
    // The same pathname re-rendering (a filter, a parent update) is NOT a new view.
    rerender(<ImageDiagnostics />);
    observer.deliver([imgEntry({ name: MASTER_URL }), imgEntry({ name: MASTER_URL })]);
    unmount();

    expect(sent('perf_images').map((p) => [p.route, p.image_count])).toEqual([
      ['/dashboard/inventory', 1],
      ['/dashboard/inventory/[id]', 2],
    ]);
  });

  it('files an image under the view it STARTED in: a late entry from the previous route is not ours', () => {
    const { rerender, unmount } = render(<ImageDiagnostics />);
    const observer = observers[0] as FakeObserver;

    clock = 6_000;
    goTo('/dashboard/books');
    rerender(<ImageDiagnostics />);
    observer.deliver([
      imgEntry({ startTime: 5_900 }), // requested by the inventory list, finished after the click
      imgEntry({ startTime: 6_050 }),
    ]);
    unmount();

    expect(sent('perf_images')).toEqual([
      expect.objectContaining({ route: '/dashboard/books', image_count: 1 }),
    ]);
  });

  it('a hard load claims the images that loaded before it mounted; a soft arrival does not', () => {
    landedOn = '/dashboard/inventory';
    const hard = render(<ImageDiagnostics />);
    (observers[0] as FakeObserver).deliver([imgEntry({ startTime: 300 })]); // `buffered: true` replay
    hard.unmount();
    expect(sent('perf_images')).toEqual([expect.objectContaining({ image_count: 1 })]);

    // A fresh document that landed on sign-in and soft-navigated here.
    captureMock.mockReset();
    __resetImageDiagnosticsForTests();
    landedOn = '/signin';
    const soft = render(<ImageDiagnostics />);
    (observers[1] as FakeObserver).deliver([imgEntry({ startTime: 300 })]); // the sign-in page's logo
    soft.unmount();
    expect(captureMock).not.toHaveBeenCalled();
  });

  it(`stops counting AND stops parsing at ${MAX_IMAGE_SAMPLES} images per view, and says so`, () => {
    const { unmount } = render(<ImageDiagnostics />);
    const observer = observers[0] as FakeObserver;

    observer.deliver(Array.from({ length: 200 }, () => imgEntry()));
    observer.deliver(Array.from({ length: 250 }, () => imgEntry()));
    expect(classifySpy).toHaveBeenCalledTimes(MAX_IMAGE_SAMPLES);
    unmount();

    expect(sent('perf_images')).toEqual([
      expect.objectContaining({
        image_count: MAX_IMAGE_SAMPLES,
        images_storage_signed_thumb: MAX_IMAGE_SAMPLES,
        capped: true,
      }),
    ]);
    expectNoUrlOnTheWire();
  });

  it('a view at exactly the cap is not reported as capped', () => {
    const { unmount } = render(<ImageDiagnostics />);
    (observers[0] as FakeObserver).deliver(
      Array.from({ length: MAX_IMAGE_SAMPLES }, () => imgEntry()),
    );
    unmount();
    expect(sent('perf_images')[0]).toEqual(
      expect.objectContaining({ image_count: MAX_IMAGE_SAMPLES, capped: false }),
    );
  });

  it('still reports load failures on an engine without PerformanceObserver', () => {
    vi.stubGlobal('PerformanceObserver', undefined);
    const { unmount } = render(<ImageDiagnostics />);
    brokenImage(THUMB_URL);
    expect(sent('perf_image_error')).toHaveLength(1);
    expect(() => unmount()).not.toThrow();
  });

  it('never sends anything from a share path, even if it were mounted there', () => {
    goTo('/r/abcdef0123456789');
    const { unmount } = render(<ImageDiagnostics />);
    brokenImage(THUMB_URL);
    (observers[0] as FakeObserver).deliver([imgEntry()]);
    unmount();
    expect(captureMock).not.toHaveBeenCalled();
  });
});

describe('<ImageDiagnostics /> on the server', () => {
  it('renders nothing and touches nothing: no listener, no observer, no capture', () => {
    const added = vi.spyOn(window, 'addEventListener');
    const docAdded = vi.spyOn(document, 'addEventListener');

    expect(renderToString(<ImageDiagnostics />)).toBe('');

    expect(added).not.toHaveBeenCalled();
    expect(docAdded).not.toHaveBeenCalled();
    expect(observers).toHaveLength(0);
    expect(captureMock).not.toHaveBeenCalled();
  });

  it('renders nothing in the browser either', () => {
    const { container } = render(<ImageDiagnostics />);
    expect(container.innerHTML).toBe('');
    // Flush effects before the test ends so the unmount path runs under act().
    act(() => undefined);
  });
});
