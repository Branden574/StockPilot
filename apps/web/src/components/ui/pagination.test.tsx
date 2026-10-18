import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

import { Pagination } from './pagination';

/**
 * Redesign P2.2 pager. The jump-to-page grid is a dense group of 28 px page
 * buttons 4 px apart. Below sm and on coarse pointers Button grows a 44 px
 * touch area, and a later button's area painted over the row above, so a tap
 * on the bottom 5 px of page 1 opened page 6 (measured at 390 px on
 * /dashboard/movements). The page buttons are now real 44 px targets there,
 * and the grid keeps five columns (at least 44 px wide) on a coarse pointer.
 */

const classes = (el: Element) => (el.getAttribute('class') ?? '').split(/\s+/);

async function openJumpGrid(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Jump to page' }));
  return screen.findByRole('dialog');
}

describe('Pagination jump-to-page grid', () => {
  it('page buttons are 28 px on desktop and full 44 px targets below sm and on coarse pointers', async () => {
    const user = userEvent.setup();
    render(<Pagination page={1} totalPages={27} onPageChange={() => {}} />);
    const grid = await openJumpGrid(user);
    const one = within(grid).getByRole('button', { name: '1' });
    expect(classes(one)).toEqual(
      expect.arrayContaining(['h-7', 'max-sm:h-11', 'pointer-coarse:h-11', 'w-full']),
    );
    const six = within(grid).getByRole('button', { name: '6' });
    expect(classes(six)).toEqual(expect.arrayContaining(['max-sm:h-11', 'pointer-coarse:h-11']));
    // Five columns, eight from sm up, five again on a coarse pointer so each
    // column stays at least 44 px wide.
    expect(classes(one.parentElement as HTMLElement)).toEqual(
      expect.arrayContaining([
        'grid',
        'grid-cols-5',
        'gap-1',
        'sm:grid-cols-8',
        'pointer-coarse:grid-cols-5',
      ]),
    );
  });

  it('the link grid gets the same targets and keeps its hrefs and the current page', async () => {
    const user = userEvent.setup();
    render(<Pagination page={3} totalPages={12} basePath="/dashboard/movements" />);
    const grid = await openJumpGrid(user);
    const current = within(grid).getByRole('link', { name: '3' });
    expect(current).toHaveAttribute('aria-current', 'page');
    expect(current).toHaveAttribute('href', '/dashboard/movements?page=3');
    expect(within(grid).getByRole('link', { name: '1' })).toHaveAttribute(
      'href',
      '/dashboard/movements',
    );
    expect(classes(current)).toEqual(
      expect.arrayContaining(['h-7', 'max-sm:h-11', 'pointer-coarse:h-11']),
    );
  });

  it('choosing a page still goes to that page, once', async () => {
    const user = userEvent.setup();
    const onPageChange = vi.fn();
    render(<Pagination page={1} totalPages={27} onPageChange={onPageChange} />);
    const grid = await openJumpGrid(user);
    await user.click(within(grid).getByRole('button', { name: '6' }));
    expect(onPageChange).toHaveBeenCalledTimes(1);
    expect(onPageChange).toHaveBeenCalledWith(6);
  });
});
