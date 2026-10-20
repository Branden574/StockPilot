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
import { textActionTouchGapY, textActionTouchMarginTop } from './touch-target';

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

  it('keeps wrapped actions clear of each other and of the SKU: 6 px apart, 14 px where the touch target is on', () => {
    const { container } = render(
      <ItemCell
        name="Desk Set"
        sku="Multiple"
        actions={
          <>
            <button type="button">Rename group</button>
            <button type="button">Remove from group</button>
          </>
        }
      />,
    );
    const actions = container.querySelector('[data-slot="item-cell-actions"]')!;
    // An action is 18 px tall. On a fine pointer two wrapped actions sit 6 px
    // apart, so the 24 px circle around one never reaches the other (WCAG 2.2
    // 2.5.8: (24 - 18) / 2 = 3 px past each, 6 between them).
    expect(actions).toHaveClass('gap-y-1.5');
    expect(actions).not.toHaveClass('gap-y-0.5');
    // Below sm and on a coarse pointer each action's target is 44 px tall and
    // reaches (44 - 18) / 2 = 13 px past it: the lines keep 14 px from each
    // other and from the SKU above them, so a tap on Rename never lands on
    // Remove and a long-press on the SKU selects it.
    expect(actions).toHaveClass(textActionTouchGapY, textActionTouchMarginTop);
    expect(textActionTouchGapY.split(' ')).toEqual([
      'max-sm:gap-y-3.5',
      'pointer-coarse:gap-y-3.5',
    ]);
    expect(textActionTouchMarginTop.split(' ')).toEqual(['max-sm:mt-3.5', 'pointer-coarse:mt-3.5']);
    // The SKU line itself does not move for a header's actions.
    expect(container.querySelector('[data-slot="item-cell-sku"]')).not.toHaveClass('max-sm:mt-3.5');
  });

  it('gives a chip`s action 14 px of room from the SKU and from a wrapped name where the touch target is on', () => {
    const chip = (
      <span>
        <span>Same SKU as records in Pads</span>
        <button type="button">Add to group</button>
      </span>
    );
    const { container, rerender } = render(
      <ItemCell name="Pad C" sku="PAD-9" chip={chip} chipAction />,
    );
    const nameLine = () => container.querySelector('[data-slot="item-cell-name"]')!.parentElement!;
    const sku = () => container.querySelector('[data-slot="item-cell-sku"]')!;
    expect(nameLine()).toHaveClass('gap-y-0.5', 'max-sm:gap-y-3.5', 'pointer-coarse:gap-y-3.5');
    expect(sku()).toHaveClass('max-sm:mt-3.5', 'pointer-coarse:mt-3.5');
    // The SKU line is still the SKU alone (selectable and copied as it is).
    expect(sku().textContent).toBe('PAD-9');

    // A chip with no action (or no chip) changes nothing.
    rerender(<ItemCell name="Pad C" sku="PAD-9" chip={<span>In group Pads</span>} />);
    expect(nameLine()).not.toHaveClass('max-sm:gap-y-3.5');
    expect(nameLine()).not.toHaveClass('pointer-coarse:gap-y-3.5');
    expect(sku()).not.toHaveClass('max-sm:mt-3.5');
    expect(sku()).not.toHaveClass('pointer-coarse:mt-3.5');
  });

  it('keeps the SKU on one line, and with wrapSku (a table column) lets it wrap anywhere inside it', () => {
    const long = 'Number Stories for Little Learners-MABCD-001WXYZ';
    const { container, rerender } = render(<ItemCell name="Number Stories" sku={long} />);
    const sku = () => container.querySelector('[data-slot="item-cell-sku"]')!;
    expect(sku()).toHaveClass('whitespace-nowrap');
    expect(sku()).not.toHaveClass('[overflow-wrap:anywhere]');

    rerender(<ItemCell name="Number Stories" sku={long} wrapSku />);
    expect(sku()).toHaveClass('[overflow-wrap:anywhere]', 'font-mono', 'text-[11.5px]');
    expect(sku()).not.toHaveClass('whitespace-nowrap');
    // A soft wrap adds no character: the block still holds exactly the SKU.
    expect(sku().textContent).toBe(long);
  });

  it('prints no actions line when the page passes none', () => {
    const { container } = render(<ItemCell name="Mug" sku="MUG-1" />);
    expect(container.querySelector('[data-slot="item-cell-actions"]')).toBeNull();
  });
});
