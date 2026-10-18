import { fireEvent, render, screen, within } from '@testing-library/react';
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

import { CardGrid, CardGridItem, GridCard } from './grid-card';

/** A checkbox like the table's: a button with role="checkbox", never inside a link. */
function RowCheckbox({ checked, onToggle }: { checked: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label="Select L4L Polo — Men’s"
      onClick={onToggle}
    />
  );
}

function card(overrides: Partial<React.ComponentProps<typeof GridCard>> = {}) {
  return (
    <GridCard
      name={
        <Link href="/dashboard/inventory/i1?return=%2Fdashboard%2Finventory">L4L Polo — Men’s</Link>
      }
      sku="SP-POM-8SZ"
      imageSrc="https://example.test/thumb.webp"
      imageAlt="L4L Polo — Men’s"
      checkbox={<RowCheckbox checked={false} onToggle={() => {}} />}
      status={<span>In stock</span>}
      badge={<span>8 sizes</span>}
      quantity={{ value: '214' }}
      placement="DC4 · 21-A"
      {...overrides}
    />
  );
}

describe('GridCard', () => {
  it('keeps the checkbox slot: the record`s checkbox at the media`s top-left, outside the link', () => {
    const onToggle = vi.fn();
    const { container } = render(card({ checkbox: <RowCheckbox checked onToggle={onToggle} /> }));
    const slot = container.querySelector('[data-slot="grid-card-checkbox"]')!;
    expect(slot).toHaveClass('absolute', 'left-2', 'top-2');
    expect(slot.parentElement).toHaveAttribute('data-slot', 'grid-card-media');
    const box = within(slot as HTMLElement).getByRole('checkbox', {
      name: 'Select L4L Polo — Men’s',
    });
    expect(box).toHaveAttribute('aria-checked', 'true');
    expect(box.closest('a')).toBeNull();
    expect(screen.getByRole('link').contains(box)).toBe(false);
    fireEvent.click(box);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('keeps the square: a fixed square media box with the photo absolutely positioned, uncropped', () => {
    const { container } = render(card());
    const media = container.querySelector('[data-slot="grid-card-media"]')!;
    expect(media).toHaveClass('aspect-square', 'relative', 'overflow-hidden', 'bg-white');
    const img = within(media as HTMLElement).getByRole('img', { name: 'L4L Polo — Men’s' });
    expect(img).toHaveClass('absolute', 'inset-0', 'h-full', 'w-full', 'object-contain');
    expect(img).toHaveAttribute('src', 'https://example.test/thumb.webp');
    expect(img).toHaveAttribute('loading', 'lazy');
  });

  it('shows the hatch with no photo, and when the photo fails', () => {
    const { container, rerender } = render(card({ imageSrc: null }));
    expect(container.querySelector('[data-slot="missing-photo"]')).not.toBeNull();
    expect(screen.queryByRole('img')).toBeNull();

    rerender(card({ imageSrc: 'https://example.test/expired.webp' }));
    fireEvent.error(screen.getByRole('img'));
    expect(screen.queryByRole('img')).toBeNull();
    expect(container.querySelector('[data-slot="missing-photo"]')).not.toBeNull();
  });

  it('places the status bottom-left and the badge top-right, without catching clicks', () => {
    const { container } = render(card());
    const status = container.querySelector('[data-slot="grid-card-status"]')!;
    const badge = container.querySelector('[data-slot="grid-card-badge"]')!;
    expect(status).toHaveClass('bottom-2', 'left-2', 'pointer-events-none');
    expect(status).toHaveTextContent('In stock');
    expect(badge).toHaveClass('top-2', 'right-2', 'pointer-events-none');
    expect(badge).toHaveTextContent('8 sizes');
  });

  it('labels the quantity ("on hand" unless the page says otherwise) and prints the placement', () => {
    const { container, rerender } = render(card());
    expect(container.querySelector('[data-slot="grid-card-quantity"]')).toHaveTextContent(
      '214on hand',
    );
    expect(container.querySelector('[data-slot="grid-card-placement"]')).toHaveTextContent(
      'DC4 · 21-A',
    );
    rerender(card({ quantity: { value: '3', label: 'avail' } }));
    expect(container.querySelector('[data-slot="grid-card-quantity"]')).toHaveTextContent('3avail');
  });

  it('clamps the name to two lines and keeps the mono SKU under it', () => {
    const { container } = render(card());
    expect(container.querySelector('[data-slot="grid-card-name"]')).toHaveClass('line-clamp-2');
    expect(screen.getByText('SP-POM-8SZ')).toHaveClass('font-mono');
  });

  it('shows the checkbox on hover or focus only, and always while selected or while anything is selected', () => {
    const { container, rerender } = render(card());
    const slot = () => container.querySelector('[data-slot="grid-card-checkbox"]')!;
    expect(slot()).toHaveClass(
      'opacity-0',
      'group-hover/card:opacity-100',
      'group-focus-within/card:opacity-100',
    );
    expect(slot().className).toContain('pointer-coarse:opacity-100');
    rerender(card({ selectionActive: true }));
    expect(slot()).toHaveClass('opacity-100');
    expect(slot()).not.toHaveClass('opacity-0');
    rerender(card({ selected: true }));
    expect(container.querySelector('[data-slot="grid-card"]')).toHaveAttribute('data-selected');
    expect(slot()).not.toHaveClass('opacity-0');
  });

  it('widens the name link over the card by default, and not when the page turns it off', () => {
    const { container, rerender } = render(card());
    const name = () => container.querySelector('[data-slot="grid-card-name"]')!;
    expect(name().className).toContain('[&_a]:after:absolute');
    rerender(card({ stretchLink: false }));
    expect(name().className).not.toContain('[&_a]:after:absolute');
  });

  it('renders no checkbox chip for a card without one (a group header card)', () => {
    const { container } = render(card({ checkbox: undefined }));
    expect(container.querySelector('[data-slot="grid-card-checkbox"]')).toBeNull();
  });
});

describe('CardGrid', () => {
  it('is a list of cards', () => {
    render(
      <CardGrid aria-label="Items">
        <CardGridItem>{card()}</CardGridItem>
      </CardGrid>,
    );
    const list = screen.getByRole('list', { name: 'Items' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
  });
});
