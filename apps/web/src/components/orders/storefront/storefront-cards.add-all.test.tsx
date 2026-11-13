import { readFileSync } from 'node:fs';
import path from 'node:path';

import { fireEvent, render, screen, within } from '@testing-library/react';
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { ORDER_MAX_UNITS_PER_LINE } from '@stockpilot/core';

import { CartProvider, initialCartState } from '../v2/cart-context';
import type { CatalogItem } from '../v2/types';

import { CompactRow, FreqCarousel, ProductCard, SfAddControl } from './storefront-cards';
import { CartRail } from './storefront-cart';
import { KitCard } from './storefront-kit-card';
import type { KitOffer } from './storefront-kits';
import { QuickViewDrawer } from './storefront-overlays';

// "Add all" on the New order page: one press sets the line to everything
// available, in place of typing the number. It lives in SfAddControl, so the
// grid card, the list row and the quick view get it, for items and books
// alike. All data here is invented.

function item(over: Partial<CatalogItem> = {}): CatalogItem {
  return {
    id: 'pad',
    sku: 'PAD-01',
    name: 'Graph Paper Pad',
    warehouseId: 'wh',
    quantityOnHand: 67,
    reservedQuantity: 0,
    itemType: null,
    categoryId: 'cat',
    categoryName: 'Paper',
    charterId: null,
    charterName: null,
    charterCode: null,
    rackLabel: null,
    imageUrl: null,
    lqip: null,
    price: null,
    reorderPoint: 0,
    ...over,
  };
}

function handlers() {
  return { onAdd: vi.fn(), onDec: vi.fn(), onSetQty: vi.fn(), onQuickView: vi.fn() };
}

const addAll = () => screen.queryByRole('button', { name: /^Add all / });

describe('Add all on the grid card', () => {
  it('sets the line to everything available in one press, and is not Add to cart', () => {
    const h = handlers();
    render(<ProductCard item={item()} qty={0} {...h} />);
    const button = screen.getByRole('button', { name: 'Add all 67 available: Graph Paper Pad' });
    expect(button).toHaveTextContent(/^Add all$/);
    expect(button).toHaveAttribute('type', 'button');
    fireEvent.click(button);
    expect(h.onSetQty).toHaveBeenCalledTimes(1);
    expect(h.onSetQty).toHaveBeenCalledWith('pad', 67);
    expect(h.onAdd).not.toHaveBeenCalled();
    // Add to cart is still there, unchanged.
    expect(screen.getByRole('button', { name: 'Add to cart' })).toBeInTheDocument();
  });

  it('counts what is available to order, not what is on hand', () => {
    const h = handlers();
    render(<ProductCard item={item({ quantityOnHand: 70, reservedQuantity: 3 })} qty={0} {...h} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add all 67 available: Graph Paper Pad' }));
    expect(h.onSetQty).toHaveBeenCalledWith('pad', 67);
  });

  it('with 5 in the cart it sets 67, never 72', () => {
    const h = handlers();
    render(<ProductCard item={item()} qty={5} {...h} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add all 67 available: Graph Paper Pad' }));
    expect(h.onSetQty).toHaveBeenCalledTimes(1);
    expect(h.onSetQty).toHaveBeenCalledWith('pad', 67);
  });

  it('with everything in the cart it is dimmed, says so, and a press does nothing', () => {
    const h = handlers();
    render(<ProductCard item={item()} qty={67} {...h} />);
    const button = screen.getByRole('button', {
      name: 'All 67 available are in your cart: Graph Paper Pad',
    });
    expect(button).toHaveAttribute('aria-disabled', 'true');
    // aria-disabled, never disabled: a disabled button drops keyboard focus.
    expect(button).not.toBeDisabled();
    fireEvent.click(button);
    expect(h.onSetQty).not.toHaveBeenCalled();
    expect(h.onAdd).not.toHaveBeenCalled();
    expect(addAll()).toBeNull();
  });

  it('with more in the cart than is available it never says all of them are in the cart, and never lowers the line', () => {
    const h = handlers();
    render(<ProductCard item={item()} qty={80} {...h} />);
    const button = screen.getByRole('button', {
      name: 'Only 67 available. Reduce the quantity: Graph Paper Pad',
    });
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(screen.queryByRole('button', { name: /All 67 available/ })).toBeNull();
    fireEvent.click(button);
    expect(h.onSetQty).not.toHaveBeenCalled();
  });

  it('is not drawn with nothing available, or with the one that Add to cart already adds', () => {
    const h = handlers();
    const { rerender } = render(<ProductCard item={item({ quantityOnHand: 0 })} qty={0} {...h} />);
    expect(screen.getByRole('button', { name: 'Out of stock' })).toBeDisabled();
    expect(screen.queryByText(/^Add all/)).toBeNull();
    expect(document.querySelector('.sf-add-all')).toBeNull();
    rerender(<ProductCard item={item({ quantityOnHand: 1 })} qty={0} {...h} />);
    expect(screen.getByRole('button', { name: 'Add to cart' })).toBeInTheDocument();
    expect(document.querySelector('.sf-add-all')).toBeNull();
    rerender(<ProductCard item={item({ quantityOnHand: 2 })} qty={0} {...h} />);
    expect(
      screen.getByRole('button', { name: 'Add all 2 available: Graph Paper Pad' }),
    ).toBeInTheDocument();
  });

  it('a book gets the same button', () => {
    const h = handlers();
    render(
      <ProductCard
        item={item({ id: 'reader', name: 'Grade 4 Reader', itemType: 'book', quantityOnHand: 30 })}
        qty={0}
        {...h}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add all 30 available: Grade 4 Reader' }));
    expect(h.onSetQty).toHaveBeenCalledWith('reader', 30);
  });

  it('keeps keyboard focus on the same button after the press fills the cart', () => {
    const h = handlers();
    const { rerender } = render(<ProductCard item={item()} qty={0} {...h} />);
    const button = screen.getByRole('button', { name: 'Add all 67 available: Graph Paper Pad' });
    button.focus();
    expect(document.activeElement).toBe(button);
    // Add to cart turns into the stepper; the button must be the same element.
    rerender(<ProductCard item={item()} qty={67} {...h} />);
    expect(document.activeElement).toBe(button);
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button.isConnected).toBe(true);
    rerender(<ProductCard item={item()} qty={66} {...h} />);
    expect(document.activeElement).toBe(button);
    expect(button).not.toHaveAttribute('aria-disabled', 'true');
  });
});

describe('Add all above the most one order can hold', () => {
  const BIG = item({ id: 'clip', name: 'Paper Clip', quantityOnHand: 25_000 });

  it('adds the order limit and never says all', () => {
    const h = handlers();
    render(<ProductCard item={BIG} qty={0} {...h} />);
    const button = screen.getByRole('button', {
      name: 'Add 10,000, the most one order can hold: Paper Clip',
    });
    expect(button).toHaveTextContent(/^Add 10,000$/);
    expect(button.textContent).not.toMatch(/all/i);
    expect(button.getAttribute('aria-label')).not.toMatch(/all|25/i);
    fireEvent.click(button);
    expect(h.onSetQty).toHaveBeenCalledTimes(1);
    expect(h.onSetQty).toHaveBeenCalledWith('clip', ORDER_MAX_UNITS_PER_LINE);
    expect(ORDER_MAX_UNITS_PER_LINE).toBe(10_000);
  });

  it('at the limit it is dimmed and says the limit, never that all 25000 are in the cart', () => {
    const h = handlers();
    render(<ProductCard item={BIG} qty={10_000} {...h} />);
    const button = screen.getByRole('button', {
      name: '10,000 are in your cart, the most one order can hold: Paper Clip',
    });
    expect(button).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(button);
    expect(h.onSetQty).not.toHaveBeenCalled();
  });
});

describe('Add all on the list row and in the quick view', () => {
  it('the list row has it', () => {
    const h = handlers();
    render(<CompactRow item={item()} qty={0} {...h} />);
    const button = screen.getByRole('button', { name: 'Add all 67 available: Graph Paper Pad' });
    expect(button).toHaveTextContent(/^Add all$/);
    fireEvent.click(button);
    expect(h.onSetQty).toHaveBeenCalledTimes(1);
    expect(h.onSetQty).toHaveBeenCalledWith('pad', 67);
    expect(h.onAdd).not.toHaveBeenCalled();
  });

  it('the quick view has it', () => {
    const h = handlers();
    render(
      <QuickViewDrawer
        item={item()}
        qty={5}
        onAdd={h.onAdd}
        onDec={h.onDec}
        onSetQty={h.onSetQty}
        onClose={vi.fn()}
      />,
    );
    const button = screen.getByRole('button', { name: 'Add all 67 available: Graph Paper Pad' });
    fireEvent.click(button);
    expect(h.onSetQty).toHaveBeenCalledTimes(1);
    expect(h.onSetQty).toHaveBeenCalledWith('pad', 67);
    expect(h.onAdd).not.toHaveBeenCalled();
  });
});

// Decisions, not oversights: these count something else or are narrow mini
// controls beside a catalog card that has the button.
describe('where Add all is not offered', () => {
  const noAddAll = () => {
    expect(document.querySelector('.sf-add-all')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Add (all|10,000)/ })).toBeNull();
    expect(screen.queryByText(/^Add all/)).toBeNull();
  };

  it('the Frequently ordered strip', () => {
    const h = handlers();
    render(
      <FreqCarousel
        entries={[{ item: item(), count: 4 }]}
        qtyByItemId={new Map()}
        loading={false}
        {...h}
      />,
    );
    expect(screen.getByText('Graph Paper Pad')).toBeInTheDocument();
    noAddAll();
  });

  it('the cart rail', () => {
    render(
      <CartProvider
        initial={{
          ...initialCartState({ warehouseId: 'wh', fulfillmentType: 'pickup' }),
          lines: [{ itemId: 'pad', quantity: 5 }],
        }}
      >
        <CartRail
          itemMap={new Map([['pad', item()]])}
          suggestions={[]}
          context={{
            warehouseName: 'North',
            method: 'pickup',
            siteName: null,
            requesterLabel: 'For you',
          }}
          onAdd={vi.fn()}
          onDec={vi.fn()}
          onSetQty={vi.fn()}
          onReview={vi.fn()}
          orgTimezone="America/Los_Angeles"
        />
      </CartProvider>,
    );
    expect(
      within(screen.getByLabelText('Order cart')).getByText('Graph Paper Pad'),
    ).toBeInTheDocument();
    noAddAll();
  });

  it('a kit card', () => {
    const kit: KitOffer = {
      bundleId: 'bundle-starter',
      name: 'Starter Bundle',
      sku: null,
      components: [{ anchorItemId: 'pad', itemIds: ['pad'], perKit: 1 }],
    };
    render(
      <KitCard
        kit={kit}
        itemMap={new Map([['pad', item()]])}
        qtyByItemId={new Map()}
        shares={undefined}
        onSetKits={vi.fn()}
      />,
    );
    expect(screen.getByText('Starter Bundle')).toBeInTheDocument();
    noAddAll();
  });
});

describe('Add all costs nothing in speed', () => {
  it('a card whose quantity did not change is not drawn again when another card fills', () => {
    const h = handlers();
    // Each card reads its item's name while it draws: a counted read says
    // whether the card drew again.
    const reads = { pad: 0, pen: 0 };
    const counted = (base: CatalogItem, key: 'pad' | 'pen'): CatalogItem => {
      const { name, ...rest } = base;
      return Object.defineProperty({ ...rest } as CatalogItem, 'name', {
        enumerable: true,
        get() {
          reads[key] += 1;
          return name;
        },
      });
    };
    const PAD = counted(item(), 'pad');
    const PEN = counted(
      item({ id: 'pen', sku: 'PEN-01', name: 'Felt Pen', quantityOnHand: 40 }),
      'pen',
    );
    function Pair({ padQty }: { padQty: number }) {
      return (
        <>
          <ProductCard item={PAD} qty={padQty} {...h} />
          <ProductCard item={PEN} qty={0} {...h} />
        </>
      );
    }
    const { rerender } = render(<Pair padQty={0} />);
    const first = { ...reads };
    expect(first.pad).toBeGreaterThan(0);
    expect(first.pen).toBeGreaterThan(0);
    rerender(<Pair padQty={67} />);
    expect(reads.pad).toBeGreaterThan(first.pad);
    expect(reads.pen).toBe(first.pen);
  });

  it('the control takes no prop it did not take before', () => {
    const src = readFileSync(path.resolve(__dirname, 'storefront-cards.tsx'), 'utf8');
    const from = src.indexOf('interface AddControlProps {');
    const props = src.slice(from, src.indexOf('\n}\n', from) + 2);
    expect(props.replace(/\s+/g, ' ')).toBe(
      'interface AddControlProps { item: CatalogItem; qty: number; onAdd: (itemId: string) => void; onDec: (itemId: string) => void; onSetQty: (itemId: string, quantity: number) => void; }',
    );
    expect(typeof SfAddControl).toBe('function');
  });
});

describe('Add all: the guards', () => {
  const here = (rel: string) => readFileSync(path.resolve(__dirname, rel), 'utf8');

  it('is a 44 px touch target at phone widths', () => {
    const css = here('storefront.css');
    const from = css.indexOf('@media (max-width: 639.98px) {');
    const end = css.indexOf('min-height: 44px;', css.indexOf('.sp-storefront .sf-add,', from));
    const list = css.slice(css.lastIndexOf('}', end), end);
    expect(list).toContain('.sp-storefront .sf-add,');
    expect(list).toContain('.sp-storefront .sf-add-all,');
    expect(list).toContain('.sp-storefront .sf-step,');
    // The button carries sf-add as well, which is in the 44 px list.
    const src = here('storefront-cards.tsx');
    expect(src).toMatch(/className="sf-add sf-add-all"/);
  });

  // The public order link can hide stock counts or have no cap, and the
  // customer portal ships out-of-stock items later: neither gets the button.
  it.each([
    '../public-v2/public-item-card.tsx',
    '../public-v2/public-cart-rail.tsx',
    '../public-v2/public-orders-v2.tsx',
    '../../portal/portal-shop.tsx',
  ])('%s has no Add all and does not use the member control', (rel) => {
    const src = here(rel);
    expect(src).not.toMatch(/Add all/i);
    expect(src).not.toMatch(/\bSfAddControl\b/);
    expect(src).not.toMatch(/\baddAll(Target|State|ButtonCopy|LabelCopy|WordsCopy)\b/);
    expect(src).not.toContain('sf-add-all');
  });

  it('the member control is used by the grid card, the list row and the quick view only', () => {
    const cards = here('storefront-cards.tsx');
    const overlays = here('storefront-overlays.tsx');
    expect(cards.split('<SfAddControl').length - 1).toBe(2);
    expect(overlays.split('<SfAddControl').length - 1).toBe(1);
    for (const rel of ['storefront-cart.tsx', 'storefront-kit-card.tsx', 'orders-storefront.tsx']) {
      expect(here(rel), rel).not.toMatch(/\bSfAddControl\b/);
    }
  });

  it('the quantity comes from the shared rule, so the web and the phone agree', () => {
    const src = here('storefront-cards.tsx');
    const fn = src.slice(
      src.indexOf('export function SfAddControl('),
      src.indexOf('/* ---- product card (grid)'),
    );
    expect(fn).toContain('addAllState(available, qty)');
    expect(fn).toContain('onSetQty(item.id, addAllTarget(available))');
    expect(fn).toContain('addAllButtonCopy(available)');
    expect(fn).toContain('addAllLabelCopy(item.name, available, qty)');
  });
});
