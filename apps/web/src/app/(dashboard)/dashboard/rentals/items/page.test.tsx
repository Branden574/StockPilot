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
 * Active / Archived toggle and the gated "+ New item", the section tabs, and
 * the three empty states with their words.
 */

const h = vi.hoisted(() => ({
  cookies: {} as Record<string, string>,
  canCreate: true,
  total: 1,
  items: [] as Array<Record<string, unknown>>,
  tableProps: vi.fn(),
  list: vi.fn(),
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
vi.mock('@/server/services/item-images', () => ({
  ItemImagesService: {
    forCurrentUser: vi.fn(async () => ({
      primaryImagesWithThumbsForItems: vi.fn(async () => new Map()),
    })),
  },
}));
vi.mock('@/server/services/movements', () => ({ getItemTrends: vi.fn(async () => new Map()) }));

import RentalItemsPage from './page';

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

  it('the three empty states keep their words', async () => {
    h.total = 0;
    await renderPage();
    expect(screen.getByText('No rental items yet')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Add your first rental item' })).toBeTruthy();
    document.body.innerHTML = '';
    await renderPage({ status: 'archived' });
    expect(screen.getByText('No archived rental items')).toBeTruthy();
    document.body.innerHTML = '';
    await renderPage({ q: 'tent' });
    expect(screen.getByText('No rental items match your search')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Clear search' }).getAttribute('href')).toBe(
      '/dashboard/rentals/items',
    );
    expect(h.tableProps).not.toHaveBeenCalled();
  });
});
