import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Rentals items list (redesign P4.D1).
 *
 * The Table / Grid choice is this list's own cookie, sp_view_rental_items
 * (P3.2 "Preference storage"): the page reads it on the server and hands it to
 * InventoryTable as the initial view, so a Grid viewer gets the Grid in the
 * first paint (no table-then-grid swap) with no database read. The Items and
 * Books lists' cookies never decide this list's view.
 *
 * Also pinned here: the rentals-only read, the shared header with the
 * Active / Archived toggle and the gated "+ New item", the section tabs, the
 * two empty states of an empty list with their words, and the table (never
 * an empty state) for a view a filter or a search leaves empty.
 */

const h = vi.hoisted(() => ({
  cookies: {} as Record<string, string>,
  canCreate: true,
  total: 1,
  items: [] as Array<Record<string, unknown>>,
  tableProps: vi.fn(),
  list: vi.fn(),
  charterLabels: vi.fn(),
}));

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) =>
      h.cookies[name] === undefined ? undefined : { name, value: h.cookies[name] },
  }),
}));
vi.mock('next/link', async () => {
  const React = await import('react');
  return {
    default: ({ href, children }: { href: string; children: React.ReactNode }) =>
      React.createElement('a', { href }, children),
  };
});
vi.mock('@/components/ui/archive-view-toggle', () => ({
  ArchiveViewToggle: ({ view }: { view: string }) => <div data-testid="archive-toggle">{view}</div>,
}));
vi.mock('@/components/rentals/rentals-tabs', () => ({
  RentalsTabs: ({ activeTab }: { activeTab: string }) => (
    <div data-testid="rentals-tabs">{activeTab}</div>
  ),
}));
vi.mock('@/components/inventory/inventory-table', () => ({
  InventoryTable: (props: Record<string, unknown>) => {
    h.tableProps(props);
    return <div data-testid="inventory-table" />;
  },
}));
vi.mock('@/components/inventory/elsewhere-unavailable-notice', () => ({
  ElsewhereUnavailableNotice: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({
    organizationId: 'org-1',
    userId: 'u1',
    role: h.canCreate ? 'staff' : 'viewer',
    permissions: new Set(h.canCreate ? ['items:create'] : []),
  })),
}));
vi.mock('@/server/services/inventory', () => ({
  InventoryService: {
    forCurrentUser: vi.fn(async () => ({
      list: h.list,
      reservedQuantityByItemIds: vi.fn(async () => new Map([['r1', 2]])),
    })),
  },
}));
const { lookup } = vi.hoisted(() => ({
  lookup: (method: string) => ({
    forCurrentUser: vi.fn(async () => ({ [method]: vi.fn(async () => []) })),
  }),
}));
vi.mock('@/server/services/categories', () => ({ CategoriesService: lookup('list') }));
vi.mock('@/server/services/locations', () => ({ LocationsService: lookup('list') }));
vi.mock('@/server/services/suppliers', () => ({ SuppliersService: lookup('listForLookups') }));
vi.mock('@/server/services/tags', () => ({ TagsService: lookup('list') }));
vi.mock('@/server/services/charters', () => ({
  ChartersService: {
    forCurrentUser: vi.fn(async () => ({ listLabels: h.charterLabels })),
  },
}));
vi.mock('@/server/services/item-images', () => ({
  ItemImagesService: {
    forCurrentUser: vi.fn(async () => ({
      primaryImagesWithThumbsForItems: vi.fn(async () => new Map()),
    })),
  },
}));
vi.mock('@/server/services/movements', () => ({ getItemTrends: vi.fn(async () => new Map()) }));

import RentalItemsPage from './page';

import { requireOrgContext } from '@/lib/auth/session';

function rentalItem(id: string) {
  return { id, name: `Canopy ${id}`, sku: id, quantity_on_hand: 5, is_rental: true };
}

async function renderPage(params: Record<string, string> = {}) {
  render(await RentalItemsPage({ searchParams: Promise.resolve(params) }));
}

beforeEach(() => {
  vi.clearAllMocks();
  h.cookies = {};
  h.canCreate = true;
  h.list.mockImplementation(async () => ({
    items: h.total > 0 ? [rentalItem('r1')] : [],
    total: h.total,
    elsewhereUnavailable: false,
  }));
  h.total = 1;
  h.charterLabels.mockImplementation(async () => []);
});

/**
 * B97 part 1: the Rentals items list built its table lookups without
 * charters, and the Charter column is always shown, so every rental item
 * tagged to a charter read "Generic". It now names each charter, active or
 * not (marked archived or inactive), from the member's own read.
 */
describe("Rentals items: the Charter cell names the item's charter (B97)", () => {
  it('every charter, by its code, with its status', async () => {
    h.charterLabels.mockImplementation(async () => [
      { id: 'ch-1', name: 'North Campus', code: 'NC', status: 'active' },
      { id: 'ch-9', name: 'Old Campus', code: 'OC', status: 'archived' },
    ]);
    await renderPage();
    expect(h.charterLabels).toHaveBeenCalledWith();
    const { charters } = (
      h.tableProps.mock.calls[0]![0] as {
        lookups: { charters: Map<string, unknown> };
      }
    ).lookups;
    expect(charters.get('ch-1')).toEqual({ name: 'North Campus', code: 'NC', status: 'active' });
    expect(charters.get('ch-9')).toEqual({ name: 'Old Campus', code: 'OC', status: 'archived' });
  });

  it('a failed read names none, and the list still renders', async () => {
    h.charterLabels.mockImplementation(async () => {
      throw new Error('statement timeout');
    });
    await renderPage();
    expect(h.tableProps).toHaveBeenCalledTimes(1);
    const { charters } = (
      h.tableProps.mock.calls[0]![0] as {
        lookups: { charters?: Map<string, unknown> };
      }
    ).lookups;
    expect(charters?.size ?? 0).toBe(0);
  });
});

describe('Rentals items: the Table / Grid choice comes from its own cookie', () => {
  it.each([
    ['sp_view_rental_items=grid', { sp_view_rental_items: 'grid' }, 'grid'],
    ['sp_view_rental_items=table', { sp_view_rental_items: 'table' }, 'table'],
    ['no cookie', {}, 'table'],
    ['an unknown value', { sp_view_rental_items: 'cards' }, 'table'],
    ["only the Items list's cookie", { sp_view_items: 'grid' }, 'table'],
    ["only the Books list's cookie", { sp_view_books: 'grid' }, 'table'],
  ])('%s', async (_label, cookies, view) => {
    h.cookies = cookies;
    await renderPage();
    expect(h.tableProps).toHaveBeenCalledTimes(1);
    expect(h.tableProps.mock.calls[0]![0]).toMatchObject({ initialView: view });
  });

  it('the table keeps its rentals wiring: rentals-only rows, links inside Rentals, out on rental', async () => {
    h.cookies = { sp_view_rental_items: 'grid' };
    await renderPage();
    expect(h.list).toHaveBeenCalledWith(
      expect.objectContaining({ rentalsOnly: true, withElsewhere: true, itemType: 'all' }),
    );
    const props = h.tableProps.mock.calls[0]![0] as Record<string, unknown>;
    expect(props.rowLinkPrefix).toBe('/dashboard/rentals/items');
    expect(props.basePath).toBe('/dashboard/rentals/items');
    expect((props.reservedByItem as Map<string, number>).get('r1')).toBe(2);
    // Its search box asks for this same set (rentals of every type); without
    // it a typed SKU or name found nothing on this page.
    expect(props.rentalsOnly).toBe(true);
  });

  // B42: the bulk bar draws Cycle count only when the page passes
  // canStartCount, and this page passes none, even to a manager who can start
  // counts elsewhere: rental equipment is never counted (0369 D8), so a count
  // started here would count nothing. The table's default (false) is pinned
  // in inventory-table.selection.test.tsx.
  it('even for a manager who can start counts, the table gets no canStartCount', async () => {
    vi.mocked(requireOrgContext).mockResolvedValueOnce({
      organizationId: 'org-1',
      userId: 'u1',
      role: 'manager',
      permissions: new Set(['items:create', 'cycle_counts:assign', 'stock:adjust']),
    } as never);
    await renderPage();
    const props = h.tableProps.mock.calls[0]![0] as Record<string, unknown>;
    expect(props.canStartCount ?? false).toBe(false);
  });
});

describe('Rentals items: header, tabs and states', () => {
  it('one h1 "Rentals", the Items tab, the toggle and the gated + New item', async () => {
    await renderPage();
    expect(screen.getAllByRole('heading', { level: 1 }).map((x) => x.textContent)).toEqual([
      'Rentals',
    ]);
    expect(
      screen.getByText('Items available for rental — canopies, supplies, equipment.'),
    ).toBeTruthy();
    expect(screen.getByTestId('rentals-tabs').textContent).toBe('items');
    expect(screen.getByTestId('archive-toggle').textContent).toBe('active');
    expect(screen.getByRole('link', { name: '+ New item' }).getAttribute('href')).toBe(
      '/dashboard/rentals/items/new',
    );
  });

  it('no + New item without items:create, nor on the Archived view', async () => {
    h.canCreate = false;
    await renderPage();
    expect(screen.queryByText('+ New item')).toBeNull();
    document.body.innerHTML = '';
    h.canCreate = true;
    await renderPage({ status: 'archived' });
    expect(screen.queryByText('+ New item')).toBeNull();
    expect(screen.getByText('Archived rental items.')).toBeTruthy();
  });

  it('the two empty states of an empty list keep their words', async () => {
    h.total = 0;
    await renderPage();
    expect(screen.getByText('No rental items yet')).toBeTruthy();
    expect(
      screen.getByText(
        'Add canopies, supplies, and other circulating assets that staff can check out.',
      ),
    ).toBeTruthy();
    expect(
      screen.getByRole('link', { name: 'Add your first rental item' }).getAttribute('href'),
    ).toBe('/dashboard/rentals/items/new');
    document.body.innerHTML = '';
    await renderPage({ status: 'archived' });
    expect(screen.getByText('No archived rental items')).toBeTruthy();
    expect(screen.getByText('Nothing here yet.')).toBeTruthy();
    expect(
      screen.getByRole('link', { name: 'Back to active rental items' }).getAttribute('href'),
    ).toBe('/dashboard/rentals/items');
    document.body.innerHTML = '';
    // A sort is not a filter: the list is still empty with nothing narrowing it.
    await renderPage({ sort: 'name_asc' });
    expect(screen.getByText('No rental items yet')).toBeTruthy();
    expect(h.tableProps).not.toHaveBeenCalled();
  });

  it('without items:create, "No rental items yet" has no add action, as before', async () => {
    h.total = 0;
    h.canCreate = false;
    await renderPage();
    expect(screen.getByText('No rental items have been added yet.')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Add your first rental item' })).toBeNull();
  });
});

/**
 * Grouping walk 2026-10-20 (W4 no-match): Rentals items is always server mode,
 * and a Category filter that left no rental answered "No rental items yet" with
 * an offer to add one and no filter bar, right after the tick and after a
 * reload, so the filter could be neither seen nor undone; a search that matched
 * nothing had a page-level state without the bar ("No rental items match your
 * search"). Every view a filter or a search leaves empty is now the table, whose
 * no-match state keeps the filter bar, the active chips and "Clear all filters",
 * as on Items and Books. The list still applies the filter exactly as before.
 * The table (stubbed here) says what the page said for a search that matches
 * nothing, "No rental items match your search" with "Clear search": see
 * page.no-match.test.tsx, which renders the real table.
 */
describe('Rentals items: a filter that leaves nothing is the table, with its filters', () => {
  it.each<[string, Record<string, string>, Record<string, unknown>]>([
    ['a Category', { cat: 'cat-empty' }, { categoryIds: ['cat-empty'] }],
    ['a Location', { loc: 'loc-empty' }, { locationIds: ['loc-empty'] }],
    ['a search', { q: 'tent' }, { q: 'tent' }],
    ['Low + critical', { stock: 'low' }, { lowStock: true }],
    ['Out of stock', { stock: 'out' }, { outOfStock: true }],
    [
      'a Category on the Archived view',
      { status: 'archived', cat: 'cat-empty' },
      { status: 'archived', categoryIds: ['cat-empty'] },
    ],
    ['the Discontinued view', { status: 'discontinued' }, { status: 'discontinued' }],
  ])('%s that leaves nothing: the table, never an empty state', async (_l, params, applied) => {
    h.total = 0;
    await renderPage(params);
    expect(h.list).toHaveBeenCalledWith(expect.objectContaining(applied));
    expect(screen.queryByText('No rental items yet')).toBeNull();
    expect(screen.queryByText('No archived rental items')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Add your first rental item' })).toBeNull();
    expect(h.tableProps).toHaveBeenCalledTimes(1);
    expect(h.tableProps.mock.calls[0]![0]).toMatchObject({
      total: 0,
      items: [],
      // The search box holds the search.
      initialQuery: params.q,
    });
  });
});
