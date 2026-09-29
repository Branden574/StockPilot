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

const {
  adminRef,
  callerRef,
  session,
  reserved,
  formProps,
  reportError,
  thumbMap,
  borrowerMembers,
  ceiling,
  rackHoldings,
} = vi.hoisted(
  () => ({
    adminRef: { current: null as unknown },
    // The caller's OWN client (row level security applies). null: the same
    // stub as the admin client, i.e. a caller whose RLS view is the full one
    // (the suites below that are not about scope).
    callerRef: { current: null as unknown },
    // The request's org context; the scope suite swaps the role.
    session: {
      current: {
        organizationId: 'org-1',
        userId: 'u1',
        role: 'admin',
        permissions: new Set(['rentals:create']),
      } as Record<string, unknown>,
    },
    rackHoldings: vi.fn(async (..._args: unknown[]) => new Map()),
    reserved: vi.fn(),
    formProps: vi.fn(),
    reportError: vi.fn(async () => {}),
    thumbMap: vi.fn(),
    borrowerMembers: vi.fn(async () => [] as Array<Record<string, unknown>>),
    // The loader's CATALOG_ROW_CEILING, lowered by the ceiling test.
    ceiling: { value: 10_000 },
  }),
);

vi.mock('next/navigation', () => ({ redirect: vi.fn() }));
vi.mock('next/link', async () => {
  const React = await import('react');
  return {
    default: ({ href, children }: { href: string; children: React.ReactNode }) =>
      React.createElement('a', { href }, children),
  };
});
vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => session.current),
}));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => adminRef.current }));
// withContext() is the request's service context: its `supabase` is the
// caller's own cookie client, under row level security.
vi.mock('@/server/services/context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/services/context')>()),
  withContext: vi.fn(async () => ({
    ...session.current,
    supabase: callerRef.current ?? adminRef.current,
  })),
}));
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
  fetchRackHoldingsByItem: rackHoldings,
}));
vi.mock('@/server/services/inventory', () => ({
  InventoryService: {
    forCurrentUser: vi.fn(async () => ({ reservedQuantityByItemIds: reserved })),
  },
}));
// A getter, so a test can lower the ceiling: the page reads the binding on
// every render.
vi.mock('@/server/loaders/orders-new-catalog', () => ({
  get CATALOG_ROW_CEILING() {
    return ceiling.value;
  },
  loadCatalogThumbMapCached: thumbMap,
}));
vi.mock('@/components/rentals/rental-create-form', () => ({
  RentalCreateForm: (props: Record<string, unknown>) => {
    formProps(props);
    return null;
  },
}));

import { itemReadScopeResults, type ScopedCaller } from '@/test/item-read-scope';
import {
  callArgs,
  inFilters,
  makeSupabaseStub,
  servedLikePostgrest,
  type MockCall,
} from '@/test/supabase-mock';

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
  ceiling.value = 10_000;
  callerRef.current = null;
  session.current = {
    organizationId: 'org-1',
    userId: 'u1',
    role: 'admin',
    permissions: new Set(['rentals:create']),
  };
});

describe('New rental: every rental item, not the first 500 by name', () => {
  /**
   * `n` rental items on the page's filters, in neither name nor id order.
   * Names repeat in pairs, and within a pair the fixture runs against the ids,
   * so only name THEN id gives the order the page must keep.
   */
  function rentalRows(n: number) {
    return Array.from({ length: n }, (_, i) => ({
      ...items[0]!,
      id: uuid(9000 - i, 'e'),
      name: `Rental ${String(Math.floor(((i * 7919) % n) / 2)).padStart(4, '0')}`,
      organization_id: 'org-1',
      status: 'active',
      is_rental: true,
      deleted_at: null,
      category_id: null,
    }));
  }
  type Row = ReturnType<typeof rentalRows>[number];

  /** Rows the page must never show: each fails ONE filter, and each sorts
   *  first by name, so a dropped filter puts it on the first page. */
  const excluded: Array<Record<string, unknown> & { id: string; name: string }> = [
    { ...rentalRows(1)[0]!, id: uuid(1, 'd'), name: 'A other org', organization_id: 'org-2' },
    { ...rentalRows(1)[0]!, id: uuid(2, 'd'), name: 'A other warehouse', warehouse_id: 'wh-2' },
    { ...rentalRows(1)[0]!, id: uuid(3, 'd'), name: 'A not a rental', is_rental: false },
    { ...rentalRows(1)[0]!, id: uuid(4, 'd'), name: 'A archived', status: 'archived' },
    { ...rentalRows(1)[0]!, id: uuid(5, 'd'), name: 'A deleted', deleted_at: '2026-09-01T00:00:00Z' },
  ];

  const byNameThenId = (a: Row, b: Row) =>
    a.name === b.name ? (a.id < b.id ? -1 : 1) : a.name < b.name ? -1 : 1;

  function stubRentals(rows: Row[], fail?: (call: MockCall) => boolean) {
    const serve = servedLikePostgrest([...excluded, ...rows]);
    const stub = makeSupabaseStub({
      'inventory_items.select': (call: MockCall) =>
        fail?.(call) ? { data: null, error: { message: 'upstream timeout' } } : serve(call),
      'categories.select': { data: [], error: null },
    });
    adminRef.current = stub.client;
    reserved.mockResolvedValue(new Map());
    return stub;
  }

  it('reads 1,234 rental items page by page, by name then id, and shows every one in that order', async () => {
    const many = rentalRows(1234);
    const stub = stubRentals(many);

    const props = await renderPage();

    expect(props.items.map((i) => i.id)).toEqual([...many].sort(byNameThenId).map((r) => r.id));
    // The exact PostgREST request for each page, method for method: every
    // filter, name then id, and the page window.
    const select =
      'id, name, sku, quantity_on_hand, warehouse_id, item_type, custom_fields, bin_location, category_id, retail_price, unit_cost, reorder_point';
    const methods = ['select', 'eq', 'eq', 'eq', 'eq', 'is', 'order', 'order', 'range'];
    const args = (window: [number, number]) => [
      [select],
      ['organization_id', 'org-1'],
      ['warehouse_id', 'wh-1'],
      ['status', 'active'],
      ['is_rental', true],
      ['deleted_at', null],
      ['name', { ascending: true }],
      ['id', { ascending: true }],
      window,
    ];
    expect(stub.chainsAll.get('inventory_items.select')).toEqual([methods, methods]);
    expect(stub.chainArgsAll.get('inventory_items.select')).toEqual([
      args([0, 999]),
      args([1000, 1999]),
    ]);
  });

  it('never shows a row the query excludes: another org or warehouse, not a rental, inactive, deleted', async () => {
    stubRentals(rentalRows(1234));

    const props = await renderPage();

    expect(props.items).toHaveLength(1234);
    const shown = new Set(props.items.map((i) => i.id));
    for (const row of excluded) expect(shown.has(row.id), row.name).toBe(false);
  });

  it('a page that fails AFTER the first fails the page (error boundary), never the first page as the catalog', async () => {
    stubRentals(rentalRows(1234), (call) => callArgs(call, 'range')?.[0] === 1000);

    await expect(NewRentalPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(
      /rental items read failed: .*upstream timeout/,
    );
    expect(formProps).not.toHaveBeenCalled();
  });

  it('stops at CATALOG_ROW_CEILING, keeps the first rows by name then id, and logs that it did', async () => {
    ceiling.value = 1500;
    const many = rentalRows(2000);
    const stub = stubRentals(many);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const props = await renderPage();

    expect(props.items.map((i) => i.id)).toEqual(
      [...many].sort(byNameThenId).slice(0, 1500).map((r) => r.id),
    );
    // The last window is cut to the ceiling; nothing past it is asked for.
    expect(stub.chainArgsAll.get('inventory_items.select')?.map((a) => a.at(-1))).toEqual([
      [0, 999],
      [1000, 1499],
    ]);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('1500-row ceiling for warehouse wh-1'));
    error.mockRestore();
  });

  it('under the ceiling, logs nothing about it', async () => {
    stubRentals(rentalRows(1234));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await renderPage();
    expect(error).not.toHaveBeenCalledWith(expect.stringContaining('-row ceiling'));
    error.mockRestore();
  });
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

describe('New rental: only the rental items the caller can read, and only their photos', () => {
  // The rental items were read with the service-role client, filtered by org,
  // warehouse, status, is_rental and deleted_at only. inventory_items_select
  // also scopes a member by the charter of their warehouse assignment and (a
  // restricted viewer) by category, and the service role skips it: a scoped
  // member with rentals:create saw, on this page, the names, SKUs, stock,
  // prices and unit costs of rental items they cannot read, with a signed
  // photo URL for each from the warehouse-wide thumbnail map. create_rental
  // refuses those items (0361), so they were not even rentable.
  const rental = (
    id: string,
    name: string,
    over: { charter_id?: string | null; category_id?: string | null } = {},
  ) => ({
    ...items[0]!,
    id,
    name,
    sku: `SKU-${name}`,
    organization_id: 'org-1',
    warehouse_id: 'wh-1',
    status: 'active',
    is_rental: true,
    deleted_at: null,
    custom_fields: {},
    charter_id: over.charter_id ?? null,
    category_id: over.category_id === undefined ? 'cat-in' : over.category_id,
  });
  const IN = uuid(1, 'e');
  const CHARTER_A = uuid(2, 'e');
  const CHARTER_B = uuid(3, 'e');
  const CAT_OUT = uuid(4, 'e');
  const world = [
    rental(IN, 'Canopy 1 generic'),
    rental(CHARTER_A, 'Canopy 2 charter A', { charter_id: 'ch-a' }),
    rental(CHARTER_B, 'Canopy 3 charter B', { charter_id: 'ch-b' }),
    rental(CAT_OUT, 'Canopy 4 other category', { category_id: 'cat-out' }),
  ];
  const photo = (id: string) => `https://signed.example/${id}.webp`;

  /**
   * The admin client answers as the service role (every row, no policy); the
   * caller's own client answers as PostgREST does under inventory_items_select
   * for `caller`. The thumbnail map holds a photo for every item in the
   * warehouse, as the real warehouse-wide map does.
   */
  function stubScope(caller: ScopedCaller, role: string) {
    session.current = {
      organizationId: 'org-1',
      userId: 'u-scoped',
      role,
      permissions: new Set(['rentals:create']),
    };
    const admin = makeSupabaseStub({
      'inventory_items.select': servedLikePostgrest(world),
      'categories.select': (call: MockCall) => {
        const ids = (inFilters(call).find(([c]) => c === 'id')?.[1] ?? []) as string[];
        return { data: ids.map((id) => ({ id, name: `Aisle ${id}` })), error: null };
      },
    });
    const own = makeSupabaseStub(itemReadScopeResults(caller, { items: world, images: [] }));
    adminRef.current = admin.client;
    callerRef.current = own.client;
    thumbMap.mockResolvedValue(Object.fromEntries(world.map((w) => [w.id, { url: photo(w.id), lqip: null }])));
    reserved.mockResolvedValue(new Map());
    return { admin, own };
  }

  async function shown() {
    const props = await renderPage();
    return {
      ids: props.items.map((i) => i.id),
      photos: new Map(props.items.map((i) => [i.id, i.imageUrl])),
      // Everything the page hands the browser, as one string.
      serialized: JSON.stringify(formProps.mock.calls.at(-1)?.[0]),
    };
  }

  function expectNeverShown(serialized: string, hidden: string[]) {
    for (const id of hidden) {
      const row = world.find((w) => w.id === id)!;
      expect(serialized, `${row.name}: id`).not.toContain(id);
      expect(serialized, `${row.name}: name`).not.toContain(row.name);
      expect(serialized, `${row.name}: photo`).not.toContain(photo(id));
    }
  }

  it('a category-scoped viewer sees the rental items of their categories, never another category (item or photo)', async () => {
    const { admin } = stubScope(
      { organizationId: 'org-1', warehouseIds: ['wh-1'], categoryIds: ['cat-in'] },
      'viewer',
    );

    const { ids, photos, serialized } = await shown();

    expect(ids).toEqual([IN, CHARTER_A, CHARTER_B]);
    for (const id of ids) expect(photos.get(id)).toBe(photo(id));
    expectNeverShown(serialized, [CAT_OUT]);
    // Nothing else is read or asked for about the hidden item either.
    expect(reserved).toHaveBeenCalledWith([IN, CHARTER_A, CHARTER_B]);
    expect(rackHoldings.mock.calls[0]?.[1]).toEqual([IN, CHARTER_A, CHARTER_B]);
    // The service role never lists the items.
    expect(admin.fromCalls).not.toContain('inventory_items');
  });

  it('a charter-scoped staff member sees generic items and their charter, never another charter (item or photo)', async () => {
    const { admin } = stubScope(
      {
        organizationId: 'org-1',
        warehouseIds: [],
        charterAssignments: [{ warehouseId: 'wh-1', charterId: 'ch-a' }],
        categoryIds: 'all',
      },
      'staff',
    );

    const { ids, photos, serialized } = await shown();

    expect(ids).toEqual([IN, CHARTER_A, CAT_OUT]);
    for (const id of ids) expect(photos.get(id)).toBe(photo(id));
    expectNeverShown(serialized, [CHARTER_B]);
    expect(reserved).toHaveBeenCalledWith([IN, CHARTER_A, CAT_OUT]);
    expect(rackHoldings.mock.calls[0]?.[1]).toEqual([IN, CHARTER_A, CAT_OUT]);
    expect(admin.fromCalls).not.toContain('inventory_items');
  });

  it('a member who reads the whole warehouse, and a manager, still see every rental item with its photo', async () => {
    for (const [caller, role] of [
      [{ organizationId: 'org-1', warehouseIds: ['wh-1'], categoryIds: 'all' }, 'staff'],
      [{ organizationId: 'org-1', warehouseIds: 'all', categoryIds: 'all' }, 'manager'],
    ] as Array<[ScopedCaller, string]>) {
      stubScope(caller, role);
      const { ids, photos } = await shown();
      expect(ids, role).toEqual([IN, CHARTER_A, CHARTER_B, CAT_OUT]);
      for (const id of ids) expect(photos.get(id), role).toBe(photo(id));
    }
  });

  it('a caller who can read none of them gets an empty catalog, and no photo at all', async () => {
    stubScope({ organizationId: 'org-1', warehouseIds: [], categoryIds: 'all' }, 'staff');

    const { ids, serialized } = await shown();

    expect(ids).toEqual([]);
    expectNeverShown(serialized, [IN, CHARTER_A, CHARTER_B, CAT_OUT]);
  });
});
