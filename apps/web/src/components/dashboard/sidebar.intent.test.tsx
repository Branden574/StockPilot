import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `warmRoute(href, intent = true)` has two kinds of caller and the performance
 * mark (lib/perf/marks.ts) must tell them apart:
 *
 *   - a PERSON approaching a link (hover, focus, pointer-down): intent, marked;
 *   - the staggered top-5 warm-up TIMER: not intent. Marking it would credit
 *     every early click on those routes with a head start nobody's pointer gave.
 *
 * The default of `true` is the trap this file guards: a handler wired as
 * `onPointerEnter={warmRoute}` would receive the EVENT as `href` and whatever
 * React passes next as `intent`. Every caller goes through an arrow that
 * passes the href string alone, and what reaches marks.ts is asserted to be
 * exactly that string and nothing else.
 */

const { pathnameRef, prefetchMock, markNavigationIntent } = vi.hoisted(() => ({
  pathnameRef: { value: '/dashboard' },
  prefetchMock: vi.fn(),
  markNavigationIntent: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => pathnameRef.value,
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn(), prefetch: prefetchMock }),
}));

vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    prefetch: _prefetch,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
    prefetch?: boolean;
  } & Record<string, unknown>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
  useLinkStatus: () => ({ pending: false }),
}));

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/server/actions/org-switcher', () => ({
  switchOrganizationAction: vi.fn(async () => ({ ok: true as const, data: null })),
}));
// Only the intent mark is replaced; NavLinkPending's feedback mark is inert here (never pending).
vi.mock('@/lib/perf/marks', () => ({ markNavigationIntent, markNavigationFeedback: vi.fn() }));

import { Sidebar } from './sidebar';

/**
 * What a spy was called with, reduced to something PRINTABLE: a string stays a
 * string, anything else becomes its type. Every assertion below goes through
 * this, never through the spy itself. With the mistake this file guards
 * against, the recorded argument is a DOM event with the whole document
 * hanging off it; a failed `toHaveBeenCalledWith` / `not.toHaveBeenCalled`
 * tries to pretty-print it and takes the test worker down with a heap OOM
 * instead of failing (seen while mutation-testing this file).
 */
function callsOf(spy: { mock: { calls: unknown[][] } }): string[][] {
  return spy.mock.calls.map((args) =>
    args.map((arg) => (typeof arg === 'string' ? arg : `<${typeof arg}>`)),
  );
}

const baseProps = {
  organizationId: 'o1',
  organizationName: 'Acme Co',
  organizationLogoUrl: null,
  memberships: [{ id: 'o1', name: 'Acme Co', logoUrl: null, role: 'admin' }],
  userName: 'Test User',
  userRole: 'Admin',
  role: 'admin' as const,
};

beforeEach(() => {
  vi.useFakeTimers();
  pathnameRef.value = '/dashboard';
  prefetchMock.mockReset();
  markNavigationIntent.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Sidebar route warming and the intent mark', () => {
  it('the staggered top-5 warm-up prefetches, and is NEVER marked as intent', () => {
    render(<Sidebar {...baseProps} />);
    act(() => {
      vi.advanceTimersByTime(5 * 150);
    });
    expect(callsOf(prefetchMock)).toEqual([
      ['/dashboard/inventory'],
      ['/dashboard/books'],
      ['/dashboard/orders'],
      ['/dashboard/movements'],
    ]);
    expect(callsOf(markNavigationIntent)).toEqual([]);
  });

  it.each([
    ['hover', (el: Element) => fireEvent.pointerEnter(el)],
    ['keyboard focus', (el: Element) => fireEvent.focus(el)],
    ['pointer-down', (el: Element) => fireEvent.pointerDown(el)],
  ])(
    '%s on a link marks intent with the href STRING alone, and prefetches it',
    (_label, approach) => {
      render(<Sidebar {...baseProps} />);
      approach(screen.getByRole('link', { name: /^Items$/i }));

      // One call, one argument, a string: not the event, not a second positional from React.
      expect(callsOf(markNavigationIntent)).toEqual([['/dashboard/inventory']]);
      expect(callsOf(prefetchMock)).toEqual([['/dashboard/inventory']]);
    },
  );

  it('the link to the page already on screen is neither marked nor prefetched', () => {
    render(<Sidebar {...baseProps} />);
    const overview = screen.getByRole('link', { name: /^Overview$/i });
    fireEvent.pointerEnter(overview);
    fireEvent.focus(overview);
    fireEvent.pointerDown(overview);
    expect(callsOf(markNavigationIntent)).toEqual([]);
    expect(callsOf(prefetchMock)).toEqual([]);
  });

  it('a hover DURING the warm-up is still intent, and the timers around it are still not', () => {
    render(<Sidebar {...baseProps} />);
    act(() => {
      vi.advanceTimersByTime(150); // inventory and books warmed by the timer
    });
    fireEvent.pointerEnter(screen.getByRole('link', { name: /^Orders$/i }));
    act(() => {
      vi.advanceTimersByTime(5 * 150);
    });
    expect(callsOf(markNavigationIntent)).toEqual([['/dashboard/orders']]);
  });
});
