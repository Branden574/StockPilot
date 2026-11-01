import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * WHAT A LIST THAT A FILTER LEAVES EMPTY SHOWS, AND HOW IT IS UNDONE (review
 * of the grouping walk's W4 no-match fix, 2026-10-20).
 *
 * The router here is a recorder: router.replace() and router.push() navigate
 * nowhere, and `land()` plays a navigation's arrival (the new address and, in
 * server mode, the server's new page). history.replaceState / pushState move
 * what useSearchParams reads, as Next's App Router does for a shallow update.
 */

const { routerMock, nav } = vi.hoisted(() => {
  const routerMock = { replace: vi.fn(), push: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() };
  let instance = new URLSearchParams('');
  const listeners = new Set<() => void>();
  const nav = {
    get: () => instance,
    set(next: string) {
      if (next === instance.toString()) return;
      instance = new URLSearchParams(next);
      for (const l of listeners) l();
    },
    subscribe(l: () => void) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
  return { routerMock, nav };
});

vi.mock('next/navigation', async () => {
  const React = await import('react');
  return {
    useRouter: () => routerMock,
    useSearchParams: () => React.useSyncExternalStore(nav.subscribe, nav.get, nav.get),
    usePathname: () => window.location.pathname,
  };
});

vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    prefetch: _prefetch,
    scroll: _scroll,
    replace: _replace,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
    prefetch?: boolean;
    scroll?: boolean;
    replace?: boolean;
  } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={typeof href === 'string' ? href : '#'} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock('next/image', () => ({
  default: (props: Record<string, unknown>) => {
    const { src, alt } = props as { src: string; alt?: string };
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt={alt ?? ''} />;
  },
}));

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/server/actions/saved-views', () => ({
  createSavedViewAction: vi.fn(),
  deleteSavedViewAction: vi.fn(),
  setActiveWarehouseAction: vi.fn(async () => ({ ok: true })),
  toggleSavedViewShareAction: vi.fn(),
}));
vi.mock('@/lib/download-export', () => ({ downloadInventoryExport: vi.fn() }));
vi.mock('@/components/inventory/bulk-actions', () => ({ BulkActions: () => null }));
vi.mock('@/components/ui/image-hover-preview', () => ({
  ImageHoverPreview: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  prewarmPreviewImages: vi.fn(),
}));
vi.mock('@/lib/cycle-counts/use-count-selection', () => ({
  useCountSelection: (selector: (s: { add: () => void }) => unknown) => selector({ add: vi.fn() }),
}));

import { InventoryTable, type InstantDatasetItem } from './inventory-table';

/* ---- fixtures ------------------------------------------------------------- */

function row(over: Partial<InstantDatasetItem> & { id: string; name: string }): InstantDatasetItem {
  return {
    sku: `SKU-${over.id}`,
    status: 'active',
    quantity_on_hand: 10,
    reorder_point: 0,
    unit_cost: 2,
    retail_price: 5,
    category_id: null,
    charter_id: null,
    primary_location_id: null,
    barcode: null,
    model_number: null,
    custom_fields: null,
    created_at: '2026-01-01T00:00:00+00:00',
    updated_at: '2026-01-02T00:00:00+00:00',
    ...over,
  };
}

const APPAREL = 'cat-apparel';
const SCIENCE = 'cat-science';
const ITEMS = [
  row({ id: 'beaker', name: 'Beaker Set 250 mL', category_id: SCIENCE }),
  row({ id: 'burner', name: 'Bunsen Burner', category_id: SCIENCE }),
  row({ id: 'stapler', name: 'Stapler', category_id: 'cat-office' }),
];
const BOOKS = [
  row({ id: 'dune', name: 'Dune', item_type: 'book' }),
  row({ id: 'atlas', name: 'World Atlas', item_type: 'book' }),
];
const RENTALS = [row({ id: 'tent', name: 'Canopy Tent', sku: 'RNT-TENT-01' })];

const LOOKUPS = {
  categories: new Map([
    [SCIENCE, { name: 'Science', color: null }],
    ['cat-office', { name: 'Office', color: null }],
    [APPAREL, { name: 'Apparel', color: null }],
  ]),
  locations: new Map<string, { name: string }>(),
  charters: new Map<string, { name: string; code: string | null }>(),
};

type List = 'items' | 'books' | 'rentals';
const BASE: Record<List, string> = {
  items: '/dashboard/inventory',
  books: '/dashboard/books',
  rentals: '/dashboard/rentals/items',
};

function tableFor(
  list: List,
  mode: 'instant' | 'server',
  {
    items,
    initialQuery = '',
    initialView,
    emptyNote,
  }: {
    items: InstantDatasetItem[];
    initialQuery?: string;
    initialView?: 'table' | 'grid';
    emptyNote?: string | null;
  },
) {
  const dataset = list === 'books' ? BOOKS : ITEMS;
  return (
    <InventoryTable
      items={items}
      lookups={LOOKUPS}
      total={items.length}
      initialQuery={initialQuery}
      pageSize={30}
      basePath={BASE[list]}
      rowLinkPrefix={BASE[list]}
      showBookFields={list === 'books'}
      rentalsOnly={list === 'rentals'}
      categories={[
        { id: SCIENCE, name: 'Science' },
        { id: 'cat-office', name: 'Office' },
        { id: APPAREL, name: 'Apparel' },
      ]}
      activeWarehouseId={null}
      currentUserId="u-manager"
      initialView={initialView}
      emptyNote={emptyNote}
      instant={
        mode === 'instant' && list !== 'rentals' ? { items: dataset, view: list } : undefined
      }
    />
  );
}

/* ---- the address ------------------------------------------------------------ */

const realReplaceState = History.prototype.replaceState;
/** Every address the TABLE wrote with replaceState / pushState (shallow). */
let tableWrites: string[] = [];

function setAddress(path: string) {
  realReplaceState.call(window.history, null, '', path);
  nav.set(new URL(path, window.location.origin).search.slice(1));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Lets the table's debounced work (the 150 ms search sync and fetch, the 300 ms filter commit) run. */
const settle = () =>
  act(async () => {
    await sleep(450);
  });

/** A navigation lands: the address moves and, in server mode, the server's new page arrives. */
async function land(path: string, rerender?: () => void) {
  await act(async () => {
    setAddress(path);
    rerender?.();
  });
}

const searchBox = () => screen.getByRole('textbox', { name: 'Search items' });

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  tableWrites = [];
  for (const k of ['replaceState', 'pushState'] as const) {
    const real = History.prototype[k];
    vi.spyOn(window.history, k).mockImplementation(function (
      this: History,
      data: unknown,
      unused: string,
      url?: string | URL | null,
    ) {
      real.call(window.history, data, unused, url);
      if (url != null) {
        const u = new URL(String(url), window.location.origin);
        tableWrites.push(u.pathname + u.search);
        nav.set(u.search.slice(1));
      }
    });
  }
  // The server-mode search box asks /api/items/search: nothing matches "zz".
  fetchSpy = vi.fn(async (input: string | URL) => {
    const u = new URL(String(input), window.location.origin);
    const needle = (u.searchParams.get('q') ?? '').toLowerCase();
    const pool =
      u.searchParams.get('rentalsOnly') === '1'
        ? RENTALS
        : u.searchParams.get('type') === 'book'
          ? BOOKS
          : ITEMS;
    const items = pool.filter((r) => r.name.toLowerCase().includes(needle));
    return { ok: true, json: async () => ({ items, total: items.length }) } as Response;
  });
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/* ---- Clear all filters ------------------------------------------------------ */

describe('"Clear all filters", pressed once, clears the search and the filters in every mode', () => {
  it.each<List>(['items', 'books', 'rentals'])(
    '%s, server mode: one navigation, to the bare list, and none back to the Category',
    async (list) => {
      const address = `${BASE[list]}?cat=${APPAREL}&q=zz`;
      setAddress(address);
      const view = render(tableFor(list, 'server', { items: [], initialQuery: 'zz' }));
      await settle();
      expect(searchBox()).toHaveValue('zz');
      routerMock.replace.mockClear();

      await userEvent.setup().click(screen.getByRole('button', { name: 'Clear all filters' }));
      await settle();
      // It used to be [bare list, ?cat=...]: the box's search effect answered the
      // emptied box with a replace built from the old address, Category kept.
      expect(routerMock.replace.mock.calls.map((c) => c[0])).toEqual([BASE[list]]);

      // The clear's navigation lands: the full list, nothing filtered, and
      // nothing navigates again.
      const all = list === 'books' ? BOOKS : list === 'rentals' ? RENTALS : ITEMS;
      await land(BASE[list], () => view.rerender(tableFor(list, 'server', { items: all })));
      await settle();
      expect(routerMock.replace).toHaveBeenCalledTimes(1);
      expect(searchBox()).toHaveValue('');
      expect(screen.queryByRole('button', { name: 'Clear all filters' })).toBeNull();
      expect(document.querySelectorAll('tbody tr[data-row-key]')).toHaveLength(all.length);
    },
  );

  it('items, instant mode: one press clears both too, with no server navigation', async () => {
    setAddress(`/dashboard/inventory?cat=${APPAREL}&q=zz`);
    render(tableFor('items', 'instant', { items: [], initialQuery: 'zz' }));
    await settle();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Clear all filters' }));
    await settle();
    expect(routerMock.replace).not.toHaveBeenCalled();
    expect(window.location.search).toBe('');
    expect(searchBox()).toHaveValue('');
    expect(document.querySelectorAll('tbody tr[data-row-key]')).toHaveLength(ITEMS.length);
  });

  it('server mode: emptying the box by hand still drops the search from the address (a Category stays)', async () => {
    setAddress(`/dashboard/inventory?cat=${SCIENCE}&q=zz`);
    render(tableFor('items', 'server', { items: [], initialQuery: 'zz' }));
    await settle();
    routerMock.replace.mockClear();
    await userEvent.setup().clear(searchBox());
    await settle();
    expect(routerMock.replace.mock.calls.map((c) => c[0])).toEqual([
      `/dashboard/inventory?cat=${SCIENCE}`,
    ]);
  });
});

/* ---- the list's own words --------------------------------------------------- */

const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
const datasetFor = (list: List) =>
  list === 'books' ? BOOKS : list === 'rentals' ? RENTALS : ITEMS;
/** The table's empty area: a list's own message, or the general line. */
const emptyArea = () => document.querySelector('[data-slot="state-panel"]') as HTMLElement | null;
const SCOPE_NOTE =
  "You're viewing North DC only. An admin can adjust warehouse access from the Team page.";

type Case = [list: List, address: string, title: string, description: string, label: string];
/**
 * Integrator decision 1 (2026-10-20): the pages' messages for a search, a stock
 * view or the Expected chip that left nothing stay, word for word, now in the
 * table's empty area with the filter bar on screen (base 378765ba7:
 * inventory/page.tsx:1145-1235, books/page.tsx:749-805, rentals/items/page.tsx:240-246).
 */
const CASES: Case[] = [
  [
    'items',
    'q=zzqqxx',
    'No items match your search',
    'Nothing matched "zzqqxx". Try a different SKU, name, or barcode.',
    'Clear search',
  ],
  [
    'items',
    'stock=low',
    'No low-stock items',
    'Nothing is at or below its reorder point right now. Nice.',
    'Show all items',
  ],
  [
    'items',
    'stock=out',
    'Nothing is out of stock',
    'No active items have a quantity of zero. Clear the filter to see all items.',
    'Show all items',
  ],
  [
    'items',
    'expected=1',
    'No expected items',
    'Items created from purchase orders appear here until their first stock is received.',
    'Back to all items',
  ],
  [
    'books',
    'expected=1',
    'No expected books',
    'Books created from purchase orders appear here until their first stock is received.',
    'Back to all books',
  ],
  [
    'books',
    'stock=low',
    'No low-stock books',
    'No books are at or below their reorder point right now. Clear the filter to see all books.',
    'Show all books',
  ],
  [
    'books',
    'stock=out',
    'No out-of-stock books',
    'Nothing is at zero quantity right now. Clear the filter to see all books.',
    'Show all books',
  ],
  [
    'rentals',
    'q=zzqqxx',
    'No rental items match your search',
    'Nothing matched "zzqqxx". Try a different name or SKU.',
    'Clear search',
  ],
];

/** The message, its way back, and the bar that shows and undoes the narrowing. */
function expectMessage(
  [list, address, title, description, label]: Case,
  view: 'table' | 'grid',
  note?: string,
) {
  const area = emptyArea();
  expect(area).not.toBeNull();
  const panel = within(area!);
  expect(panel.getByRole('heading', { level: 3, name: title })).toBeInTheDocument();
  expect(norm(area!.querySelector('p')?.textContent)).toBe(
    note ? `${description} ${note}` : description,
  );
  expect(panel.getByRole('link', { name: label })).toHaveAttribute('href', BASE[list]);
  expect(screen.queryByText('No items match your filters.')).toBeNull();
  // The filter bar stays, with what narrows the list marked.
  expect(screen.getByRole('button', { name: 'Filter by Category' })).toBeInTheDocument();
  if (address.startsWith('q=')) {
    expect(searchBox()).toHaveValue('zzqqxx');
    expect(screen.getByRole('button', { name: 'Clear all filters' })).toBeInTheDocument();
  }
  if (address.startsWith('stock=')) {
    const tab = address === 'stock=low' ? 'Low + critical' : 'Out of stock';
    expect(screen.getByRole('tab', { name: tab })).toHaveAttribute('aria-selected', 'true');
  }
  if (address === 'expected=1') {
    expect(screen.getByRole('link', { name: /^Expected/ })).toHaveAttribute('aria-pressed', 'true');
  }
  // Never inside the sideways scroller (see the phone-width tests below).
  if (view === 'table') {
    expect(area!.closest('table')).toBeNull();
    expect(area!.closest('.overflow-x-auto')).toBeNull();
  } else {
    expect(area!.closest('[data-slot="inventory-grid"]')).not.toBeNull();
  }
}

describe('A search, a stock view or the Expected chip that leaves nothing: the list says what its page said', () => {
  describe.each(['table', 'grid'] as const)('%s view', (view) => {
    it.each(CASES.filter((c) => c[0] !== 'rentals'))(
      '%s, ?%s in instant mode, the moment it is set: "%s"',
      async (...c) => {
        const [list, address] = c;
        setAddress(BASE[list]);
        render(tableFor(list, 'instant', { items: datasetFor(list), initialView: view }));
        const user = userEvent.setup();
        if (address.startsWith('q=')) {
          await user.type(searchBox(), 'zzqqxx');
        } else if (address.startsWith('stock=')) {
          await user.click(
            screen.getByRole('tab', {
              name: address === 'stock=low' ? 'Low + critical' : 'Out of stock',
            }),
          );
        } else {
          // The Expected chip shows only while something is expected: arrive by its address.
          await land(`${BASE[list]}?${address}`);
        }
        expectMessage(c, view);
        await settle();
        expect(window.location.search).toBe(`?${address}`);
        expectMessage(c, view);
      },
    );

    it.each(CASES.filter((c) => c[0] !== 'rentals'))(
      '%s, ?%s reloaded or pasted (instant mode): "%s"',
      async (...c) => {
        const [list, address] = c;
        setAddress(`${BASE[list]}?${address}`);
        render(
          tableFor(list, 'instant', {
            items: datasetFor(list),
            initialQuery: new URLSearchParams(address).get('q') ?? '',
            initialView: view,
          }),
        );
        await settle();
        expectMessage(c, view);
      },
    );

    it.each(CASES)('%s, ?%s in server mode (staff, viewers, Rentals items): "%s"', async (...c) => {
      const [list, address] = c;
      setAddress(`${BASE[list]}?${address}`);
      render(
        tableFor(list, 'server', {
          items: [],
          initialQuery: new URLSearchParams(address).get('q') ?? '',
          initialView: view,
        }),
      );
      await settle();
      expectMessage(c, view);
    });
  });

  it("Items: a staff member's or viewer's warehouse scope follows the description, as the page added it", async () => {
    for (const c of CASES.filter((x) => x[0] === 'items')) {
      setAddress(`${BASE.items}?${c[1]}`);
      const view = render(
        tableFor('items', 'server', {
          items: [],
          initialQuery: new URLSearchParams(c[1]).get('q') ?? '',
          emptyNote: SCOPE_NOTE,
        }),
      );
      await settle();
      expectMessage(c, 'table', SCOPE_NOTE);
      view.unmount();
    }
  });

  it.each<[List, string]>([
    ['items', `q=zz&cat=${APPAREL}`],
    ['items', 'q=zz&stock=low'],
    ['items', `stock=out&cat=${APPAREL}`],
    ['items', 'expected=1&q=zz'],
    ['items', `cat=${APPAREL}`],
    ['items', 'status=archived&auto=1'],
    ['books', 'q=zzqqxx'],
    ['books', `stock=low&cat=${APPAREL}`],
    ['rentals', `q=zz&cat=${APPAREL}`],
    ['rentals', 'stock=low'],
  ])('%s, ?%s: the general line, the bar and its chips', async (list, address) => {
    setAddress(`${BASE[list]}?${address}`);
    render(
      tableFor(list, 'server', {
        items: [],
        initialQuery: new URLSearchParams(address).get('q') ?? '',
      }),
    );
    await settle();
    const area = emptyArea();
    expect(norm(area?.textContent)).toBe('No items match your filters.');
    expect(area!.closest('.overflow-x-auto')).toBeNull();
    expect(screen.getByRole('button', { name: 'Filter by Category' })).toBeInTheDocument();
  });
});

describe('The way back each message offers', () => {
  it('Items, instant mode, "Clear search": the box empties and the whole list is back, with no server navigation', async () => {
    setAddress(BASE.items);
    render(tableFor('items', 'instant', { items: ITEMS }));
    const user = userEvent.setup();
    await user.type(searchBox(), 'zzqqxx');
    await settle();
    expect(window.location.search).toBe('?q=zzqqxx');
    await user.click(screen.getByRole('link', { name: 'Clear search' }));
    await settle();
    expect(searchBox()).toHaveValue('');
    expect(window.location.search).toBe('');
    expect(document.querySelectorAll('tbody tr[data-row-key]')).toHaveLength(ITEMS.length);
    expect(routerMock.push).not.toHaveBeenCalled();
    expect(routerMock.replace).not.toHaveBeenCalled();
  });

  it('Items, instant mode, "Clear search" before the typed search reached the address: it is dropped too', async () => {
    setAddress(BASE.items);
    render(tableFor('items', 'instant', { items: ITEMS }));
    const user = userEvent.setup();
    await user.type(searchBox(), 'zzqqxx');
    // No settle: the 150 ms address sync has not run.
    await user.click(screen.getByRole('link', { name: 'Clear search' }));
    await settle();
    expect(searchBox()).toHaveValue('');
    expect(tableWrites.filter((w) => w.includes('q='))).toEqual([]);
    expect(document.querySelectorAll('tbody tr[data-row-key]')).toHaveLength(ITEMS.length);
  });

  it('Books, instant mode, "Show all books" from Out of stock: the whole list, on All items', async () => {
    setAddress(`${BASE.books}?stock=out`);
    render(tableFor('books', 'instant', { items: BOOKS }));
    await userEvent.setup().click(screen.getByRole('link', { name: 'Show all books' }));
    await settle();
    expect(window.location.search).toBe('');
    expect(screen.getByRole('tab', { name: 'All items' })).toHaveAttribute('aria-selected', 'true');
    expect(document.querySelectorAll('tbody tr[data-row-key]')).toHaveLength(BOOKS.length);
  });

  it('Items, server mode, "Clear search" while a typed search is not in the address yet: the box drops it at once', async () => {
    setAddress(BASE.items);
    render(tableFor('items', 'server', { items: ITEMS }));
    const user = userEvent.setup();
    // The link navigates (next/link); here the click stops at the window, after the table saw it.
    const stop = (e: Event) => e.preventDefault();
    window.addEventListener('click', stop);
    try {
      // No settle: the box filters its page at once, the server search has not answered.
      await user.type(searchBox(), 'zzqqxx');
      expect(
        screen.getByRole('heading', { level: 3, name: 'No items match your search' }),
      ).toBeInTheDocument();
      await user.click(screen.getByRole('link', { name: 'Clear search' }));
      await settle();
    } finally {
      window.removeEventListener('click', stop);
    }
    expect(searchBox()).toHaveValue('');
    expect(document.querySelectorAll('tbody tr[data-row-key]')).toHaveLength(ITEMS.length);
    expect(tableWrites.filter((w) => w.includes('q='))).toEqual([]);
    expect(routerMock.replace).not.toHaveBeenCalled();
  });

  /**
   * Server mode (staff and viewers on Items, everyone on Rentals items): the link
   * navigates. The box empties at once, as "Clear all filters" empties it, and
   * makes no navigation of its own. It used to keep the old search for the whole
   * round trip, then take the address's empty search when the list landed, which
   * wiped a search typed in the meantime (review of B1, 2026-11-01).
   */
  it.each<[List, string]>([
    ['items', 'Stapler'],
    ['rentals', 'Canopy'],
  ])(
    '%s, server mode, "Clear search": the box empties at once, the link is the one navigation, and "%s" typed before the list lands stays',
    async (list, typed) => {
      setAddress(`${BASE[list]}?q=zzqqxx`);
      const view = render(tableFor(list, 'server', { items: [], initialQuery: 'zzqqxx' }));
      // The box asks the server for the address's search when it mounts, and writes it back.
      await settle();
      routerMock.replace.mockClear();
      tableWrites = [];
      const link = screen.getByRole('link', { name: 'Clear search' });
      expect(link).toHaveAttribute('href', BASE[list]);
      // The link navigates (next/link); here the click stops at the window, after the table saw it.
      const stop = (e: Event) => e.preventDefault();
      window.addEventListener('click', stop);
      try {
        await userEvent.setup().click(link);
      } finally {
        window.removeEventListener('click', stop);
      }
      expect(searchBox()).toHaveValue('');
      await settle();
      expect(routerMock.replace).not.toHaveBeenCalled();
      expect(tableWrites).toEqual([]);

      // A search is typed while the link's navigation is out; then the list lands.
      await act(async () => {
        fireEvent.change(searchBox(), { target: { value: typed } });
        setAddress(BASE[list]);
        view.rerender(tableFor(list, 'server', { items: datasetFor(list) }));
      });
      expect(searchBox()).toHaveValue(typed);
      await settle();
      expect(searchBox()).toHaveValue(typed);
      expect(window.location.search).toBe(`?q=${typed}`);
      expect(document.querySelectorAll('tbody tr[data-row-key]')).toHaveLength(1);
      expect(routerMock.replace).not.toHaveBeenCalled();
    },
  );
});

describe('Phone width: the empty area is never inside the sideways scroller (review 2026-10-20)', () => {
  it.each<List>(['items', 'books', 'rentals'])(
    '%s, Table view: the header row keeps every column, the empty area spans the card below it',
    async (list) => {
      setAddress(`${BASE[list]}?cat=${APPAREL}`);
      const { container } = render(tableFor(list, 'server', { items: [] }));
      await settle();
      // The table's own sideways scroller (the stock views strip scrolls too).
      const table = container.querySelector('table')!;
      expect(table).toHaveClass('min-w-[900px]');
      const scroller = table.closest('.overflow-x-auto')!;
      expect(scroller).not.toBeNull();
      expect(container.querySelectorAll('thead th')).toHaveLength(list === 'books' ? 13 : 11);
      expect(container.querySelectorAll('tbody tr')).toHaveLength(0);
      const area = emptyArea()!;
      expect(norm(area.textContent)).toBe('No items match your filters.');
      expect(scroller.contains(area)).toBe(false);
      expect(area.closest('table')).toBeNull();
    },
  );
});

/**
 * Review of batch D (2026-10-20): two narrowings had nothing on screen naming
 * them. An empty Discontinued view (?status=discontinued) showed "No items
 * match your filters." with the Active toggle marked and no way to see or undo
 * Discontinued; an Items type (?type=asset, kept by a saved view) had no
 * marker. Each is now a pressed chip in the views row that drops it.
 */
describe('The Discontinued view and an Items type show as pressed chips that drop them', () => {
  it.each<List>(['items', 'books', 'rentals'])(
    '%s, server mode, the Discontinued view: a pressed "Discontinued" chip back to Active',
    async (list) => {
      setAddress(`${BASE[list]}?status=discontinued&sort=name_asc`);
      render(tableFor(list, 'server', { items: [] }));
      await settle();
      const chip = screen.getByRole('link', { name: 'Discontinued' });
      expect(chip).toHaveAttribute('aria-pressed', 'true');
      expect(chip).toHaveAttribute('href', `${BASE[list]}?sort=name_asc`);
      expect(norm(emptyArea()?.textContent)).toBe('No items match your filters.');
    },
  );

  it('items, instant mode: pressing "Discontinued" is a shallow push to the Active list', async () => {
    setAddress(`${BASE.items}?status=discontinued`);
    render(tableFor('items', 'instant', { items: ITEMS }));
    expect(norm(emptyArea()?.textContent)).toBe('No items match your filters.');
    await userEvent.setup().click(screen.getByRole('link', { name: 'Discontinued' }));
    await settle();
    expect(window.location.search).toBe('');
    expect(screen.queryByRole('link', { name: 'Discontinued' })).toBeNull();
    expect(document.querySelectorAll('tbody tr[data-row-key]')).toHaveLength(ITEMS.length);
    expect(routerMock.push).not.toHaveBeenCalled();
  });

  it('no Discontinued chip on the other views', async () => {
    for (const status of ['active', 'all', 'archived']) {
      setAddress(`${BASE.items}?status=${status}`);
      const view = render(tableFor('items', 'server', { items: ITEMS }));
      expect(screen.queryByRole('link', { name: 'Discontinued' })).toBeNull();
      view.unmount();
    }
  });

  it.each([
    ['asset', 'Asset'],
    ['consumable', 'Consumable'],
    ['book', 'Book'],
  ])('items, ?type=%s: a pressed "%s" chip back to the products list', async (type, label) => {
    setAddress(`${BASE.items}?type=${type}&q=zz`);
    render(tableFor('items', 'server', { items: [], initialQuery: 'zz' }));
    await settle();
    const chip = screen.getByRole('link', { name: label });
    expect(chip).toHaveAttribute('aria-pressed', 'true');
    expect(chip).toHaveAttribute('href', `${BASE.items}?q=zz`);
  });

  it('no type chip for products or every type, nor on Books or Rentals items', async () => {
    for (const [list, address] of [
      ['items', 'type=product'],
      ['items', 'type=all&stock=low'],
      ['books', 'type=asset'],
      ['rentals', 'type=asset'],
    ] as Array<[List, string]>) {
      setAddress(`${BASE[list]}?${address}`);
      const view = render(tableFor(list, 'server', { items: [] }));
      for (const label of ['Asset', 'Consumable', 'Book', 'Product']) {
        expect(screen.queryByRole('link', { name: label })).toBeNull();
      }
      view.unmount();
    }
  });

  it('?type=all&stock=low (the dashboard\'s low-stock link) still says "No low-stock items"', async () => {
    setAddress(`${BASE.items}?stock=low&type=all`);
    render(tableFor('items', 'server', { items: [] }));
    await settle();
    expect(
      screen.getByRole('heading', { level: 3, name: 'No low-stock items' }),
    ).toBeInTheDocument();
  });
});
