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
const gridItems = vi.hoisted(() => ({
  current: [] as Array<{ id: string; imageUrl: string | null }>,
}));
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

// The signed-in viewer's own cart key (B20a: rentalDraftPrefixFor), and the
// account-less key New rental used before it.
const VIEWER = 'u-viewer';
const DRAFT_KEY = `rental-draft:v2:${VIEWER}:wh-1`;
const LEGACY_DRAFT_KEY = 'rental-draft:wh-1';

function savedCart(
  key: string,
  lines: Array<{ itemId: string; quantity: number }>,
  warehouseId = 'wh-1',
) {
  localStorage.setItem(
    key,
    JSON.stringify({
      warehouseId,
      charterId: null,
      fulfillmentType: 'pickup',
      onBehalfOf: null,
      notes: '',
      neededBy: '',
      lines,
    }),
  );
}

function formElement(items: CatalogItem[] = [TENT], viewerUserId = VIEWER, warehouseId = 'wh-1') {
  return (
    <RentalCreateForm
      warehouses={[
        { id: 'wh-1', name: 'Main' },
        { id: 'wh-2', name: 'Annex' },
      ]}
      warehouseId={warehouseId}
      items={items}
      aisles={[]}
      members={[]}
      viewerRole="admin"
      viewerUserId={viewerUserId}
    />
  );
}

function renderForm(items: CatalogItem[] = [TENT], viewerUserId = VIEWER) {
  return render(formElement(items, viewerUserId));
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
    savedCart(DRAFT_KEY, [
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

  // Web walk 2026-09-25: Add, then Check out at once. The action came back
  // inside the cart's 250 ms save debounce, clearCartDraft ran, and the save
  // still waiting wrote the checked-out lines back to the warehouse's draft
  // (then rental-draft:wh-1; the viewer's own key since B20a), so the next New
  // rental for that warehouse opened with them. Mutation caught:
  // clearCartDraft removing the key without cancelling that save, and (B20a)
  // a checkout that clears a key other than the one the cart saves under.
  it('a checkout that comes back before the cart saves leaves no draft behind', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      savedCart(DRAFT_KEY, [{ itemId: 'tent', quantity: 1 }]);
      renderForm();
      await act(async () => {
        vi.advanceTimersByTime(300);
      });
      createRentalAction.mockResolvedValue({ ok: true, data: { id: 'rental-1' } });
      fireEvent.change(screen.getByLabelText('Borrower'), { target: { value: 'Ana' } });
      // A cart change right before Check out: its save waits 250 ms.
      fireEvent.click(screen.getByRole('button', { name: 'Increase quantity' }));
      await act(async () => {
        fireEvent.click(checkOut());
      });
      expect(createRentalAction.mock.calls[0]![0]).toMatchObject({
        lines: [{ itemId: 'tent', quantity: 2 }],
      });
      expect(push).toHaveBeenCalledWith('/dashboard/rentals/rental-1');
      await act(async () => {
        vi.advanceTimersByTime(1000);
      });
      expect(localStorage.getItem(DRAFT_KEY)).toBeNull();
      expect(localStorage.getItem(LEGACY_DRAFT_KEY)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('switching warehouse loads that warehouse and holds checkout until it arrives', () => {
    savedCart(DRAFT_KEY, [{ itemId: 'tent', quantity: 1 }]);
    renderForm();
    expect((checkOut() as HTMLButtonElement).disabled).toBe(false);

    fireEvent.change(screen.getByLabelText('Warehouse'), { target: { value: 'wh-2' } });

    expect(push).toHaveBeenCalledWith('/dashboard/rentals/new?warehouseId=wh-2');
    expect((checkOut() as HTMLButtonElement).disabled).toBe(true);
  });
});

// ═══ EACH PERSON'S RENTAL CART IS THEIR OWN (B20a) ═══
//
// The cart was saved under rental-draft:<warehouse> for whoever used the
// browser, so on a shared computer the next person to open New rental for the
// same warehouse found the last person's items. The form now saves, restores
// and clears under the viewer's own key. A cart left under the old key belongs
// to no account, so nobody can say whose it is: it is never opened, and New
// rental removes it, unread, each time it opens for a warehouse (review of
// B20a; adopting it once, as first built, handed it to whoever came first).
describe("RentalCreateForm — the viewer's own cart", () => {
  beforeEach(() => {
    localStorage.clear();
    push.mockReset();
    toastError.mockReset();
    createRentalAction.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
    // A storage spy left by a test that failed before restoring its own.
    vi.restoreAllMocks();
    localStorage.clear();
  });

  // Mutation caught: the provider given the shared prefix, or no account.
  it("opens the viewer's own cart, never another account's cart for the same warehouse", () => {
    savedCart('rental-draft:v2:u-other:wh-1', [{ itemId: 'tent', quantity: 1 }]);
    const other = renderForm();
    expect(screen.getByText('Add items from the catalog.')).toBeTruthy();
    expect((checkOut() as HTMLButtonElement).disabled).toBe(true);
    other.unmount();

    savedCart(DRAFT_KEY, [{ itemId: 'tent', quantity: 1 }]);
    renderForm();
    expect(screen.getByText('Event tent')).toBeTruthy();
    expect((checkOut() as HTMLButtonElement).disabled).toBe(false);
  });

  // Review of B20a, probe P1: the first person to open New rental for the
  // warehouse was handed a cart someone else left under the old key, and could
  // check it out. A tab still on the previous build can save there again after
  // the deploy; the next person was handed that one too. Mutation caught: the
  // old prefix given to the provider again (the cart shows the lines and the
  // key is read), or no removal (the key waits for the next person).
  it('never shows a cart left under the old shared key, and removes it unread when New rental opens', () => {
    const otherKey = 'rental-draft:v2:u-other:wh-1';
    savedCart(otherKey, [{ itemId: 'tent', quantity: 2 }]);
    savedCart(LEGACY_DRAFT_KEY, [{ itemId: 'tent', quantity: 3 }]);
    // On localStorage itself: happy-dom binds a copy of each Storage method
    // onto the instance at first use, so a spy on Storage.prototype misses it.
    const reads = vi.spyOn(localStorage, 'getItem');
    const first = renderForm();
    const legacyReads = reads.mock.calls.filter(([key]) => key === LEGACY_DRAFT_KEY);
    reads.mockRestore();
    expect(legacyReads).toEqual([]);
    expect(screen.getByText('Add items from the catalog.')).toBeTruthy();
    expect((checkOut() as HTMLButtonElement).disabled).toBe(true);
    expect(localStorage.getItem(LEGACY_DRAFT_KEY)).toBeNull();
    // Another account's own cart is not touched.
    expect(JSON.parse(localStorage.getItem(otherKey) ?? '{}').lines).toEqual([
      { itemId: 'tent', quantity: 2 },
    ]);
    first.unmount();

    // A tab still on the previous build saves under the old key again. The
    // other account opens New rental: their own cart, not that one.
    savedCart(LEGACY_DRAFT_KEY, [{ itemId: 'tent', quantity: 3 }]);
    renderForm([TENT], 'u-other');
    expect(screen.getByRole('heading', { name: /Checkout/ }).textContent).toBe('Checkout(2)');
    expect(localStorage.getItem(LEGACY_DRAFT_KEY)).toBeNull();
  });

  // Review of B20a, probe P2: the old key was removed only when the viewer had
  // no cart of their own, so a viewer who had one left it for the next person
  // without one. Mutation caught: the removal made only on that branch.
  it('a viewer with a cart of their own keeps it, and the old shared key is still removed', () => {
    savedCart(DRAFT_KEY, [{ itemId: 'tent', quantity: 1 }]);
    savedCart(LEGACY_DRAFT_KEY, [{ itemId: 'tent', quantity: 4 }]);
    const own = renderForm();
    expect(screen.getByRole('heading', { name: /Checkout/ }).textContent).toBe('Checkout(1)');
    expect(localStorage.getItem(LEGACY_DRAFT_KEY)).toBeNull();
    own.unmount();

    renderForm([TENT], 'u-other');
    expect(screen.getByText('Add items from the catalog.')).toBeTruthy();
  });

  // The page keeps this form mounted when the warehouse changes (only the
  // cart, keyed by warehouse, starts again), so the removal runs for every
  // warehouse New rental opens. Mutation caught: a removal made only for the
  // first warehouse.
  it("opening another warehouse removes that warehouse's old shared key too, unshown", () => {
    const ANNEX_TENT: CatalogItem = {
      ...TENT,
      id: 'annex-tent',
      name: 'Annex tent',
      warehouseId: 'wh-2',
    };
    const annexLegacyKey = 'rental-draft:wh-2';
    savedCart(annexLegacyKey, [{ itemId: 'annex-tent', quantity: 2 }], 'wh-2');
    const view = renderForm();
    view.rerender(formElement([ANNEX_TENT], VIEWER, 'wh-2'));
    expect(screen.getByText('Add items from the catalog.')).toBeTruthy();
    expect(screen.queryByText('Annex tent')).toBeNull();
    expect(localStorage.getItem(annexLegacyKey)).toBeNull();
  });

  // One removeItem in a try/catch: a browser whose storage refuses it (a
  // privacy setting) still opens New rental with the viewer's own cart.
  // Mutation caught: no try/catch (the error takes the form down).
  it('a browser whose storage refuses the removal still opens New rental', () => {
    savedCart(DRAFT_KEY, [{ itemId: 'tent', quantity: 1 }]);
    const remove = vi.spyOn(localStorage, 'removeItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    try {
      renderForm();
      expect(remove).toHaveBeenCalledWith(LEGACY_DRAFT_KEY);
    } finally {
      remove.mockRestore();
    }
    expect(screen.getByText('Event tent')).toBeTruthy();
    expect((checkOut() as HTMLButtonElement).disabled).toBe(false);
  });

  // Mutation caught: checkout clearing the shared key instead of the viewer's.
  it("a checkout clears the viewer's own cart", async () => {
    savedCart(DRAFT_KEY, [{ itemId: 'tent', quantity: 1 }]);
    renderForm();
    createRentalAction.mockResolvedValue({ ok: true, data: { id: 'rental-1' } });
    fireEvent.change(screen.getByLabelText('Borrower'), { target: { value: 'Ana' } });
    await act(async () => {
      fireEvent.click(checkOut());
    });
    expect(createRentalAction).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(DRAFT_KEY)).toBeNull();
  });
});

// ═══ RENTAL PHOTOS: WITH THE PAGE, CORRECTED BY A RENTALS-ONLY READ ═══
//
// L4L, 2026-09-25: rental photos appeared about five seconds after the page.
// The form asked for photos of EVERY item in the warehouse (includeRentals=1).
// The page now ships photos in its HTML from the warehouse photo map, which is
// up to 4 hours old; the form reads the rental items' photos fresh and changes
// a card only when that answer names a different image.
describe('RentalCreateForm — photos', () => {
  const SIGNED = 'https://proj.supabase.co/storage/v1/object/sign/item-images/org-1';
  const CANOPY: CatalogItem = {
    ...TENT,
    id: 'canopy',
    name: 'Canopy',
    imageUrl: `${SIGNED}/canopy/a.webp?token=page`,
  };

  beforeEach(() => {
    localStorage.clear();
    thumbs.urls = [];
    thumbs.answer = {};
    gridItems.current = [];
  });

  const imageById = () => new Map(gridItems.current.map((i) => [i.id, i.imageUrl]));

  it('asks for rental items only', () => {
    renderForm([CANOPY, TENT]);
    expect(thumbs.urls.at(-1)).toBe(
      '/api/orders/catalog-thumbnails?warehouseId=wh-1&rentalsOnly=1',
    );
    expect(thumbs.urls.some((u) => u?.includes('includeRentals'))).toBe(false);
  });

  it('asks even when every card already has a photo (the map can be hours old)', () => {
    renderForm([CANOPY]);
    expect(thumbs.urls.at(-1)).toBe(
      '/api/orders/catalog-thumbnails?warehouseId=wh-1&rentalsOnly=1',
    );
  });

  it('makes no photo request when there are no rental items', () => {
    renderForm([]);
    expect(thumbs.urls.length).toBeGreaterThan(0);
    expect(thumbs.urls.every((u) => u === null)).toBe(true);
  });

  it('fills a missing photo; the same image under a new signature is left alone', () => {
    thumbs.answer = {
      canopy: `${SIGNED}/canopy/a.webp?token=fresh`,
      tent: `${SIGNED}/tent/t.webp?token=fresh`,
    };
    renderForm([CANOPY, TENT]);
    expect(imageById().get('canopy')).toBe(`${SIGNED}/canopy/a.webp?token=page`);
    expect(imageById().get('tent')).toBe(`${SIGNED}/tent/t.webp?token=fresh`);
  });

  it('a photo replaced since the map was built: the card shows the new one', () => {
    thumbs.answer = { canopy: `${SIGNED}/canopy/b.webp?token=fresh` };
    renderForm([CANOPY]);
    expect(imageById().get('canopy')).toBe(`${SIGNED}/canopy/b.webp?token=fresh`);
  });

  it('a book that showed its cover and now has an uploaded photo: the photo', () => {
    const BOOK: CatalogItem = {
      ...TENT,
      id: 'book',
      imageUrl: 'https://books.google.com/books/content?id=AAA&printsec=frontcover&img=1',
    };
    thumbs.answer = { book: `${SIGNED}/book/p.webp?token=fresh` };
    renderForm([BOOK]);
    expect(imageById().get('book')).toBe(`${SIGNED}/book/p.webp?token=fresh`);
  });

  it('keeps a cover that has not changed, and keeps the page photo when the answer has none', () => {
    const cover = 'https://books.google.com/books/content?id=AAA&printsec=frontcover&img=1';
    const BOOK: CatalogItem = { ...TENT, id: 'book', imageUrl: cover };
    thumbs.answer = { book: cover };
    renderForm([BOOK, CANOPY]);
    expect(imageById().get('book')).toBe(cover);
    expect(imageById().get('canopy')).toBe(`${SIGNED}/canopy/a.webp?token=page`);
  });
});

// Redesign P4.D1: the checkout rail in the redesign's look. The cart's small
// controls keep their words and become 44 px targets on a phone or a touch
// screen (they are plain buttons, so they have no Button hit area of their
// own); the expected return is the shared text field with its id and limit.
describe('RentalCreateForm: the redesigned rail and setup', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('the cart controls are 44 px on a phone and on coarse pointers', () => {
    savedCart(DRAFT_KEY, [{ itemId: 'tent', quantity: 1 }]);
    renderForm();
    for (const name of ['Decrease quantity', 'Increase quantity']) {
      const button = screen.getByRole('button', { name });
      expect(button.className, name).toMatch(/(^|\s)max-sm:w-11(\s|$)/);
      expect(button.className, name).toMatch(/(^|\s)pointer-coarse:w-11(\s|$)/);
      expect(button.parentElement!.className, `${name} group`).toMatch(/(^|\s)max-sm:h-11(\s|$)/);
    }
    const remove = screen.getByRole('button', { name: 'Remove' });
    expect(remove.className).toMatch(/(^|\s)max-sm:size-11(\s|$)/);
    expect(remove.className).toMatch(/(^|\s)pointer-coarse:size-11(\s|$)/);
  });

  it('the unavailable line keeps its words, its remove button and the touch size', () => {
    savedCart(DRAFT_KEY, [{ itemId: 'gone', quantity: 2 }]);
    renderForm();
    expect(
      screen.getByText('An item saved in this cart is no longer available to rent here (2).'),
    ).toBeTruthy();
    const remove = screen.getByRole('button', { name: 'Remove unavailable item' });
    expect(remove.className).toMatch(/(^|\s)max-sm:size-11(\s|$)/);
  });

  it('the expected return field keeps its label, type and lower bound', () => {
    renderForm();
    const field = screen.getByLabelText('Expected return') as HTMLInputElement;
    expect(field.type).toBe('datetime-local');
    expect(field.id).toBe('rental-return-date');
    expect(field.min).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    expect(field.value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  });
});
