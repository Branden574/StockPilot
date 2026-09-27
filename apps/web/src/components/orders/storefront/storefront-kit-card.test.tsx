import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { CatalogItem } from '../v2/types';

import { KitCard, KitsRowSkeleton } from './storefront-kit-card';
import type { KitOffer } from './storefront-kits';

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

describe('KitsRowSkeleton (review F9)', () => {
  it('holds the row with the real row classes and one kit card box, and says nothing', () => {
    const { container } = render(<KitsRowSkeleton />);
    const section = screen.getByRole('region', { name: 'Loading kits' });
    expect(section.className).toBe('sf-kits');
    expect(section.getAttribute('aria-busy')).toBe('true');
    expect(container.querySelectorAll('.sf-grid.sf-kit-grid > .sf-card.sf-kit-card')).toHaveLength(
      1,
    );
    for (const cls of [
      '.sf-ph-box',
      '.sf-card-bd',
      '.sf-card-nm',
      '.sf-kit-items',
      '.sf-kit-more',
      '.sf-card-ctl',
    ]) {
      expect(container.querySelector(`.sf-kit-card ${cls}`)).not.toBeNull();
    }
    // Nothing in it is announced or focusable: the words are only there to
    // take the real row's size.
    expect(container.querySelectorAll('button, input, [tabindex]')).toHaveLength(0);
    expect(section.querySelector('.sf-sec-head')?.getAttribute('aria-hidden')).toBe('true');
    expect(section.querySelector('.sf-grid')?.getAttribute('aria-hidden')).toBe('true');
  });
});
