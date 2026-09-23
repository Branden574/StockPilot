import { act, fireEvent, render, screen } from '@testing-library/react';
import * as React from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The late skeleton (PendingRouteFrame): a path navigation the ROUTER started
 * (lib/navigation/router-navigation.ts) that is still waiting after 400 ms
 * swaps the page for its destination's skeleton, and every way it can end.
 * Navigations are driven through the store exactly as Next's
 * onRouterTransitionStart would, never by a click: the frame listens to none.
 */

const { pathnameRef, searchRef } = vi.hoisted(() => ({
  pathnameRef: { value: '/dashboard/inventory' },
  searchRef: { value: '' },
}));

vi.mock('next/navigation', () => ({
  usePathname: () => pathnameRef.value,
  useSearchParams: () => new URLSearchParams(searchRef.value),
}));

import { onRouterTransitionStart } from '@/instrumentation-client';
import {
  getRouterNavigation,
  recordRouterTransitionStart,
  resetRouterNavigationForTests,
} from '@/lib/navigation/router-navigation';

import { PendingRouteFrame } from './pending-route-skeleton';

const ORIGIN = window.location.origin;

/** A page with state of its own, to prove the page is hidden, not unmounted. */
function Stateful() {
  const [count, setCount] = React.useState(0);
  return (
    <button type="button" onClick={() => setCount((c) => c + 1)}>
      count {count}
    </button>
  );
}

function Frame({ children = <Stateful /> }: { children?: React.ReactNode }) {
  return (
    <main id="main-content" tabIndex={-1}>
      <PendingRouteFrame>{children}</PendingRouteFrame>
    </main>
  );
}

function skeleton(): HTMLElement | null {
  return document.querySelector('[data-pending-route-skeleton]');
}

/** The table skeleton's row count (TablePageSkeleton rows=N), or null for another shape. */
function tableRows(): number | null {
  const el = skeleton();
  if (!el) return null;
  const rows = el.querySelectorAll('[style*="grid-template-columns"]').length;
  return rows > 0 ? rows : null;
}

function pageWrapper(): HTMLElement {
  const el = screen.getByRole('button', { name: /count/ }).parentElement;
  if (!el) throw new Error('no page wrapper');
  return el;
}

function main(): HTMLElement {
  const el = document.querySelector('main');
  if (!el) throw new Error('no main');
  return el;
}

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

function push(url: string) {
  act(() => {
    recordRouterTransitionStart(url, 'push');
  });
}

/** The router commits a new location. */
function commit(view: ReturnType<typeof render>, pathname: string, search = '', page?: React.ReactNode) {
  pathnameRef.value = pathname;
  searchRef.value = search;
  window.history.replaceState(null, '', search ? `${pathname}?${search}` : pathname);
  view.rerender(<Frame>{page}</Frame>);
}

/**
 * Renders `ui` into a root driven by React's own scheduler instead of act():
 * the fake timers run its tasks and an async advance lets its microtasks run.
 * The root is unmounted even when an assertion fails, so a stuck transition
 * cannot leak into the next test.
 */
async function withRealScheduler(ui: React.ReactNode, body: () => Promise<void>) {
  const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previous = env.IS_REACT_ACT_ENVIRONMENT;
  env.IS_REACT_ACT_ENVIRONMENT = false;
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    flushSync(() => root.render(ui));
    await body();
  } finally {
    flushSync(() => root.unmount());
    container.remove();
    env.IS_REACT_ACT_ENVIRONMENT = previous;
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  resetRouterNavigationForTests();
  pathnameRef.value = '/dashboard/inventory';
  searchRef.value = '';
  window.history.replaceState(null, '', '/dashboard/inventory');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('PendingRouteFrame', () => {
  it('E1 draws nothing before 400 ms and the destination skeleton at 400 ms; the page is hidden, not unmounted', () => {
    render(<Frame />);
    fireEvent.click(screen.getByRole('button', { name: 'count 0' }));
    fireEvent.click(screen.getByRole('button', { name: 'count 1' }));

    push('/dashboard/orders');
    advance(399);
    expect(skeleton()).toBeNull();
    expect(pageWrapper().className).toBe('contents');

    advance(1);
    expect(skeleton()).not.toBeNull();
    expect(tableRows()).toBe(8);
    expect(pageWrapper().className).toBe('hidden');

    // Abandoned (a same-URL start replaced it): the SAME page comes back, state intact.
    push('/dashboard/inventory');
    expect(skeleton()).toBeNull();
    expect(pageWrapper().className).toBe('contents');
    expect(screen.getByRole('button', { name: 'count 2' })).toBeInTheDocument();
  });

  it('E2 a navigation started from code (reported by the router, no click anywhere) gets it', () => {
    render(<Frame />);
    act(() => {
      onRouterTransitionStart('/dashboard/orders/abc', 'push');
    });
    advance(400);
    expect(tableRows()).toBe(8);
  });

  it('E3 a destination with a loading.tsx of its own never gets it (no double skeleton)', () => {
    render(<Frame />);
    push('/dashboard/suppliers');
    advance(5_000);
    expect(skeleton()).toBeNull();
    expect(pageWrapper().className).toBe('contents');
  });

  it('E4 the new page shows in the SAME render that commits it, never behind the skeleton', () => {
    const seen: Array<{ skeleton: boolean; hidden: boolean }> = [];
    function NewPage() {
      const ref = React.useRef<HTMLSpanElement>(null);
      React.useLayoutEffect(() => {
        seen.push({
          skeleton: skeleton() !== null,
          hidden: ref.current?.parentElement?.className === 'hidden',
        });
      }, []);
      return <span ref={ref}>orders</span>;
    }

    const view = render(<Frame />);
    push('/dashboard/orders');
    advance(400);
    expect(skeleton()).not.toBeNull();

    commit(view, '/dashboard/orders', '', <NewPage />);
    expect(seen).toEqual([{ skeleton: false, hidden: false }]);
    expect(skeleton()).toBeNull();
  });

  it('E5 a query change on the same path (the hidden page\'s own replaceState) ends it', () => {
    const view = render(<Frame />);
    push('/dashboard/orders');
    advance(400);
    expect(skeleton()).not.toBeNull();

    commit(view, '/dashboard/inventory', 'view=expected', <Stateful />);
    expect(skeleton()).toBeNull();
    expect(pageWrapper().className).toBe('contents');
  });

  it.each([
    ['a same-URL start', '/dashboard/inventory'],
    ['a query-only start', '/dashboard/inventory?page=2'],
  ])('E6 %s supersedes it (Next discarded the path navigation)', (_label, url) => {
    render(<Frame />);
    push('/dashboard/orders');
    advance(400);
    expect(skeleton()).not.toBeNull();

    push(url);
    expect(skeleton()).toBeNull();
    expect(pageWrapper().className).toBe('contents');
    advance(5_000);
    expect(skeleton()).toBeNull();
  });

  it('E7 a newer path start while the skeleton is up switches target with no gap', () => {
    render(<Frame />);
    push('/dashboard/books');
    advance(400);
    expect(tableRows()).toBe(10);

    push('/dashboard/orders');
    expect(tableRows()).toBe(8);
    expect(pageWrapper().className).toBe('hidden');

    // A target with its own loading.tsx: the generic page shape, still no gap.
    push('/dashboard/suppliers');
    expect(skeleton()).not.toBeNull();
    expect(tableRows()).toBeNull();
    advance(400);
    expect(skeleton()).not.toBeNull();
  });

  it('E8 waits past 8 s, ends at 30 s, and brings the old page back where it was scrolled', () => {
    render(<Frame />);
    main().scrollTop = 300;
    push('/dashboard/orders');
    advance(400);
    expect(skeleton()).not.toBeNull();

    advance(19_600); // 20 s
    expect(skeleton()).not.toBeNull();
    advance(9_999);
    expect(skeleton()).not.toBeNull();
    advance(1); // 30 s
    expect(skeleton()).toBeNull();
    expect(pageWrapper().className).toBe('contents');
    expect(main().scrollTop).toBe(300);
  });

  it('E9 a start recorded inside a suspended navigation transition still shows it', async () => {
    // Next records the start inside the startTransition that renders the next
    // page, and that transition stays suspended until the server answers. The
    // skeleton's update must not join it. Run on React's real scheduler: act()
    // cannot drive a transition that never resolves.
    const never = new Promise<never>(() => {});
    const suspend: { current: (p: Promise<never>) => void } = { current: () => {} };
    function Suspender() {
      const [promise, setPromise] = React.useState<Promise<never> | null>(null);
      React.useEffect(() => {
        suspend.current = setPromise;
      }, []);
      if (promise) React.use(promise);
      return <Stateful />;
    }

    await withRealScheduler(
      <Frame>
        <React.Suspense fallback={<p>fallback</p>}>
          <Suspender />
        </React.Suspense>
      </Frame>,
      async () => {
        React.startTransition(() => {
          recordRouterTransitionStart('/dashboard/orders', 'push');
          suspend.current(never);
        });
        await vi.advanceTimersByTimeAsync(400);
        expect(skeleton()).not.toBeNull();
        // The transition is still pending: the page it was rendering never showed.
        expect(screen.queryByText('fallback')).toBeNull();
      },
    );
  });

  it('E10 Back/Forward that has not committed after 400 ms gets it, placed by the committed page', () => {
    pathnameRef.value = '/dashboard/inventory/abc';
    window.history.replaceState(null, '', '/dashboard/inventory/abc');
    render(<Frame />);
    // popstate: the address bar has moved, the router has not committed yet.
    window.history.replaceState(null, '', '/dashboard/orders');
    act(() => {
      recordRouterTransitionStart(`${ORIGIN}/dashboard/orders`, 'traverse');
    });
    advance(400);
    expect(tableRows()).toBe(8);
  });

  it('E11 announces itself, hides the skeleton from assistive tech, and keeps focus off <body>', () => {
    render(<Frame />);
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('');

    screen.getByRole('button', { name: 'count 0' }).focus();
    push('/dashboard/orders');
    advance(400);
    expect(screen.getByRole('status')).toBe(status);
    expect(status).toHaveTextContent('Loading page');
    expect(skeleton()).toHaveAttribute('aria-hidden', 'true');
    expect(document.activeElement).toBe(main());

    push('/dashboard/inventory');
    expect(status).toHaveTextContent('');
  });

  it('E12 unmounting before 400 ms leaves no timer and forgets the committed page', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const view = render(<Frame />);
    push('/dashboard/orders');
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
    advance(1_000);
    expect(errors).not.toHaveBeenCalled();

    // Outside the shell a Back/Forward cannot be placed, so it starts nothing.
    act(() => {
      recordRouterTransitionStart(`${ORIGIN}/dashboard/books`, 'traverse');
    });
    expect(getRouterNavigation()?.kind).toBe('same');
    errors.mockRestore();
  });

  it.each([
    ['after its own skeleton was up', 400],
    ['when the redirecting page answered first', 150],
  ])('E14 a server redirect() into a mapped route shows the skeleton at once, %s', (_label, firstLeg) => {
    // `n i` without items:create: inventory/new redirects to the list. Next
    // commits the redirecting page (HandleRedirect renders nothing) and
    // replaces from its first effect, a millisecond later (lab, 2026-09-23).
    pathnameRef.value = '/dashboard';
    window.history.replaceState(null, '', '/dashboard');
    const view = render(<Frame />);
    push('/dashboard/inventory/new');
    advance(firstLeg);

    commit(view, '/dashboard/inventory/new', '', null);
    expect(skeleton()).toBeNull();
    act(() => {
      recordRouterTransitionStart('/dashboard/inventory', 'replace');
    });
    expect(tableRows()).toBe(10);
  });

  it('E15 a replace long after the page it leaves committed waits its 400 ms like any navigation', () => {
    render(<Frame />);
    advance(1_000);
    act(() => {
      recordRouterTransitionStart('/dashboard/orders', 'replace');
    });
    expect(skeleton()).toBeNull();
    advance(399);
    expect(skeleton()).toBeNull();
    advance(1);
    expect(tableRows()).toBe(8);
  });

  it('E16 the skeleton starts at its top however far the page was scrolled, and an abandoned page comes back where it was', () => {
    // A browser only clamps main's scroll position to the skeleton's height,
    // so a skeleton taller than the viewport would show its middle or bottom.
    render(<Frame />);
    main().scrollTop = 3000;
    push('/dashboard/orders');
    advance(400);
    expect(skeleton()).not.toBeNull();
    expect(main().scrollTop).toBe(0);

    push('/dashboard/inventory');
    expect(skeleton()).toBeNull();
    expect(main().scrollTop).toBe(3000);
  });

  it('E17 focus goes back to the control it was on when the same page comes back, unless the person moved it', () => {
    render(
      <>
        <Frame />
        <button type="button">outside</button>
      </>,
    );
    const row = screen.getByRole('button', { name: 'count 0' });
    row.focus();
    push('/dashboard/orders');
    advance(400);
    expect(document.activeElement).toBe(main());
    push('/dashboard/inventory');
    expect(document.activeElement).toBe(row);

    push('/dashboard/orders');
    advance(400);
    expect(document.activeElement).toBe(main());
    const outside = screen.getByRole('button', { name: 'outside' });
    outside.focus();
    push('/dashboard/inventory');
    expect(document.activeElement).toBe(outside);
  });

  it('E13 a dead navigation does not come back when a shallow pushState returns to the page it left', () => {
    // Inventory's instant-mode view chips: history.pushState, which Next applies
    // with a RESTORE (discarding the row click's navigation) and never reports.
    const view = render(<Frame />);
    push('/dashboard/inventory/abc');
    advance(100);
    commit(view, '/dashboard/inventory', 'view=expected', <Stateful />);
    commit(view, '/dashboard/inventory', '', <Stateful />);
    advance(5_000);
    expect(skeleton()).toBeNull();
    expect(pageWrapper().className).toBe('contents');
  });
});
