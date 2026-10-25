import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  blockSessionStorage,
  interruptedRunKeys,
  seedInterruptedRuns,
  UNRELATED_KEY,
} from '@/test/interrupted-run-fixtures';

vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => undefined) }));
// A Next <Link> renders as an <a> marked data-next-link, so the test can tell a
// plain anchor (a full page load, never prefetched) from a client link.
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} data-next-link="" {...rest}>
      {children}
    </a>
  ),
}));

import DashboardError from './error';

/**
 * CONFLICTS D1: "Sign out and back in" linked to /signin, which the proxy
 * sends a signed-in visitor straight back from, so it never signed anyone out.
 * It now loads the cookie-clearing sign-out route, as a plain anchor: a Next
 * Link would prefetch that route, and the prefetch alone would sign out.
 */
describe('the dashboard error card', () => {
  const error = Object.assign(new Error('boom'), { digest: 'abc123' });

  it('"Sign out and back in" really signs out: a full load of the sign-out route', () => {
    render(<DashboardError error={error} reset={() => {}} />);
    const signOut = screen.getByRole('link', { name: 'Sign out and back in' });
    expect(signOut).toHaveAttribute('href', '/auth/session-ended');
    expect(signOut).not.toHaveAttribute('data-next-link');
  });

  it('keeps its words, the error id, Try again and Go to overview', () => {
    const reset = vi.fn();
    render(<DashboardError error={error} reset={reset} />);
    expect(
      screen.getByRole('heading', { level: 1, name: 'Something broke loading this page' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/The page hit an error mid-render\. Try again, and if it keeps/),
    ).toBeInTheDocument();
    expect(screen.getByText('Error id: abc123')).toBeInTheDocument();
    expect(screen.getByText('boom')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to overview' })).toHaveAttribute(
      'href',
      '/dashboard',
    );
    screen.getByRole('button', { name: /Try again/ }).click();
    expect(reset).toHaveBeenCalledTimes(1);
  });
});

/**
 * "Sign out and back in" is a sign-out on purpose, so its click removes what
 * an interrupted run kept in this tab (lib/interrupted-run) before the page
 * leaves. The route cannot: sessionStorage is the browser's, and the same
 * route is where the dashboard sends an EXPIRED session, which keeps its
 * record.
 */
describe('the dashboard error card: Sign out and back in', () => {
  const error = Object.assign(new Error('boom'), { digest: 'abc123' });

  /** Clicks the link without happy-dom following it (the page leaving is not what is checked). */
  function clickWithoutLeaving(link: HTMLElement) {
    const stay = (e: Event) => e.preventDefault();
    document.addEventListener('click', stay);
    try {
      fireEvent.click(link);
    } finally {
      document.removeEventListener('click', stay);
    }
  }

  afterEach(() => sessionStorage.clear());

  it('removes every interrupted-run record in this tab as it is clicked', () => {
    sessionStorage.clear();
    seedInterruptedRuns();
    render(<DashboardError error={error} reset={() => {}} />);

    clickWithoutLeaving(screen.getByRole('link', { name: 'Sign out and back in' }));

    expect(interruptedRunKeys()).toEqual([]);
    expect(sessionStorage.getItem(UNRELATED_KEY)).toBe('kept');
  });

  it('showing the card removes nothing: only the click does', () => {
    sessionStorage.clear();
    seedInterruptedRuns();
    render(<DashboardError error={error} reset={() => {}} />);

    expect(interruptedRunKeys()).toHaveLength(2);
  });

  it('a browser that refuses storage still follows the link', () => {
    render(<DashboardError error={error} reset={() => {}} />);
    const link = screen.getByRole('link', { name: 'Sign out and back in' });
    let leftWithDefault = false;
    const watch = (e: Event) => {
      leftWithDefault = !e.defaultPrevented;
      e.preventDefault();
    };
    const restore = blockSessionStorage();
    document.addEventListener('click', watch);
    try {
      expect(() => fireEvent.click(link)).not.toThrow();
    } finally {
      document.removeEventListener('click', watch);
      restore();
    }
    expect(leftWithDefault).toBe(true);
  });
});
