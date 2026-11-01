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

/**
 * Redesign P2.2c (from P3.7): with nothing to show the range read
 * "Showing 1–0 of 0" (the Movements no-match state). A total of 0 prints no
 * range; the pager and its words stay.
 */
describe('Pagination row range', () => {
  it('prints "Showing X–Y of Z" when there are rows', () => {
    const { container } = render(
      <Pagination page={2} pageSize={25} total={60} onPageChange={() => {}} />,
    );
    expect(container).toHaveTextContent('Showing 26–50 of 60');
  });

  it('the last page ends at the total', () => {
    const { container } = render(
      <Pagination page={3} pageSize={25} total={60} onPageChange={() => {}} />,
    );
    expect(container).toHaveTextContent('Showing 51–60 of 60');
  });

  // B9: the figures came out raw ("of 12345"), while every other count on the
  // page (the movements summary, the Items summary line) is formatted.
  it('prints the range, the total and the page count with thousands separators', () => {
    const { container } = render(
      <Pagination page={45} pageSize={25} total={12345} basePath="/dashboard/movements" />,
    );
    expect(container).toHaveTextContent('Showing 1,101–1,125 of 12,345');
    expect(screen.getByRole('button', { name: 'Jump to page' })).toHaveTextContent(
      'Page 45 of 494',
    );
  });

  it('formats a page number past 999 in the Page X of Y trigger', () => {
    render(<Pagination page={1000} totalPages={1200} onPageChange={() => {}} />);
    expect(screen.getByRole('button', { name: 'Jump to page' })).toHaveTextContent(
      'Page 1,000 of 1,200',
    );
  });

  it('with total 0 there is no range (never "Showing 1–0 of 0"); Prev, Page 1 of 1 and Next stay', () => {
    const { container } = render(
      <Pagination page={1} pageSize={25} total={0} basePath="/dashboard/movements" />,
    );
    expect(container).not.toHaveTextContent('Showing');
    expect(container).not.toHaveTextContent('1–0');
    expect(screen.getByRole('button', { name: 'Jump to page' })).toHaveTextContent('Page 1 of 1');
    expect(screen.getByRole('button', { name: '← Prev' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next →' })).toBeDisabled();
  });
});

/**
 * FX8 (DESIGN-SPEC 6.9 pagination footer, 6.2 pager rows): the reference
 * pager is 12.5/400 with the range figures in --ink at 400. The range figures
 * carried font-medium and Prev / Next took the Button's weight 500.
 */
describe('Pagination weight', () => {
  it('prints the range figures in ink at weight 400, and Prev and Next at 400', () => {
    render(<Pagination page={2} pageSize={25} total={60} onPageChange={() => {}} />);
    for (const figure of ['26', '50', '60']) {
      const el = screen.getByText(figure);
      expect(el).toHaveClass('text-foreground');
      expect(el).not.toHaveClass('font-medium');
    }
    for (const name of ['← Prev', 'Next →']) {
      const control = screen.getByRole('button', { name });
      expect(control).toHaveClass('font-normal');
      expect(control).not.toHaveClass('font-medium');
    }
  });

  it('keeps weight 400 on a disabled end and on a link end', () => {
    render(<Pagination page={1} pageSize={25} total={60} basePath="/dashboard/movements" />);
    const prev = screen.getByRole('button', { name: '← Prev' });
    expect(prev).toBeDisabled();
    expect(prev).toHaveClass('font-normal');
    const next = screen.getByRole('link', { name: 'Next →' });
    expect(next).toHaveAttribute('href', '/dashboard/movements?page=2');
    expect(next).toHaveClass('font-normal');
    expect(next).not.toHaveClass('font-medium');
  });
});
