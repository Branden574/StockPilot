import { act, fireEvent, render, screen, within } from '@testing-library/react';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { toast } from 'sonner';

import {
  ORDER_ITEM_HIDDEN_COPY,
  ORDER_ITEMS_MANAGE_BUTTON_COPY,
  STOREFRONT_LINE_NOT_LISTED_COPY,
  STOREFRONT_LINE_NOT_ORDERABLE_COPY,
  SUBMIT_REMOVE_UNORDERABLE_COPY,
} from '@stockpilot/core';

import { initialCartState, orderDraftPrefixFor } from '../v2/cart-context';
import type { CatalogItem } from '../v2/types';

// ═══ STALE CARTS ON THE WEB (ordering visibility, design 6.5 and 7.2 item 9) ═══
//
// The New order page with the real cart rail and review: a line whose item
// left this catalog (hidden from Orders, archived, out of scope) or that the
// server refused is kept, named without its id, can be lowered or removed but
// never raised, and blocks Submit until it is edited. Nothing is dropped and
// no partial order is sent. The catalog is re-read on focus, and when the
// review opens, once it is older than a minute. The Manage order items entry
// shows only with the capability the server page computed.

const push = vi.fn();
const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh }) }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/components/onboarding/page-tour', () => ({ PageTour: () => null }));
vi.mock('@/components/perf/perf-useful', () => ({ usePerfUseful: () => {} }));

const createOrderRequestAction = vi.fn();
vi.mock('@/server/actions/order-requests', () => ({
  createOrderRequestAction: (...args: unknown[]) => createOrderRequestAction(...args),
  getOrderSubmissionAction: vi.fn(),
  withdrawOrderSubmissionAction: vi.fn(),
}));

vi.mock('./storefront-cards', async (importOriginal) => {
  const real = await importOriginal<typeof import('./storefront-cards')>();
  return {
    ...real,
    ProductCard: ({ item, onAdd }: { item: CatalogItem; onAdd: (id: string) => void }) => (
      <button type="button" onClick={() => onAdd(item.id)}>
        Add {item.name}
      </button>
    ),
    CompactRow: () => null,
    CategorySection: ({ children }: { children: React.ReactNode }) => <section>{children}</section>,
    FreqCarousel: () => null,
    SfPhoto: () => null,
    CharterTag: () => null,
  };
});

import { OrdersStorefront, type StorefrontCatalogData } from './orders-storefront';

const ORG = '0a000000-0000-4000-8000-000000000001';
const WH = '0a000000-0000-4000-8000-0000000000a1';
const USER = '6d80b722-1e44-4059-aa99-efd69718cb14';
const CHROME = '0a000000-0000-4000-8000-0000000000e1';
const CABLE = '0a000000-0000-4000-8000-0000000000e3';
/** An item the cart remembers but this catalog no longer lists. */
const GONE = '0a000000-0000-4000-8000-0000000000e9';

function item(id: string, name: string): CatalogItem {
  return {
    id,
    sku: name.toUpperCase().replace(/\s+/g, '-'),
    name,
    warehouseId: WH,
    quantityOnHand: 20,
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
const ITEMS = [item(CHROME, 'Chromebook'), item(CABLE, 'HDMI Cable')];

function settled<T>(value: T): Promise<T> {
  const p = Promise.resolve(value) as Promise<T> & { status: string; value: T };
  p.status = 'fulfilled';
  p.value = value;
  return p;
}

function page(opts: { canManageOrderItems?: boolean } = {}) {
  return (
    <OrdersStorefront
      warehouses={[{ id: WH, name: 'North' }]}
      warehouseId={WH}
      catalogPromise={settled<StorefrontCatalogData>({ items: ITEMS, aisles: [] })}
      frequentlyOrderedPromise={settled([])}
      kitsPromise={settled({ status: 'ok' as const, kits: [] })}
      kitsEnabled={false}
      chartersForWarehouse={[]}
      canActOnBehalf={false}
      viewerName="Pat Example"
      viewerEmail="pat@example.test"
      orgTimezone="America/Los_Angeles"
      deliveryRecipients={null}
      viewerUserId={USER}
      organizationId={ORG}
      canApproveOrders={false}
      canManageOrderItems={opts.canManageOrderItems}
    />
  );
}

async function openPage(opts?: { canManageOrderItems?: boolean }) {
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(page(opts));
  });
  return view;
}

function saveDraft(lines: Array<{ itemId: string; quantity: number }>) {
  localStorage.setItem(
    `${orderDraftPrefixFor(USER)}${WH}`,
    JSON.stringify({ ...initialCartState({ warehouseId: WH, fulfillmentType: 'pickup' }), lines }),
  );
}

const cart = () => screen.getByLabelText('Order cart');
const lineOf = (text: string) => {
  const line = within(cart()).getByText(text).closest('.sf-line');
  if (!(line instanceof HTMLElement)) throw new Error(`no cart line for ${text}`);
  return line;
};
const qtyOf = (line: HTMLElement) =>
  (within(line).getByLabelText('Quantity') as HTMLInputElement).value;
function review() {
  fireEvent.click(screen.getByRole('button', { name: /review order/i }));
}
function submit() {
  fireEvent.click(screen.getByRole('button', { name: /submit order request/i }));
}
const dialog = () => screen.getByRole('dialog', { name: 'Review order request' });

beforeEach(() => {
  localStorage.clear();
  push.mockReset();
  refresh.mockReset();
  createOrderRequestAction.mockReset();
  vi.mocked(toast.error).mockClear();
});
afterEach(() => {
  localStorage.clear();
  vi.useRealTimers();
});

describe('a cart line whose item left this catalog', () => {
  it('is kept and named without its id, can be lowered and removed but never raised, and blocks Submit until it is removed', async () => {
    saveDraft([
      { itemId: GONE, quantity: 3 },
      { itemId: CHROME, quantity: 1 },
    ]);
    await openPage();

    const line = lineOf(STOREFRONT_LINE_NOT_LISTED_COPY);
    expect(within(line).getByText(STOREFRONT_LINE_NOT_ORDERABLE_COPY)).toBeInTheDocument();
    // Never the raw id, in the cart or in the review.
    expect(document.body.textContent).not.toContain(GONE);
    expect(within(line).getByRole('button', { name: 'Increase quantity' })).toBeDisabled();

    // Lowering is allowed.
    fireEvent.click(within(line).getByRole('button', { name: 'Decrease quantity' }));
    expect(qtyOf(lineOf(STOREFRONT_LINE_NOT_LISTED_COPY))).toBe('2');

    // Submit waits for it: said in the review, nothing sent.
    review();
    expect(within(dialog()).queryByText(GONE)).toBeNull();
    expect(within(dialog()).getByText(STOREFRONT_LINE_NOT_LISTED_COPY)).toBeInTheDocument();
    await act(async () => submit());
    expect(within(dialog()).getByRole('alert').textContent).toContain(
      SUBMIT_REMOVE_UNORDERABLE_COPY,
    );
    expect(createOrderRequestAction).not.toHaveBeenCalled();
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Close review' }));

    // Removed: the rest of the cart is sent as it is.
    fireEvent.click(
      within(lineOf(STOREFRONT_LINE_NOT_LISTED_COPY)).getByRole('button', {
        name: 'Remove this item from cart',
      }),
    );
    expect(within(cart()).queryByText(STOREFRONT_LINE_NOT_LISTED_COPY)).toBeNull();
    createOrderRequestAction.mockReturnValueOnce(new Promise(() => {}));
    review();
    await act(async () => submit());
    expect(createOrderRequestAction).toHaveBeenCalledTimes(1);
    const body = createOrderRequestAction.mock.calls[0]![0] as { lines: Array<{ itemId: string }> };
    expect(body.lines).toEqual([{ itemId: CHROME, quantity: 1 }]);
  });
});

describe('a line the server refused as hidden from Orders', () => {
  it('says so under its name, cannot be raised from its card or the cart, and keeps the other lines', async () => {
    await openPage();
    fireEvent.click(screen.getByText('Add Chromebook'));
    fireEvent.click(screen.getByText('Add HDMI Cable'));
    createOrderRequestAction.mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'validation_error',
        message: 'x',
        details: {
          reason: 'item_not_orderable',
          settled: true,
          replay: false,
          items: { [CABLE]: 'hidden_from_orders' },
        },
      },
    });
    review();
    await act(async () => submit());
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Close review' }));

    const line = lineOf('HDMI Cable');
    expect(within(line).getByText(ORDER_ITEM_HIDDEN_COPY)).toBeInTheDocument();
    expect(within(line).getByRole('button', { name: 'Increase quantity' })).toBeDisabled();

    // The card still shows until the catalog is re-read; Add does not raise it.
    fireEvent.click(screen.getByText('Add HDMI Cable'));
    expect(qtyOf(lineOf('HDMI Cable'))).toBe('1');
    expect(toast.error).toHaveBeenCalledWith(STOREFRONT_LINE_NOT_ORDERABLE_COPY);

    // The shown item is kept and can still be raised.
    fireEvent.click(screen.getByText('Add Chromebook'));
    expect(qtyOf(lineOf('Chromebook'))).toBe('2');
  });
});

describe('the catalog is re-read once it is older than a minute', () => {
  it('on focus and on return to the tab, at most once a minute, and never while fresh', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-10-26T15:00:00Z'));
    await openPage();

    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(refresh).not.toHaveBeenCalled();

    vi.setSystemTime(new Date('2026-10-26T15:01:01Z'));
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(refresh).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date('2026-10-26T15:02:02Z'));
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('when the review opens', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-10-26T15:00:00Z'));
    await openPage();
    fireEvent.click(screen.getByText('Add Chromebook'));
    review();
    expect(refresh).not.toHaveBeenCalled();
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Close review' }));

    vi.setSystemTime(new Date('2026-10-26T15:01:30Z'));
    review();
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

describe('Manage order items in the header', () => {
  it('links to the management page only for a member the server page allowed', async () => {
    const { unmount } = await openPage({ canManageOrderItems: true });
    const link = screen.getByRole('link', { name: ORDER_ITEMS_MANAGE_BUTTON_COPY });
    expect(link.getAttribute('href')).toBe('/dashboard/orders/manage-items');
    unmount();

    await openPage({ canManageOrderItems: false });
    expect(screen.queryByRole('link', { name: ORDER_ITEMS_MANAGE_BUTTON_COPY })).toBeNull();
  });

  it('is hidden when the page does not say', async () => {
    await openPage();
    expect(screen.queryByRole('link', { name: ORDER_ITEMS_MANAGE_BUTTON_COPY })).toBeNull();
  });
});
