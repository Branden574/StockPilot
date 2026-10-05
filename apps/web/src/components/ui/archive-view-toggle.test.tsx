import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Active / Archived pill links. Every manager page uses it; Items and
 * Books also hand it the parameters that only mean something on Archived
 * (`archivedOnlyParams`): the "Auto-archived only" chip's ?auto=1 narrows the
 * list to rows the zero-stock job archived, and no active row is one, so an
 * Active link that kept it opened an empty list (review 2026-10-05).
 */

const nav = vi.hoisted(() => ({ search: '' }));

vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard/inventory',
  useSearchParams: () => new URLSearchParams(nav.search),
}));

vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
  } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { ArchiveViewToggle } from './archive-view-toggle';

const hrefOf = (name: string) => screen.getByRole('tab', { name }).getAttribute('href');

beforeEach(() => {
  nav.search = '';
});

describe('ArchiveViewToggle', () => {
  it('Active drops the parameters that only mean something on Archived, and the page', () => {
    nav.search = 'status=archived&auto=1&q=tee&page=3';
    render(<ArchiveViewToggle paramName="status" archivedOnlyParams={['auto']} />);
    expect(hrefOf('Active')).toBe('/dashboard/inventory?q=tee');
  });

  it('Archived keeps them (the chip stays on when you are already there)', () => {
    nav.search = 'status=archived&auto=1&q=tee&page=3';
    render(<ArchiveViewToggle paramName="status" archivedOnlyParams={['auto']} />);
    expect(hrefOf('Archived')).toBe('/dashboard/inventory?auto=1&q=tee&status=archived');
  });

  it('Active from the Auto-archived only view is the plain list', () => {
    nav.search = 'status=archived&auto=1';
    render(<ArchiveViewToggle paramName="status" archivedOnlyParams={['auto']} />);
    expect(hrefOf('Active')).toBe('/dashboard/inventory');
  });

  it('without archivedOnlyParams every other parameter is carried, as before', () => {
    nav.search = 'view=archived&auto=1&wh=w1';
    render(<ArchiveViewToggle />);
    expect(hrefOf('Active')).toBe('/dashboard/inventory?auto=1&wh=w1');
    expect(hrefOf('Archived')).toBe('/dashboard/inventory?auto=1&wh=w1&view=archived');
  });
});
