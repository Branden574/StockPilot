import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    prefetch,
    ...rest
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & {
    href: string;
    prefetch?: boolean | null;
  }) => (
    <a href={href} data-prefetch={String(prefetch)} {...rest}>
      {children}
    </a>
  ),
}));

import { StatStrip, StatStripItem, StatStripLink } from './stat-strip';

describe('StatStrip', () => {
  it('prints each figure with its label and sub-line, in the page`s words', () => {
    render(
      <StatStrip>
        <StatStripItem label="Open POs" value="6" sub="2 overdue" subTone="destructive" />
        <StatStripItem label="Committed value" value="$13,945.00" />
      </StatStrip>,
    );
    expect(screen.getByText('Open POs')).toBeInTheDocument();
    expect(screen.getByText('6')).toBeInTheDocument();
    expect(screen.getByText('2 overdue')).toHaveClass('text-destructive');
    // No sub-line element when the page passes none.
    const second = screen.getByText('Committed value').parentElement!;
    expect(second.children).toHaveLength(2);
  });

  it('drops the right hairline after the last cell and clips the outer ones (no double line)', () => {
    const { container } = render(
      <StatStrip>
        <StatStripItem label="On hand" value="24" />
        <StatStripItem label="Coverage" value="7 days" valueTone="destructive" />
      </StatStrip>,
    );
    const root = container.querySelector('[data-slot="stat-strip"]')!;
    expect(root).toHaveClass('overflow-hidden');
    const grid = root.firstElementChild!;
    expect(grid.className).toContain('[&>*:last-child]:border-r-0');
    expect(grid.className).toContain('-mr-px');
    expect(grid.className).toContain('-mb-px');
    expect(screen.getByText('7 days')).toHaveClass('text-destructive');
  });

  it('uses the variant`s column minimum', () => {
    const { container, rerender } = render(<StatStrip variant="detail" />);
    expect(
      container.querySelector('[data-slot="stat-strip"]')!.firstElementChild!.className,
    ).toContain('150px');
    rerender(<StatStrip variant="stages" />);
    expect(
      container.querySelector('[data-slot="stat-strip"]')!.firstElementChild!.className,
    ).toContain('130px');
  });

  it('as a nav of stage links: named, aria-current on the current stage, hrefs kept, counts only where given', () => {
    render(
      <StatStrip as="nav" variant="stages" aria-label="Status">
        <StatStripLink href="/dashboard/orders?status=pending" label="Needs approval" active />
        <StatStripLink href="/dashboard/orders?status=picking" label="Picking" prefetch={false} />
      </StatStrip>,
    );
    const nav = screen.getByRole('navigation', { name: 'Status' });
    const current = within(nav).getByRole('link', { name: 'Needs approval' });
    expect(current).toHaveAttribute('aria-current', 'page');
    expect(current).toHaveAttribute('href', '/dashboard/orders?status=pending');
    const picking = within(nav).getByRole('link', { name: 'Picking' });
    expect(picking).not.toHaveAttribute('aria-current');
    expect(picking).toHaveAttribute('data-prefetch', 'false');
    expect(picking.textContent).toBe('Picking');
  });

  it('draws a stage`s focus ring inside the tile, so the clipped strip cannot cut it', () => {
    const { container } = render(
      <StatStrip as="nav" variant="stages" aria-label="Status">
        <StatStripLink href="/dashboard/orders?status=pending" label="Needs approval" active />
        <StatStripLink href="/dashboard/orders?status=picking" label="Picking" />
      </StatStrip>,
    );
    // The strip clips at its rounded edge (overflow-hidden) and each tile
    // fills its row, which cuts the global ring drawn 4 px outside a control.
    expect(container.querySelector('[data-slot="stat-strip"]')).toHaveClass('overflow-hidden');
    for (const link of screen.getAllByRole('link')) {
      expect(link).toHaveClass('focus-visible:ring-inset', 'focus-visible:ring-offset-0');
    }
  });

  it('keeps 12 px between the figure and the stage bar in its bottom padding (81.75 px strip)', () => {
    render(
      <StatStrip as="nav" variant="stages" aria-label="Status">
        <StatStripLink href="/dashboard/orders?status=pending" label="Needs approval" count={3} />
      </StatStrip>,
    );
    const link = screen.getByRole('link', { name: /Needs approval/ });
    // 12 top + 14 bottom: the 2 px bar sits absolutely in the bottom padding.
    expect(link).toHaveClass('pt-3', 'pb-3.5');
    expect(link).not.toHaveClass('py-3');
    expect(link.querySelector('span[aria-hidden]')).toHaveClass('absolute', 'bottom-0', 'h-0.5');
  });

  it('clips its 1 px overhang without a scroll position, so focusing the last stage cannot shift the strip', () => {
    const { container } = render(
      <StatStrip as="nav" variant="stages" aria-label="Status">
        <StatStripLink href="/dashboard/orders?status=pending" label="Needs approval" />
        <StatStripLink href="/dashboard/orders?status=completed" label="Completed" />
      </StatStrip>,
    );
    // overflow: hidden is a scroll container: focus on a stage in the last
    // column or row scrolled the strip by the overhang and left it there.
    // overflow: clip (where supported) clips the same box and cannot scroll;
    // hidden stays as the fallback.
    expect(container.querySelector('[data-slot="stat-strip"]')).toHaveClass(
      'overflow-hidden',
      'supports-[overflow:clip]:overflow-clip',
    );
  });
});
