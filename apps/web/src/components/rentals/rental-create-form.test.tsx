import { act, fireEvent, render, screen } from '@testing-library/react';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CatalogItem } from '@/components/orders/v2/types';

// ═══ THE RENTAL CART ONLY CHECKS OUT WHAT IT SHOWS ═══
//
// Demo Co, 2026-09-24: "Check out" failed with "One or more items are not
// rental items." The cart had opened the Orders draft for the same warehouse
// (both pages saved under one key), drew only the line it could find in its
// rental catalog, and submitted all three. Pinned here: the rental cart opens
// only its own draft; a saved line it cannot show is shown as unavailable and
// blocks checkout; switching warehouses loads that warehouse's catalog.

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

const toastError = vi.fn();
vi.mock('sonner', () => ({ toast: { error: (m: string) => toastError(m), success: vi.fn() } }));

const createRentalAction = vi.fn();
vi.mock('@/server/actions/rentals', () => ({
  createRentalAction: (input: unknown) => createRentalAction(input),
}));

const thumbs = vi.hoisted(() => ({
  urls: [] as Array<string | null>,
  answer: {} as Record<string, string>,
}));
vi.mock('@/lib/use-catalog-thumbnails', () => ({
  useCatalogThumbnails: (url: string | null) => {
    thumbs.urls.push(url);
    return url ? thumbs.answer : {};
  },
}));
const gridItems = vi.hoisted(() => ({ current: [] as Array<{ id: string; imageUrl: string | null }> }));
vi.mock('@/components/orders/v2/aisle-bar', () => ({ AisleBar: () => null }));
vi.mock('@/components/orders/v2/toolbar', () => ({ Toolbar: () => null }));
vi.mock('@/components/orders/v2/catalog-grid', () => ({
  CatalogGrid: ({ items }: { items: Array<{ id: string; imageUrl: string | null }> }) => {
    gridItems.current = items;
    return null;
  },
}));

vi.mock('@/components/rentals/borrower-picker', () => ({
  BorrowerPicker: ({
    onChange,
  }: {
    onChange: (v: { borrowerUserId: null; borrowerName: string; borrowerEmail: null }) => void;
  }) => (
    <input
      aria-label="Borrower"
      onChange={(e) =>
        onChange({ borrowerUserId: null, borrowerName: e.target.value, borrowerEmail: null })
      }
    />
  ),
}));

// A plain <select> stands in for the Radix one, so a test can pick a value.
vi.mock('@/components/ui/select', () => {
  const Ctx = React.createContext<{ onValueChange: (v: string) => void; value: string } | null>(
    null,
  );
  return {
    Select: ({
      value,
      onValueChange,
      children,
    }: {
      value: string;
      onValueChange: (v: string) => void;
      children: React.ReactNode;
    }) => <Ctx.Provider value={{ value, onValueChange }}>{children}</Ctx.Provider>,
    SelectTrigger: () => null,
    SelectValue: () => null,
    SelectContent: ({ children }: { children: React.ReactNode }) => {
      const ctx = React.useContext(Ctx)!;
      return (
        <select
          aria-label="Warehouse"
          value={ctx.value}
          onChange={(e) => ctx.onValueChange(e.target.value)}
        >
          {children}
        </select>
      );
    },
    SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => (
      <option value={value}>{children}</option>
    ),
  };
});

import { RentalCreateForm } from './rental-create-form';

const TENT: CatalogItem = {
  id: 'tent',
  sku: 'RENT-1',
  name: 'Event tent',
  warehouseId: 'wh-1',
  quantityOnHand: 5,
  reservedQuantity: 0,
  itemType: 'product',
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

function savedCart(key: string, lines: Array<{ itemId: string; quantity: number }>) {
  localStorage.setItem(
    key,
    JSON.stringify({
      warehouseId: 'wh-1',
      charterId: null,
      fulfillmentType: 'pickup',
      onBehalfOf: null,
      notes: '',
      neededBy: '',
      lines,
    }),
  );
}

function renderForm(items: CatalogItem[] = [TENT]) {
  return render(
    <RentalCreateForm
      warehouses={[
        { id: 'wh-1', name: 'Main' },
        { id: 'wh-2', name: 'Annex' },
      ]}
      warehouseId="wh-1"
      items={items}
      aisles={[]}
      members={[]}
      viewerRole="admin"
    />,
  );
}

const checkOut = () => screen.getByRole('button', { name: 'Check out' });

describe('RentalCreateForm — the cart checks out only what it shows', () => {
  beforeEach(() => {
    localStorage.clear();
    push.mockReset();
    toastError.mockReset();
    createRentalAction.mockReset();
  });
  afterEach(() => localStorage.clear());

  it('does not open the Orders basket for the same warehouse', () => {
    savedCart('order-draft:wh-1', [
      { itemId: 'stapler', quantity: 1 },
      { itemId: 'paper', quantity: 1 },
    ]);
    renderForm();
    expect(screen.getByText('Add items from the catalog.')).toBeTruthy();
    expect((checkOut() as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows a saved line it cannot find, and refuses to check out until it is removed', async () => {
    savedCart('rental-draft:wh-1', [
      { itemId: 'tent', quantity: 1 },
      { itemId: 'gone', quantity: 2 },
    ]);
    renderForm();

    expect(screen.getByText('Event tent')).toBeTruthy();
    expect(screen.getByText(/no longer available to rent here/)).toBeTruthy();

    fireEvent.click(checkOut());
    expect(toastError).toHaveBeenCalledWith(
      'Remove the items that are no longer available to rent, then check out.',
    );
    expect(createRentalAction).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Remove unavailable item' }));
    expect(screen.queryByText(/no longer available to rent here/)).toBeNull();

    createRentalAction.mockResolvedValue({ ok: true, data: { id: 'rental-1' } });
    fireEvent.change(screen.getByLabelText('Borrower'), { target: { value: 'Ana' } });
    await act(async () => {
      fireEvent.click(checkOut());
    });
    expect(createRentalAction).toHaveBeenCalledTimes(1);
    expect(createRentalAction.mock.calls[0]![0]).toMatchObject({
      warehouseId: 'wh-1',
      lines: [{ itemId: 'tent', quantity: 1 }],
    });
  });

  it('switching warehouse loads that warehouse and holds checkout until it arrives', () => {
    savedCart('rental-draft:wh-1', [{ itemId: 'tent', quantity: 1 }]);
    renderForm();
    expect((checkOut() as HTMLButtonElement).disabled).toBe(false);

    fireEvent.change(screen.getByLabelText('Warehouse'), { target: { value: 'wh-2' } });

    expect(push).toHaveBeenCalledWith('/dashboard/rentals/new?warehouseId=wh-2');
    expect((checkOut() as HTMLButtonElement).disabled).toBe(true);
  });
});

// ═══ RENTAL PHOTOS: WITH THE PAGE, AND ONLY RENTALS ASKED FOR AFTER ═══
//
// L4L, 2026-09-25: rental photos appeared about five seconds after the page.
// The form asked for photos of EVERY item in the warehouse (includeRentals=1).
// The page now ships photos in its HTML; the form asks, for rental items only,
// just when a card arrived without one, and never replaces a photo it has.
describe('RentalCreateForm — photos', () => {
  const CANOPY: CatalogItem = { ...TENT, id: 'canopy', name: 'Canopy', imageUrl: 'https://ssr/canopy.webp' };

  beforeEach(() => {
    localStorage.clear();
    thumbs.urls = [];
    thumbs.answer = {};
    gridItems.current = [];
  });

  it('asks for rental items only, and only when a card has no photo yet', () => {
    renderForm([CANOPY, TENT]);
    expect(thumbs.urls.at(-1)).toBe('/api/orders/catalog-thumbnails?warehouseId=wh-1&rentalsOnly=1');
    expect(thumbs.urls.some((u) => u?.includes('includeRentals'))).toBe(false);
  });

  it('makes no photo request when every card already has its photo', () => {
    renderForm([CANOPY]);
    expect(thumbs.urls.length).toBeGreaterThan(0);
    expect(thumbs.urls.every((u) => u === null)).toBe(true);
  });

  it('fills a missing photo and never replaces one the page sent', () => {
    thumbs.answer = { canopy: 'https://deferred/canopy.webp', tent: 'https://deferred/tent.webp' };
    renderForm([CANOPY, TENT]);
    const byId = new Map(gridItems.current.map((i) => [i.id, i.imageUrl]));
    expect(byId.get('canopy')).toBe('https://ssr/canopy.webp');
    expect(byId.get('tent')).toBe('https://deferred/tent.webp');
  });
});
