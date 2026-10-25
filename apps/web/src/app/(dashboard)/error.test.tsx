import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
 * It now loads the cookie-clearing sign-out route in this tab, as a full page
 * load (never a Next Link: prefetching that route would sign out). It is a
 * button, not a link: see the second block.
 */
describe('the dashboard error card', () => {
  const error = Object.assign(new Error('boom'), { digest: 'abc123' });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('"Sign out and back in" really signs out: a full load of the sign-out route', () => {
    const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {});
    render(<DashboardError error={error} reset={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: 'Sign out and back in' }));

    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith('/auth/session-ended');
  });

  it('keeps its words, the error id, Try again and Go to overview', () => {
    const reset = vi.fn();
    vi.spyOn(window.location, 'assign').mockImplementation(() => {});
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
 * record. So the control is a button: a link to the route could be opened in
 * another tab (a middle-click, the context menu), which signs the browser out
 * while this tab runs nothing and keeps its records.
 */
describe('the dashboard error card: Sign out and back in', () => {
  const error = Object.assign(new Error('boom'), { digest: 'abc123' });

  /** Spies on the page load, noting what this tab still held when it began. */
  function watchPageLoad() {
    const keysAtLoad: string[][] = [];
    const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {
      keysAtLoad.push(interruptedRunKeys());
    });
    return { assign, keysAtLoad };
  }

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    sessionStorage.clear();
  });

  it('removes every interrupted-run record in this tab before the sign-out route loads', () => {
    sessionStorage.clear();
    seedInterruptedRuns();
    const { assign, keysAtLoad } = watchPageLoad();
    render(<DashboardError error={error} reset={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: 'Sign out and back in' }));

    expect(assign).toHaveBeenCalledWith('/auth/session-ended');
    expect(keysAtLoad).toEqual([[]]);
    expect(sessionStorage.getItem(UNRELATED_KEY)).toBe('kept');
  });

  it('showing the card removes nothing: only the click does', () => {
    sessionStorage.clear();
    seedInterruptedRuns();
    render(<DashboardError error={error} reset={() => {}} />);

    expect(interruptedRunKeys()).toHaveLength(2);
  });

  it('nothing on the card can open the sign-out route in another tab', () => {
    render(<DashboardError error={error} reset={() => {}} />);

    expect(screen.getByRole('button', { name: 'Sign out and back in' })).toHaveAttribute(
      'type',
      'button',
    );
    expect(screen.queryByRole('link', { name: 'Sign out and back in' })).toBeNull();
    expect(document.querySelectorAll('a[href^="/auth/session-ended"]')).toHaveLength(0);
  });

  it('a browser that refuses storage still signs out', () => {
    const { assign } = watchPageLoad();
    render(<DashboardError error={error} reset={() => {}} />);
    const button = screen.getByRole('button', { name: 'Sign out and back in' });
    const restore = blockSessionStorage();
    try {
      expect(() => fireEvent.click(button)).not.toThrow();
    } finally {
      restore();
    }
    expect(assign).toHaveBeenCalledWith('/auth/session-ended');
  });
});
