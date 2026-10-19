import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { CatalogGrid } from './catalog-grid';
import { CartProvider, initialCartState } from './cart-context';
import { ItemCard } from './item-card';
import type { CatalogItem } from './types';

// Redesign P4.B2: the shared catalog card (the New rental page's grid) draws
// its stock label as the shared status label (wash, tone text and dot, no
// blur) in the theme tokens, not fixed emerald, orange and red, and the empty
// grid is the shared no-match panel. Words and controls are unchanged.

function item(over: Partial<CatalogItem>): CatalogItem {
  return {
    id: 'i1',
    sku: 'SKU-1',
    name: 'Folding Chair',
    warehouseId: 'wh',
    quantityOnHand: 10,
    reservedQuantity: 0,
    itemType: null,
    categoryId: null,
    categoryName: 'Furniture',
    charterId: null,
    charterName: null,
    charterCode: null,
    rackLabel: '12-A',
    imageUrl: null,
    lqip: null,
    price: null,
    reorderPoint: 2,
    ...over,
  };
}

function renderCard(it: CatalogItem) {
  return render(
    <CartProvider initial={initialCartState({ warehouseId: 'wh', fulfillmentType: 'pickup' })}>
      <ItemCard item={it} />
    </CartProvider>,
  );
}

describe('ItemCard stock label', () => {
  it.each([
    [{ quantityOnHand: 10 }, '10 avail', 'bg-success-wash'],
    [{ quantityOnHand: 1, reorderPoint: 5 }, '1 low', 'bg-warning-wash'],
    [{ quantityOnHand: 0 }, 'Out', 'bg-destructive-wash'],
  ])('%o reads "%s" on the %s tone', (over, words, tone) => {
    renderCard(item(over));
    const label = screen.getByText(words).parentElement!;
    expect(label.className).toContain(tone);
    expect(label.className).not.toMatch(/backdrop-blur|emerald|orange|red-/);
  });

  it('adds to the cart and shows the stepper, as before', () => {
    const { container } = renderCard(item({}));
    fireEvent.click(screen.getByRole('button', { name: /Add/ }));
    expect(screen.getByLabelText('Quantity')).toBeTruthy();
    expect(screen.getByText('×1')).toBeTruthy();
    expect(container.innerHTML).not.toMatch(/emerald/);
  });
});

describe('CatalogGrid with no match', () => {
  it('is the shared no-match panel with its words and Clear filters', () => {
    const onClear = vi.fn();
    const { container } = render(
      <CatalogGrid
        items={[]}
        aisles={[]}
        activeAisleId="all"
        groupByAisle
        cols={4}
        onClearFilters={onClear}
      />,
    );
    expect(
      container.querySelector('[data-slot="state-panel"]')?.getAttribute('data-state-kind'),
    ).toBe('no-match');
    expect(screen.getByText('No items match your filters.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });
});
