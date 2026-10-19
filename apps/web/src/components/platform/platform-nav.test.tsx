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

  it('draws every link focus ring inside its own edge, so no container clips it', () => {
    render(<PlatformNav />);
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(4);
    for (const a of links) {
      expect(a).toHaveClass('focus-visible:ring-inset', 'focus-visible:ring-offset-0');
    }
  });

  it('wraps instead of scrolling, so the Platform admin marker is drawn whole', () => {
    render(<PlatformNav />);
    const nav = screen.getByRole('navigation', { name: 'Platform' });
    expect(nav).toHaveClass('flex-wrap');
    expect(nav).not.toHaveClass('overflow-x-auto');
    const marker = nav.querySelector('[data-slot="platform-admin-marker"]');
    expect(marker).not.toBeNull();
    expect(marker).toHaveTextContent('Platform admin');
    // On a phone the marker starts its own line under the four links.
    expect(marker).toHaveClass('max-sm:ml-0');
  });

  it('never lights two destinations, and a lookalike path lights none', () => {
    expect(isPlatformNavActive('/platform/auditors', '/platform/audit')).toBe(false);
    expect(isPlatformNavActive('/platform/audit', '/platform')).toBe(false);
    expect(isPlatformNavActive(null, '/platform')).toBe(false);
  });
});
