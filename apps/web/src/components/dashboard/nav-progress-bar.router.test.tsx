import { act, fireEvent, render } from '@testing-library/react';
import * as React from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The bar and the router's own start events (lib/navigation/router-navigation.ts,
 * fed by src/instrumentation-client.ts). A path navigation started from code
 * gets the bar without a click; a navigation the router is still waiting on
 * keeps it past the 8 s failsafe; and neither source fabricates a performance
 * mark. Frames are a queue the test turns by hand, as in nav-progress-bar.test.tsx.
 */

const { pathnameRef, searchRef, markNavigationClick, markNavigationFeedback } = vi.hoisted(() => ({
  pathnameRef: { value: '/dashboard' },
  searchRef: { value: '' },
  markNavigationClick: vi.fn(),
  markNavigationFeedback: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => pathnameRef.value,
  useSearchParams: () => new URLSearchParams(searchRef.value),
}));
vi.mock('@/lib/perf/marks', () => ({ markNavigationClick, markNavigationFeedback }));

import {
  getRouterNavigation,
  noteCommittedLocation,
  recordRouterTransitionStart,
  resetRouterNavigationForTests,
} from '@/lib/navigation/router-navigation';

import { NavProgressBar } from './nav-progress-bar';

const ORIGIN = window.location.origin;

let frames = new Map<number, FrameRequestCallback>();
let nextHandle = 1;

function frame(): void {
  const due = [...frames.values()];
  frames = new Map();
  act(() => {
    for (const callback of due) callback(0);
  });
}

function bar(): Element | null {
  return document.querySelector('[aria-hidden="true"].fixed');
}

function climbing(): boolean {
  return bar()?.firstElementChild?.className.includes('nav-progress-climb') ?? false;
}

function completing(): boolean {
  return bar()?.firstElementChild?.className.includes('nav-progress-complete') ?? false;
}

function link(href: string): HTMLAnchorElement {
  const a = document.createElement('a');
  a.setAttribute('href', href);
  a.textContent = 'go';
  a.addEventListener('click', (event) => event.preventDefault());
  document.body.appendChild(a);
  return a;
}

function start(url: string, type: 'push' | 'replace' | 'traverse' = 'push') {
  act(() => {
    recordRouterTransitionStart(url, type);
  });
}

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  resetRouterNavigationForTests();
  markNavigationClick.mockReset();
  markNavigationFeedback.mockReset();
  frames = new Map();
  nextHandle = 1;
  pathnameRef.value = '/dashboard';
  searchRef.value = '';
  window.history.replaceState(null, '', '/dashboard');
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const handle = nextHandle;
    nextHandle += 1;
    frames.set(handle, callback);
    return handle;
  });
  vi.stubGlobal('cancelAnimationFrame', (handle: number) => {
    frames.delete(handle);
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('<NavProgressBar /> and router starts', () => {
  it('F1 a path navigation started from code starts the bar, and marks nothing', () => {
    render(<NavProgressBar />);
    start('/dashboard/orders/abc');
    expect(climbing()).toBe(true);
    frame();
    frame();
    expect(markNavigationClick).not.toHaveBeenCalled();
    expect(markNavigationFeedback).not.toHaveBeenCalled();
  });

  it('F2 a Link click and the router start it causes: one click mark, one feedback mark', () => {
    render(<NavProgressBar />);
    const a = link('/dashboard/orders');
    // next/link's onClick runs after the capture listener, in the same task.
    a.addEventListener('click', () => recordRouterTransitionStart('/dashboard/orders', 'push'));
    act(() => {
      fireEvent.click(a);
    });
    expect(climbing()).toBe(true);
    expect(markNavigationClick).toHaveBeenCalledTimes(1);
    frame();
    frame();
    expect(markNavigationFeedback).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a query-only start (code-started filter change)', '/dashboard?range=30d', 'push'],
    ['Back/Forward', `${ORIGIN}/dashboard/orders`, 'traverse'],
  ] as const)('F3 %s does not start the bar', (_label, url, type) => {
    render(<NavProgressBar />);
    // What the shell's PendingRouteFrame writes, so a Back/Forward is placed.
    noteCommittedLocation('/dashboard');
    if (type === 'traverse') window.history.replaceState(null, '', '/dashboard/orders');
    start(url, type);
    expect(getRouterNavigation()?.kind).toBe(type === 'traverse' ? 'path' : 'query');
    expect(bar()).toBeNull();
  });

  it('F4 a same-URL start while climbing completes the bar (Next discarded what it followed)', () => {
    render(<NavProgressBar />);
    start('/dashboard/orders');
    expect(climbing()).toBe(true);
    start('/dashboard');
    expect(completing()).toBe(true);
  });

  it('F5 keeps climbing past 8 s while the router still waits on the path navigation, idle at 30 s', () => {
    render(<NavProgressBar />);
    start('/dashboard/orders');
    advance(8_001);
    expect(climbing()).toBe(true);
    advance(20_000);
    expect(climbing()).toBe(true);
    advance(1_999);
    expect(bar()).toBeNull();
  });

  it('F6 a plain <a> the router never starts (a CSV download link) still gives up at 8 s', () => {
    render(<NavProgressBar />);
    fireEvent.click(link('/api/reports/stock.csv'));
    expect(climbing()).toBe(true);
    advance(8_001);
    expect(bar()).toBeNull();
  });

  it('F7 a start recorded inside a suspended navigation transition paints the bar', async () => {
    // Run on React's real scheduler: act() cannot drive a transition that never
    // resolves (see pending-route-skeleton.test.tsx E9).
    const never = new Promise<never>(() => {});
    const suspend: { current: (p: Promise<never>) => void } = { current: () => {} };
    function Suspender() {
      const [promise, setPromise] = React.useState<Promise<never> | null>(null);
      React.useEffect(() => {
        suspend.current = setPromise;
      }, []);
      if (promise) React.use(promise);
      return null;
    }
    const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const previous = env.IS_REACT_ACT_ENVIRONMENT;
    env.IS_REACT_ACT_ENVIRONMENT = false;
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      flushSync(() =>
        root.render(
          <>
            <NavProgressBar />
            <React.Suspense fallback={null}>
              <Suspender />
            </React.Suspense>
          </>,
        ),
      );
      React.startTransition(() => {
        recordRouterTransitionStart('/dashboard/orders', 'push');
        suspend.current(never);
      });
      await vi.advanceTimersByTimeAsync(50);
      expect(climbing()).toBe(true);
    } finally {
      flushSync(() => root.unmount());
      container.remove();
      env.IS_REACT_ACT_ENVIRONMENT = previous;
    }
  });

  it('F8 a measured click on a bar already climbing for a code-started navigation still gets its feedback mark', () => {
    render(<NavProgressBar />);
    start('/dashboard/orders/abc');
    expect(climbing()).toBe(true);
    expect(frames.size).toBe(0);

    act(() => {
      fireEvent.click(link('/dashboard/inventory'));
    });
    expect(markNavigationClick).toHaveBeenCalledTimes(1);
    frame();
    frame();
    expect(markNavigationFeedback).toHaveBeenCalledTimes(1);
  });

  it('a page restored from the back-forward cache ends a climbing bar', () => {
    render(<NavProgressBar />);
    start('/dashboard/orders');
    act(() => {
      window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
    });
    expect(completing()).toBe(true);
  });
});
