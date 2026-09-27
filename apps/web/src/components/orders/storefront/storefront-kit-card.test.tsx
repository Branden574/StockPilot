import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { CatalogItem } from '../v2/types';

import { KitCard, KitsRow, KitsRowSkeleton } from './storefront-kit-card';
import type { KitOffer, KitsResult } from './storefront-kits';

// The kit card on its own, with the real quantity field (review F11 and F9).

function item(id: string, name: string, quantityOnHand: number): CatalogItem {
  return {
    id,
    sku: id.toUpperCase(),
    name,
    warehouseId: 'wh',
    quantityOnHand,
    reservedQuantity: 0,
    itemType: null,
    categoryId: 'cat',
    categoryName: 'New Hire',
    charterId: null,
    charterName: null,
    charterCode: null,
    rackLabel: null,
    imageUrl: null,
    lqip: null,
    price: null,
    reorderPoint: 0,
  };
}

const BACKPACK = item('backpack', 'Backpack', 60);
const MUG = item('mug', 'Coffee mug', 235);
const KIT: KitOffer = {
  bundleId: 'bundle-new-hire',
  name: 'New Hire Bundle',
  sku: null,
  components: [
    { anchorItemId: BACKPACK.id, itemIds: [BACKPACK.id], perKit: 1 },
    { anchorItemId: MUG.id, itemIds: [MUG.id], perKit: 1 },
  ],
};

function renderCard(
  items: CatalogItem[],
  shares: Record<string, number> | undefined,
  qty: Array<[string, number]>,
) {
  return render(
    <KitCard
      kit={KIT}
      itemMap={new Map(items.map((i) => [i.id, i]))}
      qtyByItemId={new Map(qty)}
      shares={shares}
      onSetKits={vi.fn()}
    />,
  );
}

describe('KitCard accessibility (review F11)', () => {
  it('the kits stepper field is named for the kit, not "Quantity"', () => {
    renderCard([BACKPACK, MUG], { backpack: 2, mug: 2 }, [
      ['backpack', 2],
      ['mug', 2],
    ]);
    const field = screen.getByRole('textbox', { name: 'Kits of New Hire Bundle in cart' });
    expect((field as HTMLInputElement).value).toBe('2');
    expect(screen.queryByRole('textbox', { name: 'Quantity' })).toBeNull();
  });

  it('Details points at the details only while they exist', () => {
    renderCard([BACKPACK, MUG], undefined, []);
    const details = screen.getByRole('button', { name: 'Details' });
    expect(details.getAttribute('aria-expanded')).toBe('false');
    expect(details.hasAttribute('aria-controls')).toBe(false);
    fireEvent.click(details);
    const id = details.getAttribute('aria-controls');
    expect(id).toBeTruthy();
    expect(document.getElementById(id!)).not.toBeNull();
  });

  it('the out-of-stock line is plain text drawn with the card, not a live region', () => {
    renderCard([{ ...BACKPACK, quantityOnHand: 0 }, MUG], undefined, []);
    const short = screen.getByText('Out of stock: Backpack');
    expect(short.getAttribute('role')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });
});

// ═══ ONE LINE OF KITS AT EVERY WIDTH (verify 2026-09-27) ═══
//
// The Kits row was a wrapping card grid: its height grew with the number of
// kits and shrank with the screen, so the reserved place (one card) could not
// match it. With five kits the row was 2096 px at 390 wide against 469 px
// reserved, and the page below jumped 1628 px when the kits arrived with the
// view scrolled there (Safari keeps no scroll anchor). It is now one
// horizontal strip, like Frequently ordered, whose height is one card at
// every width, and the reserved place is that same strip.
describe('KitsRowSkeleton (review F9)', () => {
  it('holds the row with the real row classes and kit card boxes in one strip, and says nothing', () => {
    const { container } = render(<KitsRowSkeleton />);
    const section = screen.getByRole('region', { name: 'Loading kits' });
    expect(section.className).toBe('sf-kits');
    expect(section.getAttribute('aria-busy')).toBe('true');
    const cards = container.querySelectorAll('.sf-kits-track > .sf-card.sf-kit-card');
    expect(cards.length).toBeGreaterThanOrEqual(1);
    // No wrapping grid: the strip is the only place the cards sit.
    expect(container.querySelector('.sf-grid')).toBeNull();
    for (const cls of [
      '.sf-ph-box',
      '.sf-card-bd',
      '.sf-card-nm',
      '.sf-kit-desc',
      '.sf-kit-items',
      '.sf-kit-more',
      '.sf-card-ctl',
    ]) {
      expect(container.querySelector(`.sf-kit-card ${cls}`)).not.toBeNull();
    }
    // The header holds the same parts as the real one, arrows included, so it
    // takes the same height.
    expect(section.querySelector('.sf-sec-head .sf-arrows')).not.toBeNull();
    // Nothing in it is announced or focusable: the words are only there to
    // take the real row's size.
    expect(container.querySelectorAll('button, input, [tabindex]')).toHaveLength(0);
    expect(section.querySelector('.sf-sec-head')?.getAttribute('aria-hidden')).toBe('true');
    expect(section.querySelector('.sf-kits-track')?.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('KitsRow is one horizontal strip', () => {
  const kits: KitOffer[] = Array.from({ length: 5 }, (_, i) => ({
    ...KIT,
    bundleId: `bundle-${i + 1}`,
    name: `Kit ${i + 1}`,
  }));
  function settled(value: KitsResult): Promise<KitsResult> {
    const p = Promise.resolve(value) as Promise<KitsResult> & { status: string; value: KitsResult };
    p.status = 'fulfilled';
    p.value = value;
    return p;
  }
  async function renderRow() {
    const onSetKits = vi.fn();
    await act(async () => {
      render(
        <KitsRow
          promise={settled({ status: 'ok', kits })}
          itemMap={new Map([BACKPACK, MUG].map((i) => [i.id, i]))}
          qtyByItemId={new Map()}
          cartKits={{}}
          onSetKits={onSetKits}
        />,
      );
    });
    return onSetKits;
  }

  it('puts every kit in one strip, never a wrapping grid', async () => {
    await renderRow();
    const row = screen.getByRole('region', { name: 'Kits' });
    const tracks = row.querySelectorAll('.sf-kits-track');
    expect(tracks).toHaveLength(1);
    expect(tracks[0]!.querySelectorAll(':scope > .sf-kit-card')).toHaveLength(5);
    expect(row.querySelector('.sf-grid')).toBeNull();
  });

  it('every card stays reachable by keyboard and screen reader: nothing is hidden or taken out of the tab order', async () => {
    const onSetKits = await renderRow();
    const row = screen.getByRole('region', { name: 'Kits' });
    for (let i = 1; i <= 5; i += 1) {
      const add = within(row).getByRole('button', { name: `Add kit: Kit ${i}` });
      expect(add.getAttribute('tabindex')).toBeNull();
      expect(add.closest('[aria-hidden="true"]')).toBeNull();
    }
    fireEvent.click(within(row).getByRole('button', { name: 'Add kit: Kit 5' }));
    expect(onSetKits).toHaveBeenCalledWith(kits[4], 1);
  });

  it('keyboard focus on a card control scrolls it fully into view; focus from a pointer does not', async () => {
    await renderRow();
    const row = screen.getByRole('region', { name: 'Kits' });
    const add = within(row).getByRole('button', { name: 'Add kit: Kit 4' });
    const scrollIntoView = vi.fn();
    add.scrollIntoView = scrollIntoView;
    const matches = vi.spyOn(add, 'matches');
    matches.mockReturnValue(true); // :focus-visible, as after Tab
    fireEvent.focus(add);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest' });
    scrollIntoView.mockClear();
    matches.mockReturnValue(false); // focus from a click
    fireEvent.focus(add);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('has its own scroll buttons, named for the kits', async () => {
    await renderRow();
    const row = screen.getByRole('region', { name: 'Kits' });
    const track = row.querySelector('.sf-kits-track') as HTMLElement;
    const scrollBy = vi.fn();
    track.scrollBy = scrollBy as unknown as typeof track.scrollBy;
    fireEvent.click(within(row).getByRole('button', { name: 'Scroll kits forward' }));
    fireEvent.click(within(row).getByRole('button', { name: 'Scroll kits back' }));
    expect(scrollBy).toHaveBeenCalledTimes(2);
  });
});
