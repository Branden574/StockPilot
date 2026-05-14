import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Pagination } from './inventory-table';

// Next.js Link does navigation gymnastics — stub to a plain anchor
// so we can assert href values directly.
vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    // Strip Next-Link-only props so they don't reach the DOM <a> and
    // trigger React's "unknown DOM prop" console warning during tests.
    prefetch: _prefetch,
    scroll: _scroll,
    replace: _replace,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
    prefetch?: boolean;
    scroll?: boolean;
    replace?: boolean;
  }) => (
    <a href={typeof href === 'string' ? href : '#'} {...rest}>
      {children}
    </a>
  ),
}));

describe('Pagination jump-to-page popover', () => {
  it('renders a Jump to page trigger with current state', () => {
    render(
      <Pagination
        page={2}
        pageSize={50}
        total={210}
        buildHref={(p) => `/dashboard/inventory?page=${p}`}
      />,
    );
    const trigger = screen.getByRole('button', { name: /jump to page/i });
    expect(trigger).toHaveTextContent('Page 2 of 5');
  });

  it('opens a popover with one link per page when the trigger is clicked', async () => {
    const user = userEvent.setup();
    render(
      <Pagination
        page={1}
        pageSize={50}
        total={150}
        buildHref={(p) => `/dashboard/inventory?page=${p}`}
      />,
    );
    await user.click(screen.getByRole('button', { name: /jump to page/i }));
    const pageLinks = await screen.findAllByRole('link', { name: /^[0-9]+$/ });
    expect(pageLinks).toHaveLength(3);
    expect(pageLinks[0]).toHaveAttribute('href', '/dashboard/inventory?page=1');
    expect(pageLinks[1]).toHaveAttribute('href', '/dashboard/inventory?page=2');
    expect(pageLinks[2]).toHaveAttribute('href', '/dashboard/inventory?page=3');
  });

  it('marks the current page link with aria-current="page"', async () => {
    const user = userEvent.setup();
    render(
      <Pagination
        page={2}
        pageSize={50}
        total={150}
        buildHref={(p) => `/dashboard/inventory?page=${p}`}
      />,
    );
    await user.click(screen.getByRole('button', { name: /jump to page/i }));
    const activeLink = await screen.findByRole('link', { current: 'page' });
    expect(activeLink).toHaveTextContent('2');
  });
});
