import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ORDER_DRAFT_PREFIX } from '../v2/cart-context';
import type { CartState, CatalogItem, StorefrontCharter } from '../v2/types';

// ═══ A WAREHOUSE SWITCH GIVES THAT WAREHOUSE ITS OWN CART ═══
//
// Local walk, 2026-09-26: New order opened on QA Annex, switched to QA Main DC
// with the page's warehouse control, added QA Chromebook, Submit. The server
// refused it with "Every line must be at the chosen warehouse": the request
// carried warehouseId = QA Annex. The switch is a router.push to
// ?warehouseId=<new>, and Next keys the page without its search params, so the
// storefront is NOT remounted. The cart's reducer kept the warehouse it was
// mounted with, the draft saved under the Annex key, and clearCartDraft used
// the page's (new) warehouse, which was not the key the save used.
//
// A router.push that only changes the search params keeps the same component
// and hands it new props. `rerender` with the next warehouse is exactly that.

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const createOrderRequestAction = vi.fn();
vi.mock('@/server/actions/order-requests', () => ({
  createOrderRequestAction: (input: unknown) => createOrderRequestAction(input),
}));

vi.mock('@/components/onboarding/page-tour', () => ({ PageTour: () => null }));
vi.mock('@/components/perf/perf-useful', () => ({ usePerfUseful: () => {} }));

// The cards pull next/image and the catalog styling; an Add button per item is
// all this file needs from them.
vi.mock('./storefront-cards', () => ({
  ProductCard: ({ item, onAdd }: { item: CatalogItem; onAdd: (id: string) => void }) => (
    <button type="button" onClick={() => onAdd(item.id)}>
      Add {item.name}
    </button>
  ),
  CompactRow: () => null,
  CategorySection: ({ children }: { children: React.ReactNode }) => <section>{children}</section>,
  EmptyResults: () => null,
  FreqCarousel: () => null,
  SfPhoto: () => null,
  CharterTag: () => null,
  QtyField: ({ qty }: { qty: number }) => <span data-testid="qty">{qty}</span>,
}));

// The review modal reduced to its two buttons; SfPopover as a plain dialog so
// the warehouse control can be clicked.
vi.mock('./storefront-overlays', () => ({
  SfPopover: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div role="dialog">{children}</div> : null,
  QuickViewDrawer: () => null,
  ReviewModal: ({
    stage,
    onConfirm,
    onDone,
  }: {
    stage: null | 'review' | 'success';
    onConfirm: () => void;
    onDone: () => void;
  }) =>
    stage === 'review' ? (
      <button type="button" onClick={onConfirm}>
        Confirm &amp; submit
      </button>
    ) : stage === 'success' ? (
      <button type="button" onClick={onDone}>
        Done
      </button>
    ) : null,
}));

import { toast } from 'sonner';

import { OrdersStorefront, type StorefrontCatalogData } from './orders-storefront';

const MAIN = 'wh-main';
const ANNEX = 'wh-annex';

function item(id: string, name: string, warehouseId: string): CatalogItem {
  return {
    id,
    sku: id.toUpperCase(),
    name,
    warehouseId,
    quantityOnHand: 10,
    reservedQuantity: 0,
    itemType: null,
    categoryId: null,
    categoryName: null,
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

const CATALOGS: Record<string, CatalogItem[]> = {
  [MAIN]: [item('chromebook', 'Chromebook', MAIN)],
  [ANNEX]: [item('cable', 'HDMI Cable', ANNEX)],
};

function site(id: string, name: string): StorefrontCharter {
  return { id, name, code: null, address: null };
}

/** The delivery sites each warehouse services (warehouse_charters). */
const SITES: Record<string, StorefrontCharter[]> = {
  [MAIN]: [site('site-main', 'Main Campus')],
  [ANNEX]: [site('site-annex', 'Annex Campus')],
};

/** An already-settled promise, so React.use reads it without suspending. */
function settled<T>(value: T): Promise<T> {
  const p = Promise.resolve(value) as Promise<T> & { status: string; value: T };
  p.status = 'fulfilled';
  p.value = value;
  return p;
}

function page(warehouseId: string) {
  return (
    <OrdersStorefront
      warehouses={[
        { id: MAIN, name: 'Main DC' },
        { id: ANNEX, name: 'Annex' },
      ]}
      warehouseId={warehouseId}
      catalogPromise={settled<StorefrontCatalogData>({ items: CATALOGS[warehouseId]!, aisles: [] })}
      frequentlyOrderedPromise={settled([])}
      chartersForWarehouse={SITES[warehouseId]!}
      viewerRole="manager"
      viewerName="QA Manager"
      viewerEmail="manager@example.test"
      orgTimezone="America/Los_Angeles"
      deliveryRecipients={null}
    />
  );
}

async function openPage(warehouseId: string) {
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(page(warehouseId));
  });
  return view;
}

/** What the page's warehouse control does, then what Next does with the push. */
async function switchWarehouse(view: ReturnType<typeof render>, name: string, id: string) {
  fireEvent.click(screen.getByText('Warehouse'));
  fireEvent.click(within(screen.getByRole('dialog')).getByText(name));
  expect(push).toHaveBeenLastCalledWith(`/dashboard/orders/new?warehouseId=${id}`);
  await act(async () => {
    view.rerender(page(id));
  });
}

const cartLines = () =>
  within(screen.getByLabelText('Order cart'))
    .queryAllByText(/.+/, { selector: '.sf-line .nm' })
    .map((el) => el.textContent);

/** Wait out the cart's 250 ms save debounce. */
async function pastSaveDebounce() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 400));
  });
}

const fulfillment = (mode: 'Pickup' | 'Delivery') =>
  within(screen.getByRole('radiogroup', { name: 'Fulfillment type' })).getByRole('button', {
    name: new RegExp(mode, 'i'),
  });

/** Open the Deliver to control in the setup bar and choose a site. */
function chooseSite(name: string) {
  fireEvent.click(screen.getByText('Deliver to'));
  fireEvent.click(within(screen.getByRole('dialog')).getByText(name));
}

/** The site the setup bar's Deliver to control shows. */
const deliverTo = () =>
  screen.getByText('Deliver to').parentElement!.querySelector('.vl')!.textContent!.trim();

function submitAndConfirm() {
  fireEvent.click(screen.getByRole('button', { name: /submit order request/i }));
  fireEvent.click(screen.getByRole('button', { name: /confirm & submit/i }));
}

const savedDraft = (warehouseId: string) => {
  const raw = localStorage.getItem(`${ORDER_DRAFT_PREFIX}${warehouseId}`);
  return raw ? (JSON.parse(raw) as { warehouseId: string; lines: unknown[] }) : null;
};

describe('OrdersStorefront — switching warehouse', () => {
  beforeEach(() => {
    localStorage.clear();
    push.mockReset();
    vi.mocked(toast.error).mockReset();
    createOrderRequestAction.mockReset();
    createOrderRequestAction.mockResolvedValue({
      ok: true,
      data: { id: 'order-1', orderNumber: 7 },
    });
  });
  afterEach(() => {
    localStorage.clear();
  });

  it("starts a fresh cart for the new warehouse and leaves the first warehouse's draft alone", async () => {
    const view = await openPage(MAIN);
    fireEvent.click(screen.getByText('Add Chromebook'));
    await waitFor(() =>
      expect(savedDraft(MAIN)).toMatchObject({
        warehouseId: MAIN,
        lines: [{ itemId: 'chromebook', quantity: 1 }],
      }),
    );

    await switchWarehouse(view, 'Annex', ANNEX);
    expect(cartLines()).toEqual([]);

    fireEvent.click(screen.getByText('Add HDMI Cable'));
    expect(cartLines()).toEqual(['HDMI Cable']);
    await waitFor(() =>
      expect(savedDraft(ANNEX)).toMatchObject({
        warehouseId: ANNEX,
        lines: [{ itemId: 'cable', quantity: 1 }],
      }),
    );
    expect(savedDraft(MAIN)).toMatchObject({
      warehouseId: MAIN,
      lines: [{ itemId: 'chromebook', quantity: 1 }],
    });
  });

  it("submits for the warehouse on screen and clears only that warehouse's draft", async () => {
    const view = await openPage(MAIN);
    fireEvent.click(screen.getByText('Add Chromebook'));
    await waitFor(() => expect(savedDraft(MAIN)).not.toBeNull());

    await switchWarehouse(view, 'Annex', ANNEX);
    fireEvent.click(screen.getByText('Add HDMI Cable'));
    await pastSaveDebounce();

    fireEvent.click(screen.getByRole('button', { name: /submit order request/i }));
    fireEvent.click(screen.getByRole('button', { name: /confirm & submit/i }));

    await waitFor(() => expect(createOrderRequestAction).toHaveBeenCalledTimes(1));
    expect(createOrderRequestAction.mock.calls[0]![0]).toMatchObject({
      warehouseId: ANNEX,
      lines: [{ itemId: 'cable', quantity: 1 }],
    });

    await screen.findByRole('button', { name: 'Done' });
    expect(savedDraft(ANNEX)).toBeNull();
    expect(savedDraft(MAIN)).toMatchObject({ lines: [{ itemId: 'chromebook', quantity: 1 }] });

    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    // Done must not write the placed order back once the debounce has run.
    await pastSaveDebounce();
    expect(savedDraft(ANNEX)).toBeNull();
    expect(savedDraft(MAIN)).toMatchObject({ lines: [{ itemId: 'chromebook', quantity: 1 }] });
  });

  it("switching back restores that warehouse's own draft", async () => {
    const view = await openPage(MAIN);
    fireEvent.click(screen.getByText('Add Chromebook'));
    fireEvent.click(screen.getByText('Add Chromebook'));
    await waitFor(() =>
      expect(savedDraft(MAIN)).toMatchObject({ lines: [{ itemId: 'chromebook', quantity: 2 }] }),
    );

    await switchWarehouse(view, 'Annex', ANNEX);
    fireEvent.click(screen.getByText('Add HDMI Cable'));
    await pastSaveDebounce();

    await switchWarehouse(view, 'Main DC', MAIN);
    expect(cartLines()).toEqual(['Chromebook']);
    expect(screen.getByTestId('qty').textContent).toBe('2');
  });

  it("keeps each warehouse's setup answers with its own cart and restores them on the way back", async () => {
    const view = await openPage(MAIN);
    fireEvent.click(screen.getByText('Add Chromebook'));
    fireEvent.click(fulfillment('Delivery'));
    chooseSite('Main Campus');
    await waitFor(() =>
      expect(savedDraft(MAIN)).toMatchObject({
        fulfillmentType: 'delivery',
        charterId: 'site-main',
      }),
    );

    await switchWarehouse(view, 'Annex', ANNEX);
    expect(fulfillment('Pickup').getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryAllByText('Main Campus')).toEqual([]);

    await switchWarehouse(view, 'Main DC', MAIN);
    expect(fulfillment('Delivery').getAttribute('aria-pressed')).toBe('true');
    expect(deliverTo()).toBe('Main Campus');
  });

  // ═══ A SAVED DRAFT CAN CARRY ANOTHER WAREHOUSE'S DELIVERY SITE ═══
  //
  // While the bug was live the cart kept the first warehouse, but the Deliver
  // to list was the second warehouse's. Choosing a site there saved that
  // site under the FIRST warehouse's draft. Restored now, the setup bar finds
  // no such site and shows "Choose a site...", yet Submit still sent the stale
  // id and the server refused it with "That site is not serviced by the chosen
  // warehouse." A site this warehouse does not service is no site at all.
  it('treats a restored delivery site that this warehouse does not service as no site', async () => {
    const stale: CartState = {
      warehouseId: MAIN,
      charterId: 'site-annex',
      fulfillmentType: 'delivery',
      onBehalfOf: null,
      notes: '',
      neededBy: '',
      lines: [{ itemId: 'chromebook', quantity: 1 }],
    };
    localStorage.setItem(`${ORDER_DRAFT_PREFIX}${MAIN}`, JSON.stringify(stale));

    await openPage(MAIN);
    expect(cartLines()).toEqual(['Chromebook']);
    expect(deliverTo()).toBe('Choose a site…');

    submitAndConfirm();
    expect(toast.error).toHaveBeenCalledWith('Select a delivery site in the setup bar above.');
    expect(createOrderRequestAction).not.toHaveBeenCalled();

    chooseSite('Main Campus');
    submitAndConfirm();
    await waitFor(() => expect(createOrderRequestAction).toHaveBeenCalledTimes(1));
    expect(createOrderRequestAction.mock.calls[0]![0]).toMatchObject({
      warehouseId: MAIN,
      fulfillmentType: 'delivery',
      deliveryCharterId: 'site-main',
    });
  });
});
