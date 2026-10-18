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
});
