import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ORDER_DRAFT_PREFIX } from '../v2/cart-context';
import type { CatalogItem } from '../v2/types';

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
      chartersForWarehouse={[]}
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

const savedDraft = (warehouseId: string) => {
  const raw = localStorage.getItem(`${ORDER_DRAFT_PREFIX}${warehouseId}`);
  return raw ? (JSON.parse(raw) as { warehouseId: string; lines: unknown[] }) : null;
};

describe('OrdersStorefront — switching warehouse', () => {
  beforeEach(() => {
    localStorage.clear();
    push.mockReset();
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
});
