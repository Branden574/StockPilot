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

import { Checkbox } from '@/components/ui/checkbox';

import { CardGrid, CardGridItem, GridCard } from './grid-card';
import { SizeBadge } from './size-badge';

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

  it('keeps the square: a fixed square media box the photo fills edge to edge, with no white bars', () => {
    const { container } = render(card());
    const media = container.querySelector('[data-slot="grid-card-media"]')!;
    expect(media).toHaveClass('aspect-square', 'relative', 'overflow-hidden');
    expect(media).not.toHaveClass('bg-white');
    const img = within(media as HTMLElement).getByRole('img', { name: 'L4L Polo — Men’s' });
    expect(img).toHaveClass('absolute', 'inset-0', 'h-full', 'w-full', 'object-cover');
    expect(img).not.toHaveClass('object-contain');
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

  it('places the status bottom-left above the stretched link (its title shows) and the badge top-right, letting clicks through', () => {
    const { container } = render(
      card({
        status: <span title="Created from a purchase order">Expected</span>,
      }),
    );
    const status = container.querySelector('[data-slot="grid-card-status"]')!;
    const badge = container.querySelector('[data-slot="grid-card-badge"]')!;
    // The pill takes the pointer (StockStatusBadge's explanatory titles), above
    // the name link's stretched overlay; a click on it does not open the record.
    expect(status).toHaveClass('bottom-2', 'left-2', 'z-10');
    expect(status).not.toHaveClass('pointer-events-none');
    expect(screen.getByText('Expected')).toHaveAttribute('title', 'Created from a purchase order');
    // The size badge has no title: a click on it still opens the record.
    expect(badge).toHaveClass('top-2', 'right-2', 'pointer-events-none');
    expect(badge).toHaveTextContent('8 sizes');
  });

  it('backs the status and badge slots with the card surface, so an outline pill reads over the photo in dark mode', () => {
    const { container } = render(card());
    // The photo fills the tile; an outline pill (Archived, Discontinued) has
    // no fill of its own, so its ink-3 text needs a backing over any photo.
    expect(container.querySelector('[data-slot="grid-card-media"]')).not.toHaveClass('bg-white');
    for (const slot of ['grid-card-status', 'grid-card-badge']) {
      const el = container.querySelector(`[data-slot="${slot}"]`)!;
      // flex: the backing is exactly the pill's box (no line-box strut around it).
      expect(el).toHaveClass('bg-card', 'rounded-full', 'flex');
    }
  });

  it('keeps a long badge inside the tile and off the checkbox chip, cut off at its end', () => {
    const long = '14 variants · 1,240 pairs total';
    const { container, rerender } = render(
      card({ badge: <SizeBadge placement="grid">{long}</SizeBadge> }),
    );
    const slot = () => container.querySelector('[data-slot="grid-card-badge"]')!;
    // With a checkbox chip (8 px inset + 28 px chip + 8 px gap + 8 px inset = 3.25rem).
    expect(slot()).toHaveClass('max-w-[calc(100%-3.25rem)]');
    const badge = screen.getByText(long);
    expect(badge).toHaveClass('inline-block', 'max-w-full', 'truncate');
    // The words are all still there (assistive technology reads them in full).
    expect(badge.textContent).toBe(long);

    rerender(card({ checkbox: undefined, badge: <SizeBadge placement="grid">{long}</SizeBadge> }));
    expect(slot()).toHaveClass('max-w-[calc(100%-1rem)]');
    expect(slot()).not.toHaveClass('max-w-[calc(100%-3.25rem)]');
  });

  it('keeps the SKU and the placement above the stretched link, selectable and copyable', () => {
    const { container } = render(card());
    const sku = container.querySelector('[data-slot="grid-card-sku"]')!;
    const placement = container.querySelector('[data-slot="grid-card-placement"]')!;
    expect(sku).toHaveTextContent('SP-POM-8SZ');
    for (const el of [sku, placement]) {
      expect(el).toHaveClass('relative', 'z-10', 'select-text', 'cursor-text');
      expect(screen.getByRole('link').contains(el)).toBe(false);
    }
  });

  it('draws the focus ring on the card while the name link has keyboard focus, never the clipped one on the link', () => {
    const { container, rerender } = render(card());
    const root = () => container.querySelector('[data-slot="grid-card"]')!;
    const name = () => container.querySelector('[data-slot="grid-card-name"]')!;
    // The two-line clamp hides overflow, which cut the link's own ring to an L.
    expect(name()).toHaveClass('line-clamp-2');
    const cardRing = [
      'has-[[data-slot=grid-card-name]_a:focus-visible]:ring-2',
      'has-[[data-slot=grid-card-name]_a:focus-visible]:ring-ring',
      'has-[[data-slot=grid-card-name]_a:focus-visible]:ring-offset-2',
      'has-[[data-slot=grid-card-name]_a:focus-visible]:ring-offset-background',
    ];
    expect(root()).toHaveClass(...cardRing);
    expect(name()).toHaveClass('[&_a:focus-visible]:ring-0', '[&_a:focus-visible]:ring-offset-0');
    // The same with the stretched link turned off, and on a selected card.
    rerender(card({ stretchLink: false, selected: true }));
    expect(root()).toHaveClass(...cardRing);
    expect(name()).toHaveClass('[&_a:focus-visible]:ring-0', '[&_a:focus-visible]:ring-offset-0');
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

  // W5 (Phase A walk at 390): the meta line was one line that cut off what
  // did not fit, mid-word ("Generic" cut after 27 of its 44 px on a group
  // card, hidden on another). Mutation caught: truncate (overflow hidden,
  // nowrap) back on the slot, or the last-resort break inside a word dropped.
  it('lets the meta line wrap: nothing in it is cut off or hidden', () => {
    const { container } = render(card({ meta: <span>2 records · Furniture · Generic</span> }));
    const meta = container.querySelector('[data-slot="grid-card-meta"]')!;
    expect(meta).toHaveTextContent('2 records · Furniture · Generic');
    expect(meta).toHaveClass('[overflow-wrap:anywhere]', 'text-[12px]', 'leading-[18px]');
    for (const clips of ['truncate', 'overflow-hidden', 'overflow-clip', 'whitespace-nowrap']) {
      expect(meta, clips).not.toHaveClass(clips);
    }
  });

  it('clamps the name without a scroll position, so focusing a long name cannot shift it', () => {
    const { container } = render(card());
    // line-clamp is overflow: hidden, which focus could scroll by a pixel and
    // leave there; overflow: clip has no scroll position.
    expect(container.querySelector('[data-slot="grid-card-name"]')).toHaveClass(
      'line-clamp-2',
      'supports-[overflow:clip]:overflow-clip',
    );
  });

  it('makes the whole chip the shared Checkbox`s target, 44 x 44 on phones and coarse pointers', () => {
    const onCheckedChange = vi.fn();
    const onCardClick = vi.fn();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { container } = render(
      card({
        onClick: onCardClick,
        checkbox: (
          <Checkbox
            checked={false}
            onCheckedChange={onCheckedChange}
            label="Select L4L Polo — Men’s"
          />
        ),
      }),
    );
    const slot = container.querySelector('[data-slot="grid-card-checkbox"]')!;
    // The rule reaches the box only as the chip's direct child with role="checkbox".
    const box = screen.getByRole('checkbox', { name: 'Select L4L Polo — Men’s' });
    expect(box.parentElement).toBe(slot);
    expect(slot).toHaveClass(
      '[&>[role=checkbox]]:before:absolute',
      '[&>[role=checkbox]]:before:-inset-px',
      "[&>[role=checkbox]]:before:content-['']",
      'max-sm:[&>[role=checkbox]]:before:-inset-[9px]',
      'pointer-coarse:[&>[role=checkbox]]:before:-inset-[9px]',
    );
    // One toggle per click, and the click stays with the checkbox.
    fireEvent.click(box);
    expect(onCheckedChange).toHaveBeenCalledTimes(1);
    expect(onCheckedChange).toHaveBeenCalledWith(true);
    expect(onCardClick).not.toHaveBeenCalled();
    // It sits beside the name link, not inside it (the Checkbox logs an error
    // in development when it is nested in another control).
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it('shows the checkbox on hover or focus only, and always while selected or while anything is selected', () => {
    const { container, rerender } = render(card());
    const slot = () => container.querySelector('[data-slot="grid-card-checkbox"]')!;
    // Focus in the card is the descendant selector `.group\/card:focus-within &`:
    // the class keeps one backslash, and its group is the card.
    expect(slot()).toHaveClass(
      'opacity-0',
      'group-hover/card:opacity-100',
      String.raw`[.group\/card:focus-within_&]:opacity-100`,
    );
    expect(slot().closest(String.raw`.group\/card`)).toBe(
      container.querySelector('[data-slot="grid-card"]'),
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
