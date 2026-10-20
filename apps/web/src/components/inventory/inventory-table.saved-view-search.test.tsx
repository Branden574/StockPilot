import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A SAVED VIEW APPLIES ITS SEARCH (grouping walk 2026-10-20, W4 shared-view).
 *
 * Applying the shared Books view "Grade 2 readers" ({q: 'Grade 2', sort:
 * 'name_asc'}) wrote ?q=Grade+2&sort=name_asc and then lost q: the address
 * became ?sort=name_asc, the search box stayed empty and the list did not
 * narrow (66 -> 66), on 3400 and on production alike, in instant and server
 * modes. The box is the table's own state and the chip only navigates, so the
 * box's URL sync wrote its empty value back over the view's search (instant
 * mode, a shallow replace; server mode, a router.replace). A view without a
 * search kept a typed search the same way, writing it back into the view's
 * address. The view's state now applies whole: its search reaches the box once
 * its address lands (or the box empties for a view without one), the address
 * keeps it and the list narrows.
 *
 * The router here is a recorder: router.replace() navigates nowhere, and
 * `land()` plays the navigation's arrival (the new address and, in server mode,
 * the server's new page). history.replaceState / pushState also move what
 * useSearchParams reads, as Next's App Router does for a shallow update.
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

const { actions } = vi.hoisted(() => ({
  actions: {
    setActiveWarehouseAction: vi.fn(async () => ({ ok: true })),
  },
}));
vi.mock('@/server/actions/saved-views', () => ({
  createSavedViewAction: vi.fn(),
  deleteSavedViewAction: vi.fn(),
  setActiveWarehouseAction: actions.setActiveWarehouseAction,
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

const BOOKS = [
  row({ id: 'g2-a', name: 'Grade 2 Reader: Frogs', item_type: 'book' }),
  row({ id: 'g2-b', name: 'Grade 2 Reader: Moons', item_type: 'book' }),
  row({ id: 'g5', name: 'Grade 5 Atlas', item_type: 'book' }),
  row({ id: 'dune', name: 'Dune', item_type: 'book' }),
];
const GRADE_2 = BOOKS.slice(0, 2);

const SCIENCE = 'cat-science';
const ITEMS = [
  row({ id: 'beaker', name: 'Beaker Set 250 mL', category_id: SCIENCE }),
  row({ id: 'burner', name: 'Bunsen Burner', category_id: SCIENCE }),
  row({ id: 'stapler', name: 'Stapler', category_id: 'cat-office' }),
];
const SCIENCE_ROWS = ITEMS.slice(0, 2);

const LOOKUPS = {
  categories: new Map([
    [SCIENCE, { name: 'Science', color: null }],
    ['cat-office', { name: 'Office', color: null }],
  ]),
  locations: new Map<string, { name: string }>(),
  charters: new Map<string, { name: string; code: string | null }>(),
};

/** "Grade 2 readers": the owner's shared Books view (lab seed). */
const GRADE_2_READERS = {
  id: 'view-g2',
  name: 'Grade 2 readers',
  state: { q: 'Grade 2', sort: 'name_asc' },
  isShared: true,
  ownerId: 'u-owner',
};
/** "Science room supplies": a view with a Category and no search (lab seed). */
const SCIENCE_ROOM = {
  id: 'view-sci',
  name: 'Science room supplies',
  state: { cat: [SCIENCE], sort: 'name_asc' },
  isShared: true,
  ownerId: 'u-manager',
};
/** An Items view with a search (none in the lab seed; the same chip). */
const BEAKERS = {
  id: 'view-beakers',
  name: 'Beakers',
  state: { q: 'Beaker', sort: 'name_asc' },
  isShared: false,
  ownerId: 'u-manager',
};

type List = 'books' | 'items';
const BASE: Record<List, string> = { books: '/dashboard/books', items: '/dashboard/inventory' };

function tableFor(
  list: List,
  mode: 'instant' | 'server',
  { items, initialQuery = '' }: { items: InstantDatasetItem[]; initialQuery?: string },
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
      categories={[
        { id: SCIENCE, name: 'Science' },
        { id: 'cat-office', name: 'Office' },
      ]}
      savedViews={list === 'books' ? [GRADE_2_READERS] : [SCIENCE_ROOM, BEAKERS]}
      savedViewScope={list === 'books' ? 'books' : 'inventory'}
      activeWarehouseId={null}
      currentUserId="u-manager"
      instant={mode === 'instant' ? { items: dataset, view: list } : undefined}
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
/** Lets the table's debounced work (150 ms search sync and fetch) run. */
const settle = () =>
  act(async () => {
    await sleep(400);
  });

/** The address the view's chip asked the router for (once its cookie action returned). */
async function requestedAddress(): Promise<string> {
  await vi.waitFor(() => expect(routerMock.replace).toHaveBeenCalledTimes(1));
  return routerMock.replace.mock.calls[0]![0] as string;
}

/** The navigation lands: the address moves and, in server mode, the server's new page arrives. */
async function land(path: string, rerender?: () => void) {
  await act(async () => {
    setAddress(path);
    rerender?.();
  });
}

const searchBox = () => screen.getByRole('textbox', { name: 'Search items' });
const shownNames = () =>
  [...document.querySelectorAll('tbody tr[data-row-key]')].map(
    (tr) => tr.querySelector('a')?.textContent?.trim() ?? '',
  );

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
  // The server-mode search box asks /api/items/search: answer with the
  // records whose name holds the words (what the endpoint matches on).
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

/* ---- the tests -------------------------------------------------------------- */

describe('Applying a saved view with a search: the box, the address and the list follow the view', () => {
  it('Books, instant mode (manager): "Grade 2 readers" keeps q, fills the box and narrows the list', async () => {
    setAddress('/dashboard/books');
    render(tableFor('books', 'instant', { items: BOOKS }));
    expect(shownNames()).toHaveLength(4);

    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Apply view Grade 2 readers' }));
    expect(actions.setActiveWarehouseAction).toHaveBeenCalledWith(null);
    expect(await requestedAddress()).toBe('/dashboard/books?q=Grade+2&sort=name_asc');
    expect(routerMock.refresh).toHaveBeenCalledTimes(1);

    // While the navigation is in flight the table writes no address of its own.
    await settle();
    expect(tableWrites).toEqual([]);

    await land('/dashboard/books?q=Grade+2&sort=name_asc');
    await settle();
    expect(searchBox()).toHaveValue('Grade 2');
    expect(window.location.search).toBe('?q=Grade+2&sort=name_asc');
    // Nothing wrote the address without the view's search (it used to be ?sort=name_asc).
    expect(tableWrites.filter((w) => !w.includes('q=Grade+2'))).toEqual([]);
    expect(shownNames()).toEqual(GRADE_2.map((b) => b.name));
  });

  it('Books, server mode (staff, viewer): "Grade 2 readers" keeps q, fills the box and narrows the list', async () => {
    setAddress('/dashboard/books');
    const view = render(tableFor('books', 'server', { items: BOOKS }));

    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Apply view Grade 2 readers' }));
    expect(await requestedAddress()).toBe('/dashboard/books?q=Grade+2&sort=name_asc');

    await land('/dashboard/books?q=Grade+2&sort=name_asc', () =>
      view.rerender(tableFor('books', 'server', { items: GRADE_2, initialQuery: 'Grade 2' })),
    );
    await settle();
    expect(searchBox()).toHaveValue('Grade 2');
    // The box's sync never navigated away from the view (it used to replace
    // the address with ?sort=name_asc, which re-read the whole list).
    expect(routerMock.replace).toHaveBeenCalledTimes(1);
    expect(window.location.search).toBe('?q=Grade+2&sort=name_asc');
    expect(shownNames()).toEqual(GRADE_2.map((b) => b.name));
  });

  it('Items, instant mode: a view with a search applies it the same way', async () => {
    setAddress('/dashboard/inventory');
    render(tableFor('items', 'instant', { items: ITEMS }));

    await userEvent.setup().click(screen.getByRole('button', { name: 'Apply view Beakers' }));
    expect(await requestedAddress()).toBe('/dashboard/inventory?q=Beaker&sort=name_asc');
    await land('/dashboard/inventory?q=Beaker&sort=name_asc');
    await settle();
    expect(searchBox()).toHaveValue('Beaker');
    expect(window.location.search).toBe('?q=Beaker&sort=name_asc');
    expect(shownNames()).toEqual(['Beaker Set 250 mL']);
  });

  it('Items, server mode: a view with a search applies it the same way', async () => {
    setAddress('/dashboard/inventory');
    const view = render(tableFor('items', 'server', { items: ITEMS }));

    await userEvent.setup().click(screen.getByRole('button', { name: 'Apply view Beakers' }));
    expect(await requestedAddress()).toBe('/dashboard/inventory?q=Beaker&sort=name_asc');
    await land('/dashboard/inventory?q=Beaker&sort=name_asc', () =>
      view.rerender(tableFor('items', 'server', { items: [ITEMS[0]!], initialQuery: 'Beaker' })),
    );
    await settle();
    expect(searchBox()).toHaveValue('Beaker');
    expect(routerMock.replace).toHaveBeenCalledTimes(1);
    expect(window.location.search).toBe('?q=Beaker&sort=name_asc');
    expect(shownNames()).toEqual(['Beaker Set 250 mL']);
  });
});

describe('Applying a saved view without a search clears a typed search', () => {
  it('instant mode: the box empties, the address is the view, the list is the view', async () => {
    setAddress('/dashboard/inventory');
    render(tableFor('items', 'instant', { items: ITEMS }));
    const user = userEvent.setup();
    await user.type(searchBox(), 'zzz');
    await settle();
    expect(window.location.search).toBe('?q=zzz');

    await user.click(screen.getByRole('button', { name: 'Apply view Science room supplies' }));
    expect(await requestedAddress()).toBe(`/dashboard/inventory?sort=name_asc&cat=${SCIENCE}`);
    await land(`/dashboard/inventory?sort=name_asc&cat=${SCIENCE}`);
    await settle();
    expect(searchBox()).toHaveValue('');
    // It used to write the typed search back: ?sort=name_asc&cat=...&q=zzz.
    expect(window.location.search).toBe(`?sort=name_asc&cat=${SCIENCE}`);
    expect(shownNames()).toEqual(SCIENCE_ROWS.map((r) => r.name));
  });

  it('server mode: the box empties and no search is sent or written after the view lands', async () => {
    setAddress('/dashboard/inventory');
    const view = render(tableFor('items', 'server', { items: ITEMS }));
    const user = userEvent.setup();
    await user.type(searchBox(), 'zzz');
    await settle();
    expect(window.location.search).toBe('?q=zzz');

    await user.click(screen.getByRole('button', { name: 'Apply view Science room supplies' }));
    expect(await requestedAddress()).toBe(`/dashboard/inventory?sort=name_asc&cat=${SCIENCE}`);
    fetchSpy.mockClear();
    tableWrites = [];
    await land(`/dashboard/inventory?sort=name_asc&cat=${SCIENCE}`, () =>
      view.rerender(tableFor('items', 'server', { items: SCIENCE_ROWS })),
    );
    await settle();
    expect(searchBox()).toHaveValue('');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(tableWrites).toEqual([]);
    expect(window.location.search).toBe(`?sort=name_asc&cat=${SCIENCE}`);
    expect(shownNames()).toEqual(SCIENCE_ROWS.map((r) => r.name));
  });

  it('a search typed and not yet in the address is dropped at once, before the view lands', async () => {
    setAddress('/dashboard/inventory');
    render(tableFor('items', 'instant', { items: ITEMS }));
    const user = userEvent.setup();
    // No settle: the box has not written ?q= yet when the chip is pressed.
    await user.type(searchBox(), 'zz');
    await user.click(screen.getByRole('button', { name: 'Apply view Science room supplies' }));
    await vi.waitFor(() => expect(searchBox()).toHaveValue(''));
    await settle();
    // The dropped search never reached the address.
    expect(tableWrites.filter((w) => w.includes('q='))).toEqual([]);
  });
});

describe('Typing still drives the box and the address as before', () => {
  it('instant mode: a typed search reaches the address and no view is involved', async () => {
    setAddress('/dashboard/books');
    render(tableFor('books', 'instant', { items: BOOKS }));
    await userEvent.setup().type(searchBox(), 'Dune');
    await settle();
    expect(window.location.search).toBe('?q=Dune');
    expect(within(document.body).getByRole('textbox', { name: 'Search items' })).toHaveValue(
      'Dune',
    );
    expect(shownNames()).toEqual(['Dune']);
    expect(routerMock.replace).not.toHaveBeenCalled();
  });
});
