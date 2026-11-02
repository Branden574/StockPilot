import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';
import { toast } from 'sonner';
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

import { offline } from '@/test/rejected-request';

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

/** One title on two racks (one ISBN, a record per rack) and a book without it. */
const SHARED_ISBN = '9780140328721';
const ISBN_BOOKS = [
  row({ id: 'mat-1', name: 'Matilda', barcode: SHARED_ISBN, item_type: 'book' }),
  row({ id: 'mat-2', name: 'Matilda (Rack 4-B)', barcode: SHARED_ISBN, item_type: 'book' }),
  row({ id: 'atlas', name: 'World Atlas', barcode: '9780000000002', item_type: 'book' }),
];
const MATILDAS = ISBN_BOOKS.slice(0, 2);

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
  {
    items,
    initialQuery = '',
    dataset = list === 'books' ? BOOKS : ITEMS,
  }: { items: InstantDatasetItem[]; initialQuery?: string; dataset?: InstantDatasetItem[] },
) {
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
/**
 * While set, a shallow write moves the address bar at once but what
 * useSearchParams reads only on releaseLandings(): Next's App Router lands a
 * shallow write in a transition, after the call, so a keystroke can come in
 * between.
 */
let heldLandings: string[] | null = null;

function holdLandings() {
  heldLandings = [];
}

/** The held shallow writes land, in the order they were written. */
function releaseLandings() {
  const held = heldLandings ?? [];
  heldLandings = null;
  for (const search of held) nav.set(search);
}

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
  heldLandings = null;
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
        if (heldLandings) heldLandings.push(u.search.slice(1));
        else nav.set(u.search.slice(1));
      }
    });
  }
  // The server-mode search box asks /api/items/search: answer with the
  // records whose name or barcode holds the words (what the endpoint matches on).
  fetchSpy = vi.fn(async (input: string | URL) => {
    const u = new URL(String(input), window.location.origin);
    const needle = (u.searchParams.get('q') ?? '').toLowerCase();
    const pool = u.searchParams.get('type') === 'book' ? [...BOOKS, ...ISBN_BOOKS] : ITEMS;
    const items = pool.filter(
      (r) =>
        r.name.toLowerCase().includes(needle) || (r.barcode ?? '').toLowerCase().includes(needle),
    );
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

  // B40 with B1: the chip switches the warehouse first. When that gets no
  // answer the view is not applied, so it hands nothing to the box: a search
  // typed and not yet in the address stays typed (handing the view's empty
  // search over would drop it at once, as above), and it reaches the address.
  it('a view whose warehouse switch gets no answer leaves a typed search in the box', async () => {
    setAddress('/dashboard/inventory');
    render(tableFor('items', 'instant', { items: ITEMS }));
    const user = userEvent.setup();
    actions.setActiveWarehouseAction.mockRejectedValueOnce(offline());
    // No settle: the box has not written ?q= yet when the chip is pressed.
    await user.type(searchBox(), 'zz');
    await user.click(screen.getByRole('button', { name: 'Apply view Science room supplies' }));
    await vi.waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "We couldn't apply the view. Check your connection and try again.",
      ),
    );
    await settle();
    expect(searchBox()).toHaveValue('zz');
    expect(window.location.search).toBe('?q=zz');
    expect(routerMock.replace).not.toHaveBeenCalled();
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

/**
 * A SEARCH ANOTHER NAVIGATION PUTS IN THE ADDRESS (review 2026-10-20). The
 * saved-view chip was one way to change the address's search while the list
 * is open; the box ignored every other. Books' scan shortcut, when an ISBN
 * names several records (lookupBookByIsbnAction lists one per record carrying
 * it, so a title on two racks qualifies), calls
 * router.push('/dashboard/books?q=<ISBN>'): the box stayed empty and its sync
 * wrote the address back without q (instant mode), or the address kept q with
 * an empty box (server mode). Back and Forward did the same. The box now takes
 * the address's search whenever it changes to one the box did not write.
 */
describe('A search another navigation puts in the address: the box takes it and the list narrows', () => {
  const scanned = `/dashboard/books?q=${SHARED_ISBN}`;

  it("Books, instant mode: the scan shortcut's router.push keeps q, fills the box and narrows the list", async () => {
    setAddress('/dashboard/books');
    render(tableFor('books', 'instant', { items: ISBN_BOOKS, dataset: ISBN_BOOKS }));
    expect(shownNames()).toHaveLength(3);

    // router.push lands: the address moves (the same mounted table).
    await land(scanned);
    await settle();
    expect(searchBox()).toHaveValue(SHARED_ISBN);
    expect(window.location.search).toBe(`?q=${SHARED_ISBN}`);
    // Nothing wrote the address back without the search (it used to be /dashboard/books).
    expect(tableWrites).toEqual([]);
    expect(shownNames()).toEqual(MATILDAS.map((b) => b.name));
  });

  it("Books, server mode: the scan shortcut's router.push keeps q, fills the box and lists the matches", async () => {
    setAddress('/dashboard/books');
    const view = render(tableFor('books', 'server', { items: ISBN_BOOKS }));

    await land(scanned, () =>
      view.rerender(tableFor('books', 'server', { items: MATILDAS, initialQuery: SHARED_ISBN })),
    );
    await settle();
    expect(searchBox()).toHaveValue(SHARED_ISBN);
    // The box ran the search (its matches on other pages too) and kept the address.
    const searched = fetchSpy.mock.calls.map(
      (c) => new URL(String(c[0]), window.location.origin).searchParams.get('q') as string,
    );
    expect(searched).toEqual([SHARED_ISBN]);
    expect(routerMock.replace).not.toHaveBeenCalled();
    expect(window.location.search).toBe(`?q=${SHARED_ISBN}`);
    expect(shownNames()).toEqual(MATILDAS.map((b) => b.name));
  });

  it('a pushed search with a sort keeps both (the view of "?q=Grade+2&sort=name_asc" in the review)', async () => {
    setAddress('/dashboard/books');
    render(tableFor('books', 'instant', { items: BOOKS }));
    await land('/dashboard/books?q=Grade+2&sort=name_asc');
    await settle();
    expect(searchBox()).toHaveValue('Grade 2');
    expect(window.location.search).toBe('?q=Grade+2&sort=name_asc');
    expect(tableWrites).toEqual([]);
    expect(shownNames()).toEqual(GRADE_2.map((b) => b.name));
  });

  it('Back to an earlier search: the box takes it and nothing writes the later one back', async () => {
    setAddress('/dashboard/books');
    render(tableFor('books', 'instant', { items: BOOKS }));
    const user = userEvent.setup();
    await user.type(searchBox(), 'Dune');
    await settle();
    expect(window.location.search).toBe('?q=Dune');

    tableWrites = [];
    await land('/dashboard/books?q=Grade+2');
    await settle();
    expect(searchBox()).toHaveValue('Grade 2');
    expect(tableWrites).toEqual([]);
    expect(window.location.search).toBe('?q=Grade+2');
    expect(shownNames()).toEqual(GRADE_2.map((b) => b.name));

    // And to the list without a search: the box empties.
    await land('/dashboard/books');
    await settle();
    expect(searchBox()).toHaveValue('');
    expect(tableWrites).toEqual([]);
    expect(shownNames()).toHaveLength(4);
  });

  it("server mode, Back to another search: that search's rows at once, not the last search's answer", async () => {
    setAddress('/dashboard/books');
    const view = render(tableFor('books', 'server', { items: BOOKS }));
    await userEvent.setup().type(searchBox(), 'Dune');
    await settle();
    expect(shownNames()).toEqual(['Dune']);

    // The server's page for the other search lands; the box's own request for it stays out.
    fetchSpy.mockImplementation(() => new Promise<Response>(() => {}));
    await land('/dashboard/books?q=Grade+2', () =>
      view.rerender(tableFor('books', 'server', { items: GRADE_2, initialQuery: 'Grade 2' })),
    );
    expect(searchBox()).toHaveValue('Grade 2');
    // Not ["Dune"], the last search's server answer, under the new search.
    expect(shownNames()).toEqual(GRADE_2.map((b) => b.name));
    await settle();
    expect(shownNames()).toEqual(GRADE_2.map((b) => b.name));
  });

  it('the box never takes back its own search: what is typed stays as typed while the address catches up', async () => {
    setAddress('/dashboard/books');
    render(tableFor('books', 'instant', { items: BOOKS }));
    const user = userEvent.setup();
    // A trailing space: the address gets the trimmed search, the box keeps the space.
    await user.type(searchBox(), 'Grade 2 ');
    await settle();
    expect(window.location.search).toBe('?q=Grade+2');
    expect(searchBox()).toHaveValue('Grade 2 ');
    await user.type(searchBox(), 'R');
    await settle();
    expect(searchBox()).toHaveValue('Grade 2 R');
    expect(window.location.search).toBe('?q=Grade+2+R');
  });

  it('server mode: emptying the box still clears the search from the address once', async () => {
    setAddress('/dashboard/books?q=Dune');
    render(tableFor('books', 'server', { items: [BOOKS[3]!], initialQuery: 'Dune' }));
    await settle();
    await userEvent.setup().clear(searchBox());
    await settle();
    expect(routerMock.replace).toHaveBeenCalledTimes(1);
    expect(routerMock.replace).toHaveBeenCalledWith('/dashboard/books', { scroll: false });
    // The navigation lands without the search: the box stays empty.
    await land('/dashboard/books');
    await settle();
    expect(searchBox()).toHaveValue('');
    expect(routerMock.replace).toHaveBeenCalledTimes(1);
  });
});

/**
 * AN ADDRESS THE BOX WROTE THAT LANDS LATE. The box takes any search that
 * lands in the address unless the box wrote it itself (`agreedQ`, set just
 * before each write). A write can land after the next keystroke: Next lands a
 * shallow write in a transition, and a server navigation (the emptied box,
 * Clear all filters, the way back under a list's own message) takes a round
 * trip. If the box did not mark its own write
 * first, that late landing would read as another navigation's search and
 * replace what was typed since. The tests above land every write at once, so
 * none of them reaches this order.
 */
describe('An address the box wrote that lands late never replaces what was typed since', () => {
  it('instant mode: typing on while its own search is landing keeps what was typed', async () => {
    setAddress('/dashboard/books');
    render(tableFor('books', 'instant', { items: BOOKS }));
    holdLandings();
    await userEvent.setup().type(searchBox(), 'Grade');
    await settle();
    expect(window.location.search).toBe('?q=Grade');

    await act(async () => {
      fireEvent.change(searchBox(), { target: { value: 'Grade 5' } });
      releaseLandings();
    });
    expect(searchBox()).toHaveValue('Grade 5');
    await settle();
    expect(searchBox()).toHaveValue('Grade 5');
    expect(window.location.search).toBe('?q=Grade+5');
    expect(shownNames()).toEqual(['Grade 5 Atlas']);
  });

  it('server mode: typing on while the address of the search it ran is landing keeps what was typed', async () => {
    setAddress('/dashboard/books');
    render(tableFor('books', 'server', { items: BOOKS }));
    holdLandings();
    await userEvent.setup().type(searchBox(), 'Dune');
    await settle();
    expect(window.location.search).toBe('?q=Dune');

    await act(async () => {
      fireEvent.change(searchBox(), { target: { value: 'Grade 5' } });
      releaseLandings();
    });
    expect(searchBox()).toHaveValue('Grade 5');
    await settle();
    expect(searchBox()).toHaveValue('Grade 5');
    expect(window.location.search).toBe('?q=Grade+5');
    expect(shownNames()).toEqual(['Grade 5 Atlas']);
  });

  it('server mode: a new search typed before the list without the old one arrives stays', async () => {
    setAddress('/dashboard/books?q=Dune');
    const view = render(tableFor('books', 'server', { items: [BOOKS[3]!], initialQuery: 'Dune' }));
    await settle();
    await userEvent.setup().clear(searchBox());
    await settle();
    expect(routerMock.replace.mock.calls.map((c) => c[0])).toEqual(['/dashboard/books']);

    await act(async () => {
      fireEvent.change(searchBox(), { target: { value: 'Grade 5' } });
      setAddress('/dashboard/books');
      view.rerender(tableFor('books', 'server', { items: BOOKS }));
    });
    expect(searchBox()).toHaveValue('Grade 5');
    await settle();
    expect(searchBox()).toHaveValue('Grade 5');
    expect(window.location.search).toBe('?q=Grade+5');
    expect(shownNames()).toEqual(['Grade 5 Atlas']);
  });

  it('server mode: a search typed after "Clear all filters", before the bare list arrives, stays', async () => {
    setAddress(`/dashboard/inventory?cat=${SCIENCE}&q=zz`);
    const view = render(tableFor('items', 'server', { items: [], initialQuery: 'zz' }));
    await settle();
    routerMock.replace.mockClear();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Clear all filters' }));
    await settle();
    expect(routerMock.replace.mock.calls.map((c) => c[0])).toEqual(['/dashboard/inventory']);

    await act(async () => {
      fireEvent.change(searchBox(), { target: { value: 'Stapler' } });
      setAddress('/dashboard/inventory');
      view.rerender(tableFor('items', 'server', { items: ITEMS }));
    });
    expect(searchBox()).toHaveValue('Stapler');
    await settle();
    expect(searchBox()).toHaveValue('Stapler');
    expect(window.location.search).toBe('?q=Stapler');
    expect(shownNames()).toEqual(['Stapler']);
  });

  /*
   * The way back under a list's own message ("Clear search" here) drops the
   * search as "Clear all filters" does, and the same late landing applies to it
   * (review of B1, 2026-11-01): it used to leave the box unmarked, so its landing
   * wiped a search typed in the meantime, while the same steps through "Clear all
   * filters" kept it (the test above).
   */
  it('instant mode: a search typed after "Clear search", while its push is landing, stays', async () => {
    setAddress('/dashboard/inventory?q=zzqqxx');
    render(tableFor('items', 'instant', { items: ITEMS, initialQuery: 'zzqqxx' }));
    await settle();
    holdLandings();
    await userEvent.setup().click(screen.getByRole('link', { name: 'Clear search' }));
    expect(searchBox()).toHaveValue('');
    expect(window.location.search).toBe('');

    await act(async () => {
      fireEvent.change(searchBox(), { target: { value: 'Stapler' } });
      releaseLandings();
    });
    expect(searchBox()).toHaveValue('Stapler');
    await settle();
    expect(searchBox()).toHaveValue('Stapler');
    expect(window.location.search).toBe('?q=Stapler');
    expect(shownNames()).toEqual(['Stapler']);
    expect(routerMock.replace).not.toHaveBeenCalled();
  });

  it('server mode: a search typed after "Clear search", before the bare list arrives, stays', async () => {
    setAddress('/dashboard/inventory?q=zzqqxx');
    const view = render(tableFor('items', 'server', { items: [], initialQuery: 'zzqqxx' }));
    await settle();
    routerMock.replace.mockClear();
    // The link navigates (next/link); here the click stops at the window, after the table saw it.
    const stop = (e: Event) => e.preventDefault();
    window.addEventListener('click', stop);
    try {
      await userEvent.setup().click(screen.getByRole('link', { name: 'Clear search' }));
    } finally {
      window.removeEventListener('click', stop);
    }
    expect(searchBox()).toHaveValue('');
    await settle();
    // The link is the one navigation: the emptied box makes none of its own.
    expect(routerMock.replace).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.change(searchBox(), { target: { value: 'Stapler' } });
      setAddress('/dashboard/inventory');
      view.rerender(tableFor('items', 'server', { items: ITEMS }));
    });
    expect(searchBox()).toHaveValue('Stapler');
    await settle();
    expect(searchBox()).toHaveValue('Stapler');
    expect(window.location.search).toBe('?q=Stapler');
    expect(shownNames()).toEqual(['Stapler']);
    expect(routerMock.replace).not.toHaveBeenCalled();
  });
});
