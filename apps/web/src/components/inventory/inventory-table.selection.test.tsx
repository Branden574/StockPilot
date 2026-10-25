import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Selection on the Items / Books table (the owner's release-blocking item),
// the redesign's fixes to it (P3.2): CONFLICTS D9 (the page select-all during
// a server-mode search), D8 (the boxes' accessible names) and D18 (the saved
// view's owner controls hidden from touch and keyboard), and the jump-to-page
// grid's touch targets (P2.2 hand-off).

const { routerMock, urlState } = vi.hoisted(() => ({
  routerMock: { replace: vi.fn(), push: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() },
  urlState: { params: new URLSearchParams('') },
}));
vi.mock('next/navigation', () => ({
  useRouter: () => routerMock,
  useSearchParams: () => urlState.params,
  usePathname: () => '/dashboard/inventory',
}));
vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    ...rest
  }: { href: string; children: React.ReactNode } & Record<string, unknown>) => {
    const { prefetch: _p, scroll: _s, replace: _r, ...anchor } = rest;
    return (
      <a
        href={typeof href === 'string' ? href : '#'}
        {...(anchor as React.AnchorHTMLAttributes<HTMLAnchorElement>)}
      >
        {children}
      </a>
    );
  },
}));
vi.mock('next/image', () => ({
  // eslint-disable-next-line @next/next/no-img-element
  default: (props: { src: string; alt?: string }) => <img src={props.src} alt={props.alt ?? ''} />,
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
const { spy } = vi.hoisted(() => ({ spy: { selectedIds: [] as string[] } }));
vi.mock('@/components/inventory/bulk-actions', () => ({
  BulkActions: (props: { selectedIds: string[] }) => {
    spy.selectedIds = props.selectedIds;
    return <div data-testid="bulk-actions" />;
  },
}));

import { InventoryTable, Pagination } from './inventory-table';

const LOOKUPS = {
  categories: new Map<string, { name: string; color: string | null }>(),
  locations: new Map<string, { name: string }>(),
  charters: new Map<string, { name: string; code: string | null }>(),
};

function row(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    name: `Item ${id}`,
    sku: `SKU-${id}`,
    status: 'active' as const,
    quantity_on_hand: 4,
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

const headerBox = () => screen.getByRole('checkbox', { name: 'Select all rows on this page' });

beforeEach(() => {
  vi.clearAllMocks();
  urlState.params = new URLSearchParams('');
  spy.selectedIds = [];
  window.history.replaceState(null, '', '/dashboard/inventory');
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('CONFLICTS D9: the page select-all during a server-mode search', () => {
  // Server mode (staff, viewers, orgs over the instant cap): a search shows
  // /api/items/search's hits, which can come from other pages. The box used
  // to read the server PAGE's own rows (`items`), so it ticked rows that were
  // not on screen and judged its state by them.
  it('ticks exactly the hits on screen, not the server page that is hidden behind them', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ items: [row('hit-1'), row('hit-2')], total: 2 }),
      })),
    );
    render(
      <InventoryTable
        items={[row('page-a'), row('page-b')] as never}
        lookups={LOOKUPS}
        total={90}
        initialQuery=""
        pageSize={30}
      />,
    );
    await user.type(screen.getByRole('textbox', { name: 'Search items' }), 'hit');
    expect(await screen.findByRole('link', { name: 'Item hit-1' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Item page-a' })).toBeNull();

    await user.click(headerBox());
    expect([...spy.selectedIds].sort()).toEqual(['hit-1', 'hit-2']);
    expect(headerBox()).toHaveAttribute('aria-checked', 'true');
    for (const hit of ['hit-1', 'hit-2']) {
      expect(screen.getByRole('checkbox', { name: `Select Item ${hit}` })).toHaveAttribute(
        'aria-checked',
        'true',
      );
    }
    // And it clears exactly them.
    await user.click(headerBox());
    expect(spy.selectedIds).toEqual([]);
  });

  it('without a search, the server page is what is on screen: unchanged', async () => {
    const user = userEvent.setup();
    render(
      <InventoryTable
        items={[row('page-a'), row('page-b')] as never}
        lookups={LOOKUPS}
        total={90}
        initialQuery=""
        pageSize={30}
      />,
    );
    await user.click(headerBox());
    expect([...spy.selectedIds].sort()).toEqual(['page-a', 'page-b']);
  });
});

describe('CONFLICTS D8: every box has a name', () => {
  it('rows say "Select {name}", the header "Select all rows on this page", the bar "Unselect all"', async () => {
    const user = userEvent.setup();
    render(
      <InventoryTable
        items={[row('a', { name: 'Blue T-shirt' })] as never}
        lookups={LOOKUPS}
        total={1}
        initialQuery=""
        pageSize={30}
      />,
    );
    const box = screen.getByRole('checkbox', { name: 'Select Blue T-shirt' });
    expect(headerBox()).toHaveAttribute('aria-checked', 'false');
    await user.click(box);
    expect(box).toHaveAttribute('aria-checked', 'true');
    // One click, one toggle (the shared Checkbox stops its click at the box).
    expect(spy.selectedIds).toEqual(['a']);
    expect(headerBox()).toHaveAttribute('aria-checked', 'true');
  });

  it('a group header row has no box (headers are not selectable)', () => {
    const { container } = render(
      <InventoryTable
        items={[row('a', { sku: 'PAIR' }), row('b', { sku: 'PAIR' })] as never}
        lookups={LOOKUPS}
        total={2}
        initialQuery=""
        pageSize={30}
      />,
    );
    const header = container.querySelector('tr[data-row-kind="header"]')!;
    expect(header.querySelectorAll('[role="checkbox"]')).toHaveLength(0);
    // CHANGED (owner decision 2026-10-19: SKU stacked under the item name): 12 → 11.
    expect(header.children).toHaveLength(11);
  });
});

describe('CONFLICTS D18: a saved view’s owner controls reach touch and keyboard', () => {
  it('share and delete stay hidden only for a mouse that is not over the chip', () => {
    render(
      <InventoryTable
        items={[row('a')] as never}
        lookups={LOOKUPS}
        total={1}
        initialQuery=""
        pageSize={30}
        savedViews={[{ id: 'v1', name: 'Restock', state: {}, ownerId: 'u-1', isShared: false }]}
        savedViewScope="inventory"
        currentUserId="u-1"
      />,
    );
    for (const name of ['Share view Restock with team', 'Delete view Restock']) {
      const control = screen.getByRole('button', { name });
      const classes = (control.getAttribute('class') ?? '').split(/\s+/);
      // Hidden by default for a fine pointer…
      expect(classes).toContain('opacity-0');
      // …but shown on hover, on keyboard focus inside the chip, on a touch
      // screen and below sm. Focus inside the chip is the descendant selector
      // `.group\/view:focus-within &`: the class keeps one backslash, and its
      // group is the chip.
      expect(classes).toEqual(
        expect.arrayContaining([
          'group-hover/view:opacity-100',
          String.raw`[.group\/view:focus-within_&]:opacity-100`,
          'focus-visible:opacity-100',
          'pointer-coarse:opacity-100',
          'max-sm:opacity-100',
        ]),
      );
      expect(control.closest(String.raw`.group\/view`)).toContainElement(
        screen.getByRole('button', { name: 'Apply view Restock' }),
      );
    }
    // A teammate's chip offers neither (owner-only, unchanged).
  });

  it("a teammate's shared view offers no owner controls", () => {
    render(
      <InventoryTable
        items={[row('a')] as never}
        lookups={LOOKUPS}
        total={1}
        initialQuery=""
        pageSize={30}
        savedViews={[{ id: 'v1', name: 'Restock', state: {}, ownerId: 'u-2', isShared: true }]}
        savedViewScope="inventory"
        currentUserId="u-1"
      />,
    );
    expect(screen.getByRole('button', { name: 'Apply view Restock' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Delete view/ })).toBeNull();
  });
});

// B23: a shared view whose owner deleted their account. Once the database
// keeps it for the team (the design in the PR), it has no owner: the chip
// says so instead of "a teammate", and only the people the server says may
// delete it (an admin or owner) get Delete. Nobody gets the owner's share
// toggle, as nobody owns it.
describe('B23: a shared view whose owner deleted their account', () => {
  function renderWith(view: Record<string, unknown>) {
    return render(
      <InventoryTable
        items={[row('a')] as never}
        lookups={LOOKUPS}
        total={1}
        initialQuery=""
        pageSize={30}
        savedViews={[{ id: 'v1', name: 'Restock', state: {}, ...view }] as never}
        savedViewScope="inventory"
        currentUserId="u-1"
      />,
    );
  }

  it('says who shared it: a deleted user, not a teammate', () => {
    const { container } = renderWith({ ownerId: null, isShared: true, canRemove: false });
    const chip = container.querySelector('span[title^="Shared by"]');
    expect(chip?.getAttribute('title')).toBe('Shared by a deleted user');
  });

  it('an admin the server lets remove it gets Delete, and no share toggle', () => {
    renderWith({ ownerId: null, isShared: true, canRemove: true });
    expect(screen.getByRole('button', { name: 'Apply view Restock' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete view Restock' })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Make view Restock private|Share view Restock/ }),
    ).toBeNull();
  });

  it('a member gets only Apply', () => {
    renderWith({ ownerId: null, isShared: true, canRemove: false });
    expect(screen.getByRole('button', { name: 'Apply view Restock' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Delete view/ })).toBeNull();
    expect(
      screen.queryByRole('button', { name: /Make view Restock private|Share view Restock/ }),
    ).toBeNull();
  });

  it("a teammate's view still reads Shared by a teammate, and the owner's Shared by you", () => {
    const teammate = renderWith({ ownerId: 'u-2', isShared: true, canRemove: false });
    expect(
      teammate.container.querySelector('span[title^="Shared by"]')?.getAttribute('title'),
    ).toBe('Shared by a teammate');
    teammate.unmount();
    const own = renderWith({ ownerId: 'u-1', isShared: true, canRemove: true });
    expect(own.container.querySelector('span[title^="Shared by"]')?.getAttribute('title')).toBe(
      'Shared by you',
    );
    expect(screen.getByRole('button', { name: 'Make view Restock private' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete view Restock' })).toBeInTheDocument();
  });
});

describe('the jump-to-page grid on a touch screen (P2.2 hand-off)', () => {
  // At 28 px with 4 px gaps, each page button's 44 px touch area reached over
  // the row above, so a tap on the bottom of page 1 opened page 6.
  it('page buttons are full 44 px targets below sm and on coarse pointers; five columns on a coarse pointer', async () => {
    const user = userEvent.setup();
    render(
      <Pagination
        page={1}
        pageSize={30}
        total={600}
        buildHref={(p) => `/dashboard/inventory?page=${p}`}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Jump to page' }));
    const grid = await screen.findByRole('dialog');
    const one = within(grid).getByRole('link', { name: '1' });
    const classes = (el: Element) => (el.getAttribute('class') ?? '').split(/\s+/);
    expect(classes(one)).toEqual(
      expect.arrayContaining(['h-7', 'max-sm:h-11', 'pointer-coarse:h-11']),
    );
    expect(classes(one.parentElement!)).toEqual(
      expect.arrayContaining(['grid-cols-5', 'sm:grid-cols-8', 'pointer-coarse:grid-cols-5']),
    );
    // Hrefs, the current page and the no-prefetch rule are unchanged.
    expect(one).toHaveAttribute('aria-current', 'page');
    expect(one).toHaveAttribute('href', '/dashboard/inventory?page=1');
  });
});

describe('pending filter navigations never block clicks', () => {
  it('the list dims while a navigation is pending but never sets pointer-events: none', () => {
    const { container } = render(
      <InventoryTable
        items={[row('a')] as never}
        lookups={LOOKUPS}
        total={1}
        initialQuery=""
        pageSize={30}
      />,
    );
    const list = container.querySelector('[aria-busy]')!;
    expect(list.getAttribute('class') ?? '').not.toContain('pointer-events-none');
  });
});
