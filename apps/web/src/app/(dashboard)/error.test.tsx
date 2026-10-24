import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

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
