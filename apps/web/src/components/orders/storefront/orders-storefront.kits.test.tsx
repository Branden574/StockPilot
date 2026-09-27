import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CatalogItem } from '../v2/types';

// ═══ KITS ON THE NEW ORDER PAGE (owner decisions 2026-09-27) ═══
//
// "Add kit" puts a bundle's items into the cart as ordinary lines in one step.
// A kit leads its category view and shows in search. A short component
// disables it and is named; the items can still be added one by one. The
// hard-coded "Add full kit" button, which added one of every in-stock item of a
// category named like "new hire" (18 lines in DC4, polos included), is gone.
// The kit card is rendered for real; the item cards are reduced to an Add
// button, as in the warehouse-switch suite.

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const createOrderRequestAction = vi.fn();
vi.mock('@/server/actions/order-requests', () => ({
  createOrderRequestAction: (input: unknown) => createOrderRequestAction(input),
}));
vi.mock('@/components/onboarding/page-tour', () => ({ PageTour: () => null }));
vi.mock('@/components/perf/perf-useful', () => ({ usePerfUseful: () => {} }));

vi.mock('./storefront-cards', () => ({
  ProductCard: ({ item, onAdd }: { item: CatalogItem; onAdd: (id: string) => void }) => (
    <button type="button" data-testid="item-card" onClick={() => onAdd(item.id)}>
      Add {item.name}
    </button>
  ),
  CompactRow: () => null,
  CategorySection: ({ name, children }: { name: string; children: React.ReactNode }) => (
    <section aria-label={`Category ${name}`}>{children}</section>
  ),
  EmptyResults: () => <p>Nothing matches</p>,
  FreqCarousel: () => null,
  SfPhoto: () => null,
  CharterTag: () => null,
  QtyField: ({ qty, itemId }: { qty: number; itemId: string }) => (
    <span data-testid={`qty-${itemId}`}>{qty}</span>
  ),
}));
vi.mock('./storefront-overlays', () => ({
  SfPopover: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div role="dialog">{children}</div> : null,
  QuickViewDrawer: () => null,
  ReviewModal: ({ stage, onConfirm }: { stage: null | 'review' | 'success'; onConfirm: () => void }) =>
    stage === 'review' ? (
      <button type="button" onClick={onConfirm}>
        Confirm &amp; submit
      </button>
    ) : null,
}));

import { OrdersStorefront, type StorefrontCatalogData } from './orders-storefront';
import type { KitOffer, KitsResult } from './storefront-kits';

const DC4 = 'wh-dc4';

function item(id: string, name: string, over: Partial<CatalogItem> = {}): CatalogItem {
  return {
    id,
    sku: id.toUpperCase(),
    name,
    warehouseId: DC4,
    quantityOnHand: 50,
    reservedQuantity: 0,
    itemType: null,
    categoryId: 'cat-new-hire',
    categoryName: 'New Hire',
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

const BACKPACK_18A = item('backpack-18a', 'L4L - New Hire - Backpack', {
  sku: 'SP-X6IN2-E84',
  rackLabel: '18-A',
  quantityOnHand: 60,
});
const BACKPACK_16B = item('backpack-16b', 'L4L - New Hire - Backpack', {
  sku: 'SP-X6IN2-E84',
  rackLabel: '16-B',
  quantityOnHand: 134,
});
const MUG = item('mug', 'L4L - New Hire - Coffee mug', { quantityOnHand: 235 });
const PAD = item('pad', 'L4L - New Hire - Mouse Pad', { quantityOnHand: 204 });
const PLANNER = item('planner', 'L4L - New Hire - Planner', { quantityOnHand: 204 });
const POLO = item('polo-m', "L4L - New Hire - Men's Polo M", { quantityOnHand: 12 });
const CHROMEBOOK = item('chromebook', 'Acer Chromebook 511', {
  categoryId: 'cat-tech',
  categoryName: 'Technology',
});

const NEW_HIRE: KitOffer = {
  bundleId: 'bundle-new-hire',
  name: 'New Hire Bundle',
  sku: null,
  components: [
    { anchorItemId: BACKPACK_18A.id, itemIds: [BACKPACK_18A.id, BACKPACK_16B.id], perKit: 1 },
    { anchorItemId: MUG.id, itemIds: [MUG.id], perKit: 1 },
    { anchorItemId: PAD.id, itemIds: [PAD.id], perKit: 1 },
    { anchorItemId: PLANNER.id, itemIds: [PLANNER.id], perKit: 1 },
  ],
};

function settled<T>(value: T): Promise<T> {
  const p = Promise.resolve(value) as Promise<T> & { status: string; value: T };
  p.status = 'fulfilled';
  p.value = value;
  return p;
}

const AISLES = [
  { id: 'cat-new-hire', name: 'New Hire', itemCount: 6 },
  { id: 'cat-tech', name: 'Technology', itemCount: 1 },
];

async function openPage(
  kits: KitsResult,
  items: CatalogItem[] = [BACKPACK_18A, BACKPACK_16B, MUG, PAD, PLANNER, POLO, CHROMEBOOK],
) {
  await act(async () => {
    render(
      <OrdersStorefront
        warehouses={[{ id: DC4, name: 'DC4' }]}
        warehouseId={DC4}
        catalogPromise={settled<StorefrontCatalogData>({ items, aisles: AISLES })}
        frequentlyOrderedPromise={settled([])}
        kitsPromise={settled(kits)}
        chartersForWarehouse={[]}
        viewerRole="viewer"
        viewerName="Lillian"
        viewerEmail="lillian@example.test"
        orgTimezone="America/Los_Angeles"
        deliveryRecipients={null}
      />,
    );
  });
}

const cart = () => within(screen.getByLabelText('Order cart'));
const cartLines = () =>
  cart()
    .queryAllByText(/.+/, { selector: '.sf-line .nm' })
    .map((el) => el.textContent);
const kitsRow = () => screen.getByRole('region', { name: 'Kits' });

describe('OrdersStorefront: kits', () => {
  beforeEach(() => {
    localStorage.clear();
    createOrderRequestAction.mockReset();
    createOrderRequestAction.mockResolvedValue({ ok: true, data: { id: 'order-1', orderNumber: 9 } });
  });
  afterEach(() => localStorage.clear());

  it('the All view leads with a Kits row: the kit, its items and 194 kits available (both backpack racks)', async () => {
    await openPage({ status: 'ok', kits: [NEW_HIRE] });
    const row = kitsRow();
    expect(within(row).getByText('New Hire Bundle')).toBeTruthy();
    expect(within(row).getByText('4 items: Backpack, Coffee mug, Mouse Pad, Planner')).toBeTruthy();
    expect(within(row).getByText('194 kits available')).toBeTruthy();
  });

  it('Add kit puts one ordinary line per item into the cart, from the named 18-A row', async () => {
    await openPage({ status: 'ok', kits: [NEW_HIRE] });
    fireEvent.click(within(kitsRow()).getByRole('button', { name: 'Add kit: New Hire Bundle' }));
    expect(cartLines()).toEqual([
      'L4L - New Hire - Backpack',
      'L4L - New Hire - Coffee mug',
      'L4L - New Hire - Mouse Pad',
      'L4L - New Hire - Planner',
    ]);
    // The stepper now counts kits.
    expect(within(kitsRow()).getByTestId(`qty-${NEW_HIRE.bundleId}`).textContent).toBe('1');
    fireEvent.click(within(kitsRow()).getByRole('button', { name: 'One kit more: New Hire Bundle' }));
    expect(within(kitsRow()).getByTestId(`qty-${NEW_HIRE.bundleId}`).textContent).toBe('2');
    fireEvent.click(within(kitsRow()).getByRole('button', { name: 'One kit less: New Hire Bundle' }));
    fireEvent.click(within(kitsRow()).getByRole('button', { name: 'One kit less: New Hire Bundle' }));
    expect(cartLines()).toEqual([]);
  });

  it('submits the item lines, with the kit recorded for the audit entry only', async () => {
    await openPage({ status: 'ok', kits: [NEW_HIRE] });
    fireEvent.click(within(kitsRow()).getByRole('button', { name: 'Add kit: New Hire Bundle' }));
    fireEvent.click(screen.getByText('Add L4L - New Hire - Coffee mug'));
    fireEvent.click(screen.getByRole('button', { name: /submit order request/i }));
    fireEvent.click(screen.getByRole('button', { name: /confirm & submit/i }));
    await waitFor(() => expect(createOrderRequestAction).toHaveBeenCalledTimes(1));
    expect(createOrderRequestAction.mock.calls[0]![0]).toMatchObject({
      lines: [
        { itemId: BACKPACK_18A.id, quantity: 1 },
        { itemId: MUG.id, quantity: 2 },
        { itemId: PAD.id, quantity: 1 },
        { itemId: PLANNER.id, quantity: 1 },
      ],
      kits: [{ bundleId: NEW_HIRE.bundleId, count: 1 }],
    });
  });

  it('a short component disables Add kit and names it; its other items can still be added one by one', async () => {
    await openPage({ status: 'ok', kits: [NEW_HIRE] }, [
      { ...BACKPACK_18A, quantityOnHand: 0 },
      { ...BACKPACK_16B, quantityOnHand: 0 },
      MUG,
      PAD,
      PLANNER,
    ]);
    const row = kitsRow();
    const add = within(row).getByRole('button', { name: 'Add kit: New Hire Bundle' }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    expect(within(row).getByText('Out of stock: Backpack')).toBeTruthy();
    fireEvent.click(add);
    expect(cartLines()).toEqual([]);
    fireEvent.click(screen.getByText('Add L4L - New Hire - Coffee mug'));
    expect(cartLines()).toEqual(['L4L - New Hire - Coffee mug']);
  });

  it('Details list the racks of a component that spans rows and what limits the kit', async () => {
    await openPage({ status: 'ok', kits: [NEW_HIRE] }, [
      BACKPACK_18A,
      BACKPACK_16B,
      MUG,
      { ...PAD, quantityOnHand: 150 },
      PLANNER,
    ]);
    fireEvent.click(within(kitsRow()).getByRole('button', { name: 'Details' }));
    expect(within(kitsRow()).getByText('Backpack ×1 (2 racks)')).toBeTruthy();
    expect(within(kitsRow()).getByText('18-A (60), 16-B (134)')).toBeTruthy();
    expect(within(kitsRow()).getByText('Limited by Mouse Pad (150)')).toBeTruthy();
  });

  it('the kit card leads its category view and shows in search; other categories do not show it', async () => {
    await openPage({ status: 'ok', kits: [NEW_HIRE] });
    fireEvent.click(screen.getByRole('button', { name: /^New Hire/ }));
    await waitFor(() => expect(screen.getByText('New Hire Bundle')).toBeTruthy());
    // The kit card comes before the first item card.
    const kitCard = screen.getByText('New Hire Bundle').closest('.sf-kit-card')!;
    const firstItem = screen.getAllByTestId('item-card')[0]!;
    expect(kitCard.compareDocumentPosition(firstItem) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /^Technology/ }));
    await waitFor(() => expect(screen.queryByText('New Hire Bundle')).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: /^Technology/ })); // back to All
    fireEvent.change(screen.getByLabelText('Search catalog'), { target: { value: 'bundle' } });
    await waitFor(() => expect(screen.getByText('New Hire Bundle')).toBeTruthy());
    expect(screen.queryByText('Nothing matches')).toBeNull();
  });

  it('there is no "Add full kit" button any more, on any category', async () => {
    await openPage({ status: 'ok', kits: [] });
    expect(screen.queryByText(/add full kit/i)).toBeNull();
    // With no kits the Kits row is not drawn at all.
    expect(screen.queryByRole('region', { name: 'Kits' })).toBeNull();
  });

  it('a failed kits read says so, and is never shown as "no kits"', async () => {
    await openPage({ status: 'error' });
    expect(screen.getByText(/Kits could not be loaded/)).toBeTruthy();
  });
});
