import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * IntentLink is the link for grids, lists and table rows. Its contract:
 *
 *   1. it NEVER lets next/link prefetch on its own (prefetch={false}), because
 *      a page of such links prefetching on render is the storm that cost the
 *      Reports page ~5 s on 2026-09-22 (26 requests for 13 tiles);
 *   2. the person's approach to ONE link still warms it through the app's one
 *      warm-up (useWarmRoute -> router.prefetch + the intent mark), so a click
 *      stays instant: pointer-down at once, hover and keyboard focus after a
 *      short dwell, cancelled if the pointer or focus leaves first.
 *
 * next/link is replaced by a recorder so the prefetch prop it RECEIVED can be
 * asserted; the router and the performance mark are spies.
 */

const { pathnameRef, prefetchMock, markNavigationIntent, linkProps } = vi.hoisted(() => ({
  pathnameRef: { value: '/dashboard/reports' },
  prefetchMock: vi.fn(),
  markNavigationIntent: vi.fn(),
  linkProps: [] as Array<Record<string, unknown>>,
}));

vi.mock('next/navigation', () => ({
  usePathname: () => pathnameRef.value,
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn(), prefetch: prefetchMock }),
}));

vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    prefetch,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
    prefetch?: boolean | null;
  } & Record<string, unknown>) => {
    linkProps.push({ href, prefetch });
    return (
      <a href={href} {...rest}>
        {children}
      </a>
    );
  },
}));

vi.mock('@/lib/perf/marks', () => ({ markNavigationIntent }));

import { INTENT_DWELL_MS, IntentLink } from './intent-link';

/** Spy calls as printable strings (a DOM event in a failed assertion can OOM the worker). */
function callsOf(spy: { mock: { calls: unknown[][] } }): string[][] {
  return spy.mock.calls.map((args) =>
    args.map((arg) => (typeof arg === 'string' ? arg : `<${typeof arg}>`)),
  );
}

const HREF = '/dashboard/reports/dead-stock';

function renderLink(props: Partial<React.ComponentProps<typeof IntentLink>> = {}) {
  render(
    <IntentLink href={HREF} {...props}>
      Dead stock
    </IntentLink>,
  );
  return screen.getByRole('link', { name: 'Dead stock' });
}

beforeEach(() => {
  vi.useFakeTimers();
  pathnameRef.value = '/dashboard/reports';
  prefetchMock.mockReset();
  markNavigationIntent.mockReset();
  linkProps.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('IntentLink: no viewport prefetch', () => {
  it('hands next/link prefetch={false} and the href unchanged', () => {
    const link = renderLink();
    expect(link.getAttribute('href')).toBe(HREF);
    expect(linkProps.length).toBeGreaterThan(0);
    for (const props of linkProps) expect(props).toEqual({ href: HREF, prefetch: false });
  });

  it('rendering alone warms nothing', () => {
    renderLink();
    act(() => {
      vi.advanceTimersByTime(10 * INTENT_DWELL_MS);
    });
    expect(callsOf(prefetchMock)).toEqual([]);
    expect(callsOf(markNavigationIntent)).toEqual([]);
  });
});

describe('IntentLink: warms on intent', () => {
  it('hover warms after the dwell, with the href string alone', () => {
    const link = renderLink();
    fireEvent.pointerEnter(link);
    act(() => {
      vi.advanceTimersByTime(INTENT_DWELL_MS - 1);
    });
    expect(callsOf(prefetchMock)).toEqual([]);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(callsOf(prefetchMock)).toEqual([[HREF]]);
    expect(callsOf(markNavigationIntent)).toEqual([[HREF]]);
  });

  it('keyboard focus warms after the dwell', () => {
    const link = renderLink();
    fireEvent.focus(link);
    act(() => {
      vi.advanceTimersByTime(INTENT_DWELL_MS);
    });
    expect(callsOf(prefetchMock)).toEqual([[HREF]]);
    expect(callsOf(markNavigationIntent)).toEqual([[HREF]]);
  });

  it('pointer-down (mouse, pen or touch) warms at once, no dwell', () => {
    const link = renderLink();
    fireEvent.pointerDown(link, { pointerType: 'touch' });
    expect(callsOf(prefetchMock)).toEqual([[HREF]]);
    expect(callsOf(markNavigationIntent)).toEqual([[HREF]]);
  });

  it('a pointer that passes over the link without stopping warms nothing', () => {
    const link = renderLink();
    fireEvent.pointerEnter(link);
    act(() => {
      vi.advanceTimersByTime(INTENT_DWELL_MS - 20);
    });
    fireEvent.pointerLeave(link);
    act(() => {
      vi.advanceTimersByTime(10 * INTENT_DWELL_MS);
    });
    expect(callsOf(prefetchMock)).toEqual([]);
    expect(callsOf(markNavigationIntent)).toEqual([]);
  });

  it('focus that moves on before the dwell (Tab held down a list) warms nothing', () => {
    const link = renderLink();
    fireEvent.focus(link);
    act(() => {
      vi.advanceTimersByTime(INTENT_DWELL_MS - 20);
    });
    fireEvent.blur(link);
    act(() => {
      vi.advanceTimersByTime(10 * INTENT_DWELL_MS);
    });
    expect(callsOf(prefetchMock)).toEqual([]);
  });

  it('a link that unmounts mid-dwell never warms', () => {
    const { unmount } = render(<IntentLink href={HREF}>Dead stock</IntentLink>);
    fireEvent.pointerEnter(screen.getByRole('link', { name: 'Dead stock' }));
    unmount();
    act(() => {
      vi.advanceTimersByTime(10 * INTENT_DWELL_MS);
    });
    expect(callsOf(prefetchMock)).toEqual([]);
  });

  it('the page already on screen is neither warmed nor marked', () => {
    pathnameRef.value = HREF;
    const link = renderLink();
    fireEvent.pointerEnter(link);
    fireEvent.focus(link);
    fireEvent.pointerDown(link);
    act(() => {
      vi.advanceTimersByTime(10 * INTENT_DWELL_MS);
    });
    expect(callsOf(prefetchMock)).toEqual([]);
    expect(callsOf(markNavigationIntent)).toEqual([]);
  });

  it("keeps the caller's own handlers (Radix asChild items, tab onClick)", () => {
    const onPointerEnter = vi.fn();
    const onPointerLeave = vi.fn();
    const onPointerDown = vi.fn();
    const onFocus = vi.fn();
    const onBlur = vi.fn();
    const onClick = vi.fn();
    const link = renderLink({ onPointerEnter, onPointerLeave, onPointerDown, onFocus, onBlur, onClick });
    fireEvent.pointerEnter(link);
    fireEvent.pointerLeave(link);
    fireEvent.pointerDown(link);
    fireEvent.focus(link);
    fireEvent.blur(link);
    fireEvent.click(link);
    for (const spy of [onPointerEnter, onPointerLeave, onPointerDown, onFocus, onBlur, onClick]) {
      expect(spy).toHaveBeenCalledTimes(1);
    }
    // ...and still warms (the pointer-down).
    expect(callsOf(prefetchMock)).toEqual([[HREF]]);
  });
});
