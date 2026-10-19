import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The console nav (P5.3): the same four destinations and the marker, the
 * current one announced (aria-current) as well as drawn, and Organizations
 * kept lit inside one organization's page (it used to light nothing there).
 */

const nav = vi.hoisted(() => ({ pathname: '/platform' as string | null }));
vi.mock('next/navigation', () => ({ usePathname: () => nav.pathname }));

import { isPlatformNavActive, PlatformNav } from './platform-nav';

beforeEach(() => {
  nav.pathname = '/platform';
});

function current() {
  return screen
    .getAllByRole('link')
    .filter((a) => a.getAttribute('aria-current') === 'page')
    .map((a) => a.textContent);
}

describe('PlatformNav', () => {
  it('links the four destinations and shows the Platform admin marker', () => {
    render(<PlatformNav />);
    expect(screen.getAllByRole('link').map((a) => [a.textContent, a.getAttribute('href')])).toEqual(
      [
        ['Organizations', '/platform'],
        ['Provision', '/platform/provision'],
        ['Support', '/platform/support'],
        ['Audit', '/platform/audit'],
      ],
    );
    expect(screen.getByText('Platform admin')).toBeInTheDocument();
  });

  it.each([
    ['/platform', 'Organizations'],
    ['/platform/orgs/abc', 'Organizations'],
    ['/platform/provision', 'Provision'],
    ['/platform/support', 'Support'],
    ['/platform/audit', 'Audit'],
  ])('marks %s as %s', (path, label) => {
    nav.pathname = path;
    render(<PlatformNav />);
    expect(current()).toEqual([label]);
  });

  it('never lights two destinations, and a lookalike path lights none', () => {
    expect(isPlatformNavActive('/platform/auditors', '/platform/audit')).toBe(false);
    expect(isPlatformNavActive('/platform/audit', '/platform')).toBe(false);
    expect(isPlatformNavActive(null, '/platform')).toBe(false);
  });
});
