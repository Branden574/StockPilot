import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  blockSessionStorage,
  fakeBroadcastChannels,
  interruptedRunKeys,
  seedInterruptedRuns,
  UNRELATED_KEY,
} from '@/test/interrupted-run-fixtures';

import { ACCESS_UNCHECKED_DIGEST } from '@/lib/known-error-states';
import { reportError } from '@/lib/error-reporter-core';

vi.mock('@/lib/error-reporter-core', () => ({ reportError: vi.fn(async () => undefined) }));
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

  // The boundary hands the card two functions (Next's error file convention):
  // `retry` asks the server for the page again and renders what comes back;
  // `reset` only clears the error and renders the same failed answer again.
  // A page that could not be read needs the first.
  it('Try again asks the server for the page again (retry), not only a re-render (reset)', () => {
    const retry = vi.fn();
    const reset = vi.fn();
    render(<DashboardError error={error} retry={retry} reset={reset} />);
    fireEvent.click(screen.getByRole('button', { name: /Try again/ }));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(reset).not.toHaveBeenCalled();
  });

  it('Try again falls back to reset when the boundary gives no retry', () => {
    const reset = vi.fn();
    render(<DashboardError error={error} reset={reset} />);
    fireEvent.click(screen.getByRole('button', { name: /Try again/ }));
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
    vi.unstubAllGlobals();
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

  it('tells the other tabs of this browser before the sign-out route loads: the route signs them out too', () => {
    // Review of round 2's repair: the route ends the session in every tab (the
    // session cookies are the browser's) and sends no revoke, so another tab
    // kept its records, and a run going there kept recording.
    const tabs = fakeBroadcastChannels();
    const otherTab = tabs.otherTab();
    const sentAtLoad: unknown[][] = [];
    vi.spyOn(window.location, 'assign').mockImplementation(() => {
      sentAtLoad.push(tabs.sent());
    });
    render(<DashboardError error={error} reset={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: 'Sign out and back in' }));

    expect(sentAtLoad).toEqual([[{ type: 'purge' }]]);
    tabs.deliver();
    expect(otherTab.received).toEqual([{ type: 'purge' }]);
  });

  it('showing the card removes nothing and tells no other tab: only the click does', () => {
    const tabs = fakeBroadcastChannels();
    sessionStorage.clear();
    seedInterruptedRuns();
    render(<DashboardError error={error} reset={() => {}} />);

    expect(interruptedRunKeys()).toHaveLength(2);
    expect(tabs.sent()).toEqual([]);
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

/**
 * What the card prints. A Server Component's error reaches the browser, in a
 * production build, as React's stand-in: its message is React's own minified
 * text with a link to its error list, and the only thing that names the error
 * is `digest`. So:
 *
 *   - a production build never prints `error.message` (the stand-in's text,
 *     or whatever a browser-side error carried). The error id (the digest)
 *     stays, for support;
 *   - a digest the app set itself names a state it knows. A page that could
 *     not check the member's access (lib/known-error-states) shows that, in
 *     plain words, with Try again, and none of the advice that fits a crash.
 */
describe('the dashboard error card: what it prints', () => {
  const standIn = Object.assign(
    new Error(
      'Minified React error #441; visit https://react.dev/errors/441 for the full message or use the non-minified dev environment for full errors and additional helpful warnings.',
    ),
    { digest: '2416532942' },
  );

  afterEach(() => {
    cleanup();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it('a production build prints no raw error message and no link, and keeps the error id', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const { container } = render(<DashboardError error={standIn} retry={() => {}} />);
    expect(
      screen.getByRole('heading', { level: 1, name: 'Something broke loading this page' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Error id: 2416532942')).toBeInTheDocument();
    expect(container.textContent).not.toContain('Minified React error');
    expect(container.textContent).not.toContain('react.dev');
    expect(container.querySelector('[data-glass-role="error-message"]')).toBeNull();
    // The rest of the card is as before.
    expect(screen.getByRole('button', { name: 'Sign out and back in' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to overview' })).toBeInTheDocument();
  });

  it('outside a production build the message is still shown, for the developer', () => {
    render(<DashboardError error={Object.assign(new Error('boom'), { digest: 'abc' })} retry={() => {}} />);
    expect(screen.getByText('boom')).toBeInTheDocument();
  });

  it.each(['production', 'test'])(
    'a page that could not check access (%s build): the plain state with Try again, and nothing else',
    (mode) => {
      vi.stubEnv('NODE_ENV', mode);
      const retry = vi.fn();
      const reset = vi.fn();
      const error = Object.assign(new Error(standIn.message), { digest: ACCESS_UNCHECKED_DIGEST });
      const { container } = render(<DashboardError error={error} retry={retry} reset={reset} />);

      expect(
        screen.getByRole('heading', { level: 1, name: "This page couldn't be loaded" }),
      ).toBeInTheDocument();
      expect(
        screen.getByText("We couldn't check your access just now. This is usually temporary."),
      ).toBeInTheDocument();

      // None of the crash card: no advice to sign out, no error id, no raw text.
      expect(container.textContent).not.toMatch(/sign out/i);
      expect(container.textContent).not.toContain('Something broke');
      expect(container.textContent).not.toContain('Error id');
      expect(container.textContent).not.toContain(ACCESS_UNCHECKED_DIGEST);
      expect(container.textContent).not.toContain('Minified React error');
      expect(container.textContent).not.toContain('react.dev');
      expect(screen.queryByRole('button', { name: 'Sign out and back in' })).toBeNull();
      expect(screen.queryByRole('link', { name: 'Go to overview' })).toBeNull();

      // One action, which asks the server again.
      expect(screen.getAllByRole('button')).toHaveLength(1);
      fireEvent.click(screen.getByRole('button', { name: /Try again/ }));
      expect(retry).toHaveBeenCalledTimes(1);
      expect(reset).not.toHaveBeenCalled();
    },
  );

  it('the access state is reported as a warning, a crash as an error', () => {
    render(
      <DashboardError
        error={Object.assign(new Error('x'), { digest: ACCESS_UNCHECKED_DIGEST })}
        retry={() => {}}
      />,
    );
    expect(vi.mocked(reportError).mock.calls[0]![1]).toMatchObject({
      tag: 'dashboard.render',
      level: 'warning',
    });
    cleanup();
    vi.clearAllMocks();
    render(<DashboardError error={standIn} retry={() => {}} />);
    expect(vi.mocked(reportError).mock.calls[0]![1]).toMatchObject({
      tag: 'dashboard.render',
      level: 'error',
    });
  });

  it('any other digest is the crash card', () => {
    render(<DashboardError error={standIn} retry={() => {}} />);
    expect(
      screen.getByRole('heading', { level: 1, name: 'Something broke loading this page' }),
    ).toBeInTheDocument();
    expect(screen.queryByText("We couldn't check your access just now. This is usually temporary.")).toBeNull();
  });
});

