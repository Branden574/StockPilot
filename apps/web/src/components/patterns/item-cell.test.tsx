import { render, screen } from '@testing-library/react';
import Link from 'next/link';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    ...rest
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { ItemCell } from './item-cell';
import { SizeBadge } from './size-badge';

describe('ItemCell', () => {
  it('prints the name (the page`s own link), the size badge, the chip and the mono SKU line', () => {
    render(
      <ItemCell
        name={<Link href="/dashboard/inventory/i1">L4L Polo — Men’s</Link>}
        badge={<SizeBadge>8 sizes</SizeBadge>}
        chip={<span>In group Polos</span>}
        sku="SP-POM-8SZ"
      />,
    );
    expect(screen.getByRole('link', { name: 'L4L Polo — Men’s' })).toHaveAttribute(
      'href',
      '/dashboard/inventory/i1',
    );
    expect(screen.getByText('8 sizes')).toBeInTheDocument();
    expect(screen.getByText('In group Polos')).toBeInTheDocument();
    expect(screen.getByText('SP-POM-8SZ')).toHaveClass('font-mono', 'text-[11.5px]');
  });

  it('draws a 34 px thumbnail from imageSrc, the hatch without one, or the page`s own element', () => {
    const { container, rerender } = render(
      <ItemCell name="Mug" imageSrc="https://example.test/m.webp" imageAlt="" />,
    );
    const thumb = () => container.querySelector('[data-slot="thumb"]');
    expect(thumb()).toHaveClass('size-[34px]');
    expect(thumb()!.querySelector('img')).toHaveClass('object-cover');

    rerender(<ItemCell name="Mug" />);
    expect(thumb()!.querySelector('[data-slot="missing-photo"]')).not.toBeNull();

    rerender(<ItemCell name="Mug" thumb={<span data-testid="own-thumb" />} />);
    expect(thumb()).toBeNull();
    expect(screen.getByTestId('own-thumb')).toBeInTheDocument();
  });

  it('indents a nested member row by 24 px', () => {
    const { container } = render(<ItemCell name="Polo — M" nested />);
    const cell = container.querySelector('[data-slot="item-cell"]')!;
    expect(cell).toHaveClass('pl-6');
    expect(cell).toHaveAttribute('data-nested');
  });

  it('prints no SKU line when the page passes none', () => {
    const { container } = render(<ItemCell name="Mug" />);
    expect(container.querySelector('[data-slot="item-cell-sku"]')).toBeNull();
  });

  it('puts a header`s own actions on a line of their own under the SKU, which may wrap between them', () => {
    const { container } = render(
      <ItemCell
        name="Desk Set"
        sku="Multiple"
        actions={
          <>
            <button type="button" className="whitespace-nowrap">
              Rename group
            </button>
            <button type="button" className="whitespace-nowrap">
              Remove from group
            </button>
          </>
        }
      />,
    );
    const sku = container.querySelector('[data-slot="item-cell-sku"]')!;
    const actions = container.querySelector('[data-slot="item-cell-actions"]')!;
    expect(actions).toHaveClass('flex', 'flex-wrap');
    expect(actions).toContainElement(screen.getByRole('button', { name: 'Rename group' }));
    expect(actions).toContainElement(screen.getByRole('button', { name: 'Remove from group' }));
    // After the SKU line and outside it: the SKU's block holds the SKU alone.
    expect(sku.textContent).toBe('Multiple');
    expect(sku.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('prints no actions line when the page passes none', () => {
    const { container } = render(<ItemCell name="Mug" sku="MUG-1" />);
    expect(container.querySelector('[data-slot="item-cell-actions"]')).toBeNull();
  });
});
