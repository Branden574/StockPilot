import { render } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Mounted in the ROOT layout, so it renders on every route there is,
 * including the public share pages. Pinned here: it reports through rum.ts
 * (route templates, five scalars), it never subscribes on a share path, and
 * the callback it hands Next is ONE function for the life of the module: a
 * new identity makes `useReportWebVitals` re-subscribe, and a new subscriber
 * is replayed every metric so far (Next docs, use-report-web-vitals).
 *
 * `next/web-vitals` is mocked so the test owns the callback; rum.ts and
 * marks.ts are REAL and only `capture` is a spy, so what is asserted is the
 * payload that would actually leave the browser.
 */

const { pathnameRef, useReportWebVitals, captureMock } = vi.hoisted(() => ({
  pathnameRef: { value: '/dashboard' as string | null },
  useReportWebVitals: vi.fn(),
  captureMock: vi.fn(),
}));

vi.mock('next/navigation', () => ({ usePathname: () => pathnameRef.value }));
vi.mock('next/web-vitals', () => ({ useReportWebVitals }));
vi.mock('@/lib/analytics', () => ({ capture: captureMock }));

import {
  __resetForTests as resetMarks,
  markNavigationClick,
  markNavigationUseful,
} from '@/lib/perf/marks';
import { __resetForTests as resetRum } from '@/lib/perf/rum';

import { WebVitalsReporter } from './web-vitals-reporter';

type Callback = (metric: Record<string, unknown>) => void;

const UUID = '3f2c1a9e-7b4d-4c1e-9a2f-0d5e6f7a8b9c';
const SIGNED_URL = 'https://x.supabase.co/storage/v1/object/sign/item-images/a/b.jpg?token=SECRET';

let clock = 0;

function goTo(path: string): void {
  window.history.replaceState(null, '', path);
  pathnameRef.value = path.split('?')[0] ?? path;
}

function subscribedCallback(): Callback {
  expect(useReportWebVitals).toHaveBeenCalled();
  return useReportWebVitals.mock.calls[0]?.[0] as Callback;
}

beforeEach(() => {
  resetRum();
  resetMarks();
  useReportWebVitals.mockReset();
  captureMock.mockReset();
  clock = 0;
  goTo('/dashboard');
  // setup.ts restores every spy after each test, so they are re-made here.
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  // No Navigation Timing entry: rum.ts falls back to the address bar, which is
  // the hostile input these tests want it to meet.
  const realGetEntriesByType = performance.getEntriesByType.bind(performance);
  vi.spyOn(performance, 'getEntriesByType').mockImplementation((type: string) =>
    type === 'navigation' ? [] : realGetEntriesByType(type),
  );
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => 'visible',
  });
});

describe('<WebVitalsReporter />', () => {
  it('renders nothing', () => {
    const { container } = render(<WebVitalsReporter />);
    expect(container.innerHTML).toBe('');
  });

  it('reports a metric through rum.ts: the route TEMPLATE and scalars, never the entries', () => {
    goTo(`/dashboard/inventory/${UUID}?q=search+term`);
    render(<WebVitalsReporter />);

    subscribedCallback()({
      id: 'v4-1726850000000-1234567890123',
      name: 'LCP',
      value: 1834.6,
      delta: 1834.6,
      rating: 'good',
      navigationType: 'navigate',
      // What the real metric carries: the LCP element of an item page is its photo.
      entries: [{ url: SIGNED_URL, element: { currentSrc: SIGNED_URL } }],
    });

    expect(captureMock).toHaveBeenCalledTimes(1);
    expect(captureMock).toHaveBeenCalledWith('perf_web_vital', {
      metric: 'LCP',
      value: 1835,
      delta: 1835,
      rating: 'good',
      navigation_type: 'navigate',
      route: '/dashboard/inventory/[id]',
    });
    const wire = JSON.stringify(captureMock.mock.calls);
    for (const forbidden of ['SECRET', 'token=', 'supabase.co', UUID, 'search', '?', 'v4-']) {
      expect(wire).not.toContain(forbidden);
    }
  });

  it.each([['/r/abcdef0123456789'], ['/m/abcdef0123456789']])(
    'MUTATION GUARD: never subscribes on a share path (%s)',
    (sharePath) => {
      goTo(sharePath);
      const { container } = render(<WebVitalsReporter />);
      expect(useReportWebVitals).not.toHaveBeenCalled();
      expect(container.innerHTML).toBe('');

      // Nor is the navigation listener connected there. The address bar is
      // moved off the share path WITHOUT a render, so the silence below is the
      // missing listener and not rum.ts's own share-path refusal.
      window.history.replaceState(null, '', '/dashboard');
      clock = 1_000;
      markNavigationClick('/dashboard/orders');
      clock = 1_300;
      markNavigationUseful('/dashboard/orders');
      expect(captureMock).not.toHaveBeenCalled();
    },
  );

  it('a callback that outlives its route still sends nothing from a share path', () => {
    render(<WebVitalsReporter />);
    const callback = subscribedCallback();
    // web-vitals holds the function for the life of the document; CLS and INP
    // are finalized when the tab is hidden, wherever the person is by then.
    goTo('/r/abcdef0123456789');
    callback({ name: 'CLS', value: 0.12, delta: 0.12, rating: 'needs-improvement' });
    expect(captureMock).not.toHaveBeenCalled();
  });

  it('hands Next the SAME function on every render, on every route', () => {
    const { rerender } = render(<WebVitalsReporter />);
    for (const path of ['/dashboard/inventory', `/dashboard/inventory/${UUID}`, '/dashboard']) {
      goTo(path);
      rerender(<WebVitalsReporter />);
    }
    expect(useReportWebVitals.mock.calls.length).toBeGreaterThanOrEqual(4);
    const identities = new Set(useReportWebVitals.mock.calls.map(([callback]) => callback));
    expect(identities.size).toBe(1);
    expect(typeof subscribedCallback()).toBe('function');
  });

  it('keeps that identity across a share page and back, and across a remount', () => {
    const first = render(<WebVitalsReporter />);
    const callback = subscribedCallback();

    goTo('/r/abcdef0123456789');
    first.rerender(<WebVitalsReporter />);
    const callsOnSharePath = useReportWebVitals.mock.calls.length;
    first.rerender(<WebVitalsReporter />);
    expect(useReportWebVitals.mock.calls.length).toBe(callsOnSharePath);

    goTo('/dashboard');
    first.rerender(<WebVitalsReporter />);
    first.unmount();
    render(<WebVitalsReporter />);

    for (const [handedOver] of useReportWebVitals.mock.calls) expect(handedOver).toBe(callback);
  });

  it('connects the navigation marks to analytics once, however often it mounts', () => {
    const first = render(<WebVitalsReporter />);
    first.unmount();
    render(<WebVitalsReporter />);

    clock = 1_000;
    markNavigationClick(`/dashboard/inventory/${UUID}`);
    clock = 1_420;
    goTo(`/dashboard/inventory/${UUID}`);
    markNavigationUseful(`/dashboard/inventory/${UUID}`);

    expect(captureMock).toHaveBeenCalledTimes(1);
    expect(captureMock).toHaveBeenCalledWith('perf_navigation', {
      nav_kind: 'soft-nav',
      route: '/dashboard/inventory/[id]',
      from_route: '/dashboard',
      click_to_useful_ms: 420,
    });
  });

  it('a server render sends nothing and connects nothing', () => {
    expect(renderToString(<WebVitalsReporter />)).toBe('');
    clock = 1_000;
    markNavigationClick('/dashboard/orders');
    clock = 1_300;
    markNavigationUseful('/dashboard/orders');
    expect(captureMock).not.toHaveBeenCalled();
  });
});
