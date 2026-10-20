import { act, render, screen } from '@testing-library/react';
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
  }: {
    items: InstantDatasetItem[];
    initialQuery?: string;
    initialView?: 'table' | 'grid';
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
    const pool = u.searchParams.get('type') === 'book' ? BOOKS : ITEMS;
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
