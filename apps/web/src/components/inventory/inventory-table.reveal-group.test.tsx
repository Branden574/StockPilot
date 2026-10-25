import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * B5 (2026-10-24 docket): after Group selected on the web, the new group's
 * header can land on another page than the one the records were picked on.
 * A display group is one unit that clusters at its best-ranked record and
 * pages are packed unit by unit, so records picked on two pages, or a unit
 * that no longer fits the end of its page, are drawn elsewhere.
 *
 * Instant mode (the list holds every record) turns to the page that draws the
 * header once its refreshed rows carry the grouping, opens the group and
 * scrolls to it. A list paged on the server cannot tell which page that is:
 * the done message links to ?group=<id>, the server plans that page, and the
 * table opens the group there, scrolls to it and puts the page in the address
 * in place of ?group=.
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
    usePathname: () => '/dashboard/inventory',
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
  setActiveWarehouseAction: vi.fn(),
  toggleSavedViewShareAction: vi.fn(),
}));
vi.mock('@/lib/download-export', () => ({ downloadInventoryExport: vi.fn() }));
vi.mock('@/components/ui/image-hover-preview', () => ({
  ImageHoverPreview: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  prewarmPreviewImages: vi.fn(),
}));
vi.mock('@/lib/cycle-counts/use-count-selection', () => ({
  useCountSelection: (selector: (s: { add: () => void }) => unknown) => selector({ add: vi.fn() }),
}));
// A row chip's Add to group opens GroupSelectedDialog from the table itself
// (not the bulk bar): its props are kept, so a test can answer as the dialog
// does after a save.
const { addDialog } = vi.hoisted(() => ({
  addDialog: {
    props: null as {
      itemIds: readonly string[];
      initialGroupId?: string | null;
      showGroupHref?: (groupId: string) => string;
      onDone: (outcome: unknown) => void;
    } | null,
  },
}));
vi.mock('@/components/inventory/display-group-dialogs', () => ({
  GroupSelectedDialog: (props: NonNullable<typeof addDialog.props>) => {
    addDialog.props = props;
    return null;
  },
  RemoveFromGroupDialog: () => null,
  RenameGroupDialog: () => null,
}));

const { bar } = vi.hoisted(() => ({
  bar: {
    onGrouped: undefined as
      ((groupId: string, changedItemIds: readonly string[]) => void) | undefined,
    showGroupHref: undefined as ((groupId: string) => string) | undefined,
  },
}));
vi.mock('@/components/inventory/bulk-actions', () => ({
  BulkActions: (props: typeof bar) => {
    bar.onGrouped = props.onGrouped;
    bar.showGroupHref = props.showGroupHref;
    return null;
  },
}));

import { planGroupAwarePage } from '@/lib/inventory/instant-mode';

import { InventoryTable, type InstantDatasetItem } from './inventory-table';

const G = '0e5f2c1a-3b4d-4e6f-8a9b-0c1d2e3f4a5b';
const OTHER = '9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a';

const LOOKUPS = {
  categories: new Map<string, { name: string; color: string | null }>(),
  locations: new Map<string, { name: string }>(),
  charters: new Map<string, { name: string; code: string | null }>(),
};

/** A record; a lower rank sorts higher on the default (last updated) list. */
function rec(id: string, rank: number, over: Partial<InstantDatasetItem> = {}): InstantDatasetItem {
  return {
    id,
    name: `Item ${id}`,
    sku: `SKU-${id}`,
    status: 'active',
    item_type: 'product',
    quantity_on_hand: 1,
    reorder_point: 0,
    unit_cost: 1,
    retail_price: 2,
    category_id: null,
    charter_id: null,
    primary_location_id: null,
    barcode: null,
    model_number: null,
    custom_fields: null,
    display_group_id: null,
    display_group_name: null,
    display_group_version: null,
    created_at: '2026-01-01T00:00:00+00:00',
    updated_at: new Date(Date.UTC(2026, 9, 1) - rank * 60_000).toISOString(),
    ...over,
  } as InstantDatasetItem;
}

const inG = { display_group_id: G, display_group_name: 'Pair', display_group_version: 1 };

/** 90 plain records plus the given ones (92: four pages, the last of two). */
function view(extra: InstantDatasetItem[]): InstantDatasetItem[] {
  const rows: InstantDatasetItem[] = [];
  for (let i = 1; i <= 90; i++) rows.push(rec(`r${String(i).padStart(3, '0')}`, i * 10));
  return [...rows, ...extra];
}

/** g-a and g-b sort at the end of page 2 and the start of page 3: grouped,
 *  they no longer fit what is left of page 2 and open page 3. */
const straddle = (grouped: boolean) =>
  view([rec('g-a', 595, grouped ? inG : {}), rec('g-b', 605, grouped ? inG : {})]);

function at(search: string) {
  nav.set(search);
  window.history.replaceState(
    null,
    '',
    search ? `/dashboard/inventory?${search}` : '/dashboard/inventory',
  );
}

const pager = () => screen.getAllByRole('button', { name: /jump to page/i })[0]!.textContent;
const groupHeader = (container: HTMLElement) =>
  container.querySelector(`[data-group-key="display-group:${G}"]`);

let scrolled: Array<string | null> = [];
let pushes: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  bar.onGrouped = undefined;
  bar.showGroupHref = undefined;
  addDialog.props = null;
  scrolled = [];
  pushes = [];
  at('');
  // Next's App Router follows window.history.pushState / replaceState
  // (useSearchParams moves with the address); so does this stub.
  const push = History.prototype.pushState;
  const replace = History.prototype.replaceState;
  vi.spyOn(window.history, 'pushState').mockImplementation(function (this: History, ...a) {
    push.apply(window.history, a);
    pushes.push(String(a[2]));
    nav.set(window.location.search.slice(1));
  });
  vi.spyOn(window.history, 'replaceState').mockImplementation(function (this: History, ...a) {
    replace.apply(window.history, a);
    nav.set(window.location.search.slice(1));
  });
  vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function (this: Element) {
    scrolled.push(this.getAttribute('data-group-key'));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function instantTable(items: InstantDatasetItem[], initialQuery = '') {
  return (
    <InventoryTable
      items={items}
      lookups={LOOKUPS}
      total={items.length}
      initialQuery={initialQuery}
      pageSize={30}
      canUngroup
      instant={{ items, view: 'items' }}
    />
  );
}

describe('instant mode: after a grouping the list turns to the page that draws the header', () => {
  it('waits for the refreshed rows, then turns to that page, opens the group and scrolls to it', async () => {
    at('page=2');
    const { container, rerender } = render(instantTable(straddle(false)));
    expect(pager()).toBe('Page 2 of 4');

    // The review closed on the grouping; the refresh has not landed yet.
    act(() => bar.onGrouped!(G, ['g-a', 'g-b']));
    expect(window.location.search).toBe('?page=2');
    expect(pushes).toEqual([]);

    // The refreshed rows carry the grouping: the header is on page 3.
    rerender(instantTable(straddle(true)));
    expect(window.location.search).toBe('?page=3');
    // A page turn the person can step back from, like the pager's.
    expect(pushes).toEqual(['/dashboard/inventory?page=3']);
    expect(pager()).toBe('Page 3 of 4');
    expect(groupHeader(container)).not.toBeNull();
    expect(screen.getByRole('button', { name: /collapse group pair/i })).toBeInTheDocument();
    expect(scrolled).toEqual([`display-group:${G}`]);
  });

  it('turns at once when the refresh landed before the review closed', async () => {
    at('page=2');
    const { rerender } = render(instantTable(straddle(false)));
    rerender(instantTable(straddle(true)));
    act(() => bar.onGrouped!(G, ['g-a', 'g-b']));
    expect(window.location.search).toBe('?page=3');
    expect(scrolled).toEqual([`display-group:${G}`]);
  });

  it('a header on the page on screen: no turn, the group opens and is scrolled to', () => {
    // Both records near the top of page 1.
    const before = view([rec('g-a', 15), rec('g-b', 25)]);
    const after = view([rec('g-a', 15, inG), rec('g-b', 25, inG)]);
    const { container, rerender } = render(instantTable(before));
    act(() => bar.onGrouped!(G, ['g-a', 'g-b']));
    rerender(instantTable(after));
    expect(pushes).toEqual([]);
    expect(window.location.search).toBe('');
    expect(groupHeader(container)).not.toBeNull();
    expect(screen.getByRole('button', { name: /collapse group pair/i })).toBeInTheDocument();
    expect(scrolled).toEqual([`display-group:${G}`]);
  });

  it('a person who moved on before the rows landed is not pulled back', () => {
    at('page=2');
    const { rerender } = render(instantTable(straddle(false)));
    act(() => bar.onGrouped!(G, ['g-a', 'g-b']));
    act(() => at('page=1'));
    rerender(instantTable(straddle(true)));
    expect(window.location.search).toBe('?page=1');
    expect(pushes).toEqual([]);
    expect(scrolled).toEqual([]);
  });

  it('a group that does not form in this view (one of its records filtered out) turns nothing', () => {
    at('page=2&status=archived');
    const items = view([
      rec('g-a', 595, { ...inG, status: 'archived' }),
      rec('g-b', 605, { ...inG }),
    ]);
    render(instantTable(items));
    act(() => bar.onGrouped!(G, ['g-a', 'g-b']));
    expect(pushes).toEqual([]);
    expect(window.location.search).toBe('?page=2&status=archived');
  });

  it('a refresh that never brings the grouping turns nothing later', () => {
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(1_000_000);
    at('page=2');
    const { rerender } = render(instantTable(straddle(false)));
    act(() => bar.onGrouped!(G, ['g-a', 'g-b']));
    // Long after the grouping, an unrelated refresh brings it after all.
    now.mockReturnValue(1_000_000 + 60_000);
    rerender(instantTable(straddle(true)));
    expect(pushes).toEqual([]);
    expect(window.location.search).toBe('?page=2');
  });

  it('offers no "Show it" link: it turns to the page itself', () => {
    render(instantTable(straddle(true)));
    expect(bar.showGroupHref).toBeUndefined();
  });

  it('?group= opens on the page that draws the header, then puts that page in the address', () => {
    at(`group=${G}`);
    const { container } = render(instantTable(straddle(true)));
    expect(pager()).toBe('Page 3 of 4');
    expect(window.location.search).toBe('?page=3');
    expect(pushes).toEqual([]);
    expect(screen.getByRole('button', { name: /collapse group pair/i })).toBeInTheDocument();
    expect(groupHeader(container)).not.toBeNull();
    expect(scrolled).toEqual([`display-group:${G}`]);
  });

  // The server reads a repeated parameter as an array, which is no group; the
  // list in the browser must agree, or it would turn to the first group's page
  // without opening it.
  it('a repeated ?group= keeps the requested page and opens nothing', () => {
    at(`group=${G}&group=${OTHER}&page=2`);
    render(instantTable(straddle(true)));
    expect(pager()).toBe('Page 2 of 4');
    expect(window.location.search).toBe('?page=2');
    expect(screen.queryByRole('button', { name: /collapse group pair/i })).toBeNull();
    expect(scrolled).toEqual([]);
  });
});

// Add to group, from a row's "Same SKU as records in <group>" chip: the dialog
// opens on the record's group, and the person may put it in another group
// there. The list then shows the group the record joined, as after Group
// selected: instant mode turns to the page that draws it; a list paged on the
// server gets the "Show it" link.
describe('Add to group from a row chip: the list shows the group the record joined', () => {
  const G2 = '5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a';
  const inG2 = { display_group_id: G2, display_group_name: 'Pair two', display_group_version: 1 };

  /** "Pair two" high on page 1; "Pair" (g-a, g-b) on page 3 with c, which
   *  shares g-a's SKU and is in no group, so its chip offers Add to group. */
  const records = (cInPairTwo: boolean) =>
    view([
      rec('h-a', 15, inG2),
      rec('h-b', 25, inG2),
      rec('g-a', 705, { ...inG, sku: 'PAD', name: 'Pad a' }),
      rec('g-b', 715, { ...inG, name: 'Pad b' }),
      rec('c', 725, { sku: 'PAD', name: 'Pad c', ...(cInPairTwo ? inG2 : {}) }),
    ]);

  /** The dialog's answer after it saved c into "Pair two". */
  const joinedPairTwo = {
    action: 'group',
    outcome: 'applied',
    replay: false,
    created: false,
    group: { id: G2, name: 'Pair two', version: 2, itemType: 'product', closed: false },
    changes: [{ itemId: 'c', fromGroupId: null, toGroupId: G2 }],
  };

  async function openAddToGroup() {
    await userEvent.click(screen.getByRole('button', { name: 'Add to group Pair: Pad c' }));
    expect(addDialog.props?.itemIds).toEqual(['c']);
    expect(addDialog.props?.initialGroupId).toBe(G);
  }

  it('instant mode: turns to the page that draws the group once the refreshed rows carry it', async () => {
    at('page=3');
    const { container, rerender } = render(instantTable(records(false)));
    expect(pager()).toBe('Page 3 of 4');
    await openAddToGroup();
    // It turns to the page itself: no link.
    expect(addDialog.props?.showGroupHref).toBeUndefined();

    act(() => addDialog.props!.onDone(joinedPairTwo));
    expect(routerMock.refresh).toHaveBeenCalled();
    // The refresh has not landed: nothing turns yet.
    expect(pushes).toEqual([]);

    rerender(instantTable(records(true)));
    expect(pushes).toEqual(['/dashboard/inventory']);
    expect(pager()).toBe('Page 1 of 4');
    expect(screen.getByRole('button', { name: /collapse group pair two/i })).toBeInTheDocument();
    expect(container.querySelector(`[data-group-key="display-group:${G2}"]`)).not.toBeNull();
    expect(scrolled).toEqual([`display-group:${G2}`]);
  });

  /** A server page planned as planLivePage plans it, with its rows. */
  function serverPage(rows: InstantDatasetItem[], page: number, initialQuery = '') {
    const plan = planGroupAwarePage(rows, 'updated_desc', page, 30, 'items');
    const byId = new Map(rows.map((r) => [r.id, r]));
    return (
      <InventoryTable
        items={plan.pageIds.map((id) => byId.get(id)!)}
        lookups={LOOKUPS}
        total={rows.length}
        initialQuery={initialQuery}
        pageSize={30}
        canUngroup
        page={plan.page}
        plannedPage={plan}
      />
    );
  }

  it('a list paged on the server: the dialog gets the "Show it" address for the group joined', async () => {
    at('sort=updated_desc&page=3');
    render(serverPage(records(false), 3));
    await openAddToGroup();
    expect(addDialog.props?.showGroupHref).toBeTypeOf('function');
    expect(addDialog.props!.showGroupHref!(G2)).toBe(
      `/dashboard/inventory?sort=updated_desc&group=${G2}`,
    );
  });

  it('no "Show it" address during a search: the list shows its matches, not pages', async () => {
    // The server search never answers here: the page's own matches are what
    // the list shows.
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>(() => {}));
    at('page=3&q=pad');
    render(serverPage(records(false), 3, 'pad'));
    await openAddToGroup();
    expect(addDialog.props?.showGroupHref).toBeUndefined();
  });

  it('no "Show it" address without a planned page (fixed slices over the instant-mode cap)', async () => {
    at('page=3');
    const plan = planGroupAwarePage(records(false), 'updated_desc', 3, 30, 'items');
    const byId = new Map(records(false).map((r) => [r.id, r]));
    render(
      <InventoryTable
        items={plan.pageIds.map((id) => byId.get(id)!)}
        lookups={LOOKUPS}
        total={95}
        initialQuery=""
        pageSize={30}
        canUngroup
        page={3}
      />,
    );
    await openAddToGroup();
    expect(addDialog.props?.showGroupHref).toBeUndefined();
  });
});

describe('a list paged on the server: the "Show it" link and where it lands', () => {
  /** The server's planned page for this view (planLivePage's rule), and its
   *  records as the page reads them. */
  function serverTable(
    rows: InstantDatasetItem[],
    page: number,
    revealGroupId: string | null = null,
    initialQuery = '',
  ) {
    const plan = planGroupAwarePage(rows, 'updated_desc', page, 30, 'items', revealGroupId);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const items = plan.pageIds.map((id) => byId.get(id)!);
    return (
      <InventoryTable
        items={items}
        lookups={LOOKUPS}
        total={rows.length}
        initialQuery={initialQuery}
        pageSize={30}
        canUngroup
        page={plan.page}
        plannedPage={plan}
      />
    );
  }

  it('hands the done message this view with ?group= in place of ?page=', () => {
    at('sort=updated_desc&page=2');
    render(serverTable(straddle(false), 2));
    expect(bar.showGroupHref).toBeTypeOf('function');
    expect(bar.showGroupHref!(G)).toBe(`/dashboard/inventory?sort=updated_desc&group=${G}`);
  });

  it('no link during a search (the list shows its matches, not pages), nor without a planned page', () => {
    const { unmount } = render(serverTable(straddle(false), 1, null, 'item'));
    expect(bar.showGroupHref).toBeUndefined();
    unmount();
    const rows = straddle(false).slice(0, 30);
    render(
      <InventoryTable
        items={rows}
        lookups={LOOKUPS}
        total={92}
        initialQuery=""
        pageSize={30}
        canUngroup
        page={1}
      />,
    );
    expect(bar.showGroupHref).toBeUndefined();
  });

  it('landing on ?group=: the group is open and scrolled to, and the address says the page', () => {
    at(`sort=updated_desc&group=${G}`);
    const { container } = render(serverTable(straddle(true), 1, G));
    expect(pager()).toBe('Page 3 of 4');
    expect(window.location.search).toBe('?sort=updated_desc&page=3');
    expect(screen.getByRole('button', { name: /collapse group pair/i })).toBeInTheDocument();
    expect(groupHeader(container)).not.toBeNull();
    expect(scrolled).toEqual([`display-group:${G}`]);
    // A page link from here is a plain page link.
    const prev = screen.getAllByRole('link', { name: /prev/i });
    expect(prev.length).toBeGreaterThan(0);
    for (const a of prev) {
      expect(a).toHaveAttribute('href', '/dashboard/inventory?sort=updated_desc&page=2');
    }
  });

  it.each([
    ['a value that is not a group id', 'group=g-a'],
    ['a repeated parameter', `group=${G}&group=${OTHER}`],
  ])('%s is dropped from the address and opens nothing', (_label, search) => {
    at(`${search}&page=3`);
    render(serverTable(straddle(true), 3));
    expect(window.location.search).toBe('?page=3');
    expect(screen.queryByRole('button', { name: /collapse group pair/i })).toBeNull();
    expect(scrolled).toEqual([]);
  });

  it('after a grouping, a header drawn on this page is opened and scrolled to', () => {
    at('page=3');
    const { rerender } = render(serverTable(straddle(false), 3));
    act(() => bar.onGrouped!(G, ['g-a', 'g-b']));
    expect(scrolled).toEqual([]);
    // The refresh lands with the group on this page.
    rerender(serverTable(straddle(true), 3));
    expect(screen.getByRole('button', { name: /collapse group pair/i })).toBeInTheDocument();
    expect(scrolled).toEqual([`display-group:${G}`]);
    expect(pushes).toEqual([]);
  });
});
