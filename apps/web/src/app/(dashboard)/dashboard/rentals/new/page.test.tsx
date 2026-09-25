// @vitest-environment happy-dom
import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The New rental catalog's availability.
 *
 * It read reservations for up to 500 rental items in ONE `.in()` with the
 * error ignored: past ~215 ids the local gateway answers 414, past ~395
 * production fails after ~7 s of retries, and either way the page treated it
 * as "nothing reserved", so an item already out on another rental looked
 * available. Reservations now come from InventoryService.reservedQuantityByItemIds
 * (batched, paged, throws); category names batch too and degrade with a report.
 */

const { adminRef, reserved, formProps, reportError, thumbMap, borrowerMembers } = vi.hoisted(() => ({
  adminRef: { current: null as unknown },
  reserved: vi.fn(),
  formProps: vi.fn(),
  reportError: vi.fn(async () => {}),
  thumbMap: vi.fn(),
  borrowerMembers: vi.fn(async () => [] as Array<Record<string, unknown>>),
}));

vi.mock('next/navigation', () => ({ redirect: vi.fn() }));
vi.mock('next/link', async () => {
  const React = await import('react');
  return {
    default: ({ href, children }: { href: string; children: React.ReactNode }) =>
      React.createElement('a', { href }, children),
  };
});
vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({
    organizationId: 'org-1',
    userId: 'u1',
    role: 'admin',
    permissions: new Set(['rentals:create']),
  })),
}));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => adminRef.current }));
vi.mock('@/lib/error-reporter', () => ({ reportError }));
vi.mock('@/server/services/warehouses', () => ({
  WarehousesService: {
    forCurrentUser: vi.fn(async () => ({ listNames: async () => [{ id: 'wh-1', name: 'DC4' }] })),
  },
}));
vi.mock('@/server/services/rentals', () => ({
  RentalsService: {
    forCurrentUser: vi.fn(async () => ({ listBorrowerMembers: borrowerMembers })),
  },
}));
vi.mock('@/server/services/rack-holdings', () => ({
  fetchRackHoldingsByItem: vi.fn(async () => new Map()),
}));
vi.mock('@/server/services/inventory', () => ({
  InventoryService: {
    forCurrentUser: vi.fn(async () => ({ reservedQuantityByItemIds: reserved })),
  },
}));
vi.mock('@/server/loaders/orders-new-catalog', () => ({
  loadCatalogThumbMapCached: thumbMap,
}));
vi.mock('@/components/rentals/rental-create-form', () => ({
  RentalCreateForm: (props: Record<string, unknown>) => {
    formProps(props);
    return null;
  },
}));

import { inFilters, makeSupabaseStub, type MockCall } from '@/test/supabase-mock';

import NewRentalPage from './page';

const uuid = (i: number, p = '0') => `${p.repeat(8)}-0000-4000-8000-${String(i).padStart(12, '0')}`;
const N = 300;
const items = Array.from({ length: N }, (_, i) => ({
  id: uuid(i, 'a'),
  name: `Canopy ${i}`,
  sku: `C-${i}`,
  quantity_on_hand: 2,
  warehouse_id: 'wh-1',
  item_type: 'product',
  custom_fields: {},
  bin_location: null,
  // 150 distinct categories: more than one batch of names.
  category_id: uuid(i % 150, 'c'),
  retail_price: null,
  unit_cost: 5,
  reorder_point: 0,
}));

function stubWith(categories: (call: MockCall) => { data: unknown; error: unknown }) {
  const stub = makeSupabaseStub({
    'inventory_items.select': { data: items, error: null },
    'categories.select': categories as never,
  });
  adminRef.current = stub.client;
  return stub;
}

async function renderPage() {
  render(await NewRentalPage({ searchParams: Promise.resolve({}) }));
  return formProps.mock.calls.at(-1)?.[0] as {
    items: Array<{
      id: string;
      reservedQuantity: number;
      categoryName: string | null;
      imageUrl: string | null;
      lqip: string | null;
    }>;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  thumbMap.mockResolvedValue({});
});

describe('New rental: 300 rental items', () => {
  it('takes reservations from the batched service read, for every item, and counts one in the last batch', async () => {
    const catLists: string[][] = [];
    stubWith((call) => {
      const ids = (inFilters(call).find(([c]) => c === 'id')?.[1] ?? []) as string[];
      catLists.push(ids);
      return { data: ids.map((id) => ({ id, name: `Aisle ${id.slice(-3)}` })), error: null };
    });
    reserved.mockResolvedValue(new Map([[uuid(299, 'a'), 2]]));

    const props = await renderPage();

    expect(reserved).toHaveBeenCalledWith(items.map((i) => i.id));
    const card = props.items.find((i) => i.id === uuid(299, 'a'));
    expect(card?.reservedQuantity).toBe(2);
    // Category names in batches of at most 100, org-scoped.
    expect(catLists.map((l) => l.length)).toEqual([100, 50]);
    expect(card?.categoryName).toBe('Aisle 149');
  });

  it('a failed reservations read fails the page, never "nothing reserved"', async () => {
    stubWith(() => ({ data: [], error: null }));
    reserved.mockRejectedValue(new Error('internal_error'));
    await expect(NewRentalPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(
      'internal_error',
    );
  });

  it('a failed category-name batch shows the page uncategorized and reports it', async () => {
    let n = 0;
    stubWith(() =>
      ++n === 2 ? { data: null, error: { message: 'fetch failed' } } : { data: [], error: null },
    );
    reserved.mockResolvedValue(new Map());

    const props = await renderPage();

    expect(props.items).toHaveLength(N);
    expect(props.items.every((i) => i.categoryName === null)).toBe(true);
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tag: 'rentals.new.category_names', level: 'warning' }),
    );
  });

  it('a failed rental items read fails the page, never an empty catalog', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: null, error: { message: 'fetch failed' } },
    });
    adminRef.current = stub.client;
    await expect(NewRentalPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(
      /rental items read failed/,
    );
  });
});

describe('New rental: photos arrive with the page', () => {
  // L4L, 2026-09-25: "rental photos take about 5 seconds to pop up". The page
  // shipped every card with imageUrl null and waited on a browser request that
  // signed a photo for every item in the warehouse. The cards now carry their
  // photo from the cached warehouse thumbnail map (the Orders storefront's).
  const photoItems = [
    { ...items[0]!, id: uuid(1, 'a'), custom_fields: {} },
    { ...items[0]!, id: uuid(2, 'a'), custom_fields: { thumbnail_url: 'https://covers.example/2.jpg' } },
    { ...items[0]!, id: uuid(3, 'a'), custom_fields: {} },
    { ...items[0]!, id: uuid(4, 'a'), custom_fields: null },
  ];

  function stubPhotoItems() {
    adminRef.current = makeSupabaseStub({
      'inventory_items.select': { data: photoItems, error: null },
      'categories.select': { data: [], error: null },
    }).client;
    reserved.mockResolvedValue(new Map());
  }

  it('reads the map for the page warehouse and puts each photo, cover and blur on its card', async () => {
    stubPhotoItems();
    thumbMap.mockResolvedValue({
      [uuid(1, 'a')]: { url: 'https://signed.example/1.webp', lqip: 'data:image/webp;base64,AAA' },
      // A photo whose URL failed to sign keeps its blur.
      [uuid(3, 'a')]: { url: null, lqip: 'data:image/webp;base64,CCC' },
      // Another warehouse item that is not a rental: never on a card.
      [uuid(99, 'f')]: { url: 'https://signed.example/99.webp', lqip: null },
    });

    const props = await renderPage();

    expect(thumbMap).toHaveBeenCalledWith('org-1', 'wh-1');
    const byId = new Map(props.items.map((i) => [i.id, i]));
    // Photo: the URL, and no blur (the storefront's payload rule).
    expect(byId.get(uuid(1, 'a'))).toMatchObject({
      imageUrl: 'https://signed.example/1.webp',
      lqip: null,
    });
    // No uploaded photo, a book cover on the item: the cover.
    expect(byId.get(uuid(2, 'a'))).toMatchObject({
      imageUrl: 'https://covers.example/2.jpg',
      lqip: null,
    });
    expect(byId.get(uuid(3, 'a'))).toMatchObject({
      imageUrl: null,
      lqip: 'data:image/webp;base64,CCC',
    });
    expect(byId.get(uuid(4, 'a'))).toMatchObject({ imageUrl: null, lqip: null });
    expect(props.items).toHaveLength(4);
  });

  it('a failed map still renders the catalog (the form fills photos in later)', async () => {
    stubPhotoItems();
    thumbMap.mockRejectedValue(new Error('thumb batch sign failed: 503'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const props = await renderPage();

    expect(props.items).toHaveLength(4);
    expect(props.items.find((i) => i.id === uuid(1, 'a'))?.imageUrl).toBeNull();
    expect(props.items.find((i) => i.id === uuid(2, 'a'))?.imageUrl).toBe(
      'https://covers.example/2.jpg',
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('thumb map unavailable'));
    warn.mockRestore();
  });
});

describe('New rental: the borrower picker members', () => {
  // The phone's picker reads the same list through GET /api/v1/rentals/borrowers
  // (RentalsService.listBorrowerMembers). The page used to build its own from
  // TeamService.listMembers, which also offered members who had not accepted
  // their invite: create_rental refuses them ('borrower_not_member').
  it('hands the form the shared list, unchanged', async () => {
    stubWith(() => ({ data: [], error: null }));
    reserved.mockResolvedValue(new Map());
    const members = [
      { userId: 'u-1', displayName: 'Ana Ruiz', email: 'ana@school.org' },
      { userId: 'u-2', displayName: 'bo@school.org', email: 'bo@school.org' },
    ];
    borrowerMembers.mockResolvedValue(members);
    await renderPage();
    const props = formProps.mock.calls.at(-1)?.[0] as { members: unknown };
    expect(borrowerMembers).toHaveBeenCalledTimes(1);
    expect(props.members).toEqual(members);
  });
});
