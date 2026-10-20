import { fireEvent, render, screen, within } from '@testing-library/react';
import { ITEMS_PAGE_TOUR } from '@/lib/onboarding/tours';
import userEvent from '@testing-library/user-event';
import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The Items / Books / Rentals items photo Grid (redesign P3.2). The Grid is a
// SECOND LOOK at the same page the table draws: the same rows, the same row
// keys and selection Set, the same totals and page membership. These tests
// drive the real InventoryTable through both views and compare.

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
  default: (props: { src: string; alt?: string; priority?: boolean; unoptimized?: boolean }) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={props.src}
      alt={props.alt ?? ''}
      data-priority={props.priority ? 'true' : 'false'}
      data-unoptimized={props.unoptimized ? 'true' : 'false'}
    />
  ),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), message: vi.fn() } }));
vi.mock('@/server/actions/saved-views', () => ({
  createSavedViewAction: vi.fn(),
  deleteSavedViewAction: vi.fn(),
  setActiveWarehouseAction: vi.fn(),
  toggleSavedViewShareAction: vi.fn(),
}));
vi.mock('@/lib/download-export', () => ({ downloadInventoryExport: vi.fn() }));
const { previews } = vi.hoisted(() => ({
  previews: [] as Array<{ title?: string; src: string | null; srcLoader?: unknown }>,
}));
vi.mock('@/components/ui/image-hover-preview', () => ({
  ImageHoverPreview: ({
    children,
    title,
    src,
    srcLoader,
  }: {
    children: React.ReactNode;
    title?: string;
    src: string | null;
    srcLoader?: unknown;
  }) => {
    previews.push({ title, src, srcLoader });
    return <span data-testid="hover-preview">{children}</span>;
  },
  prewarmPreviewImages: vi.fn(),
}));
vi.mock('@/lib/cycle-counts/use-count-selection', () => ({
  useCountSelection: (selector: (s: { add: () => void }) => unknown) => selector({ add: vi.fn() }),
}));
vi.mock('@/components/inventory/display-group-dialogs', () => ({
  GroupSelectedDialog: () => <div data-testid="group-dialog" />,
  RemoveFromGroupDialog: (p: { itemIds: readonly string[] }) => (
    <div data-testid="remove-dialog">remove {p.itemIds.join(',')}</div>
  ),
  RenameGroupDialog: (p: { groupId: string }) => (
    <div data-testid="rename-dialog">rename {p.groupId}</div>
  ),
}));

const { spy } = vi.hoisted(() => ({ spy: { selectedIds: [] as string[] } }));
vi.mock('@/components/inventory/bulk-actions', () => ({
  BulkActions: (props: { selectedIds: string[] }) => {
    spy.selectedIds = props.selectedIds;
    return <div data-testid="bulk-actions" data-count={props.selectedIds.length} />;
  },
}));

import { ELSEWHERE_PLACEMENT_KIND, ELSEWHERE_PLACEMENT_LABEL } from '@/lib/placements';

import {
  INVENTORY_VIEW_COOKIES,
  inventoryViewCookieFor,
  inventoryViewCookieString,
  parseInventoryView,
} from './inventory-grid';
import { InventoryTable } from './inventory-table';

const LOOKUPS = {
  categories: new Map<string, { name: string; color: string | null }>([
    ['cat-swag', { name: 'Swag', color: null }],
    ['cat-apparel', { name: 'Apparel', color: null }],
  ]),
  locations: new Map<string, { name: string }>([
    ['loc-north', { name: 'North DC' }],
    ['loc-south', { name: 'South DC' }],
  ]),
  charters: new Map<string, { name: string; code: string | null }>([
    ['ch-1', { name: 'Learn4Life Academy', code: 'L4LA' }],
  ]),
};

function row(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    name: `Item ${id}`,
    sku: `SKU-${id}`,
    status: 'active' as const,
    quantity_on_hand: 10,
    reorder_point: 0,
    unit_cost: 2,
    retail_price: 5,
    category_id: 'cat-swag',
    charter_id: null,
    primary_location_id: 'loc-north',
    barcode: null,
    model_number: null,
    custom_fields: null,
    item_type: 'product',
    display_group_id: null,
    display_group_name: null,
    display_group_version: null,
    created_at: '2026-01-01T00:00:00+00:00',
    updated_at: '2026-01-02T00:00:00+00:00',
    ...over,
  };
}

const inGroup = (g: string, name: string) => ({
  display_group_id: g,
  display_group_name: name,
  display_group_version: 1,
});

/** A page with every kind of entry: plain records, a SKU family on two
 *  racks (one record split across them is ONE record), a size run and a
 *  named group. */
function mixedPage() {
  return [
    row('plain-1', { name: 'Laptop Backpack', image_thumb_url: 'https://img.test/bp-thumb.webp' }),
    row('plain-2', { name: 'Mousepad' }),
    // One record on two racks: the Items page splits it into two rows.
    { ...row('split', { name: 'Chromebook', sku: 'CB-1' }), rowKey: 'split:L1', line_quantity: 4 },
    { ...row('split', { name: 'Chromebook', sku: 'CB-1' }), rowKey: 'split:L2', line_quantity: 6 },
    // A name-derived size run.
    row('tee-s', { name: 'Tee - S', sku: 'TEE-S', category_id: 'cat-apparel' }),
    row('tee-m', { name: 'Tee - M', sku: 'TEE-M', category_id: 'cat-apparel' }),
    row('tee-l', { name: 'Tee - L', sku: 'TEE-L', category_id: 'cat-apparel' }),
    // A named group of two records.
    row('g1', { name: 'Desk Lamp', sku: 'LAMP-1', ...inGroup('grp-desk', 'Desk Set') }),
    row('g2', { name: 'Desk Tray', sku: 'TRAY-1', ...inGroup('grp-desk', 'Desk Set') }),
  ];
}

type Props = React.ComponentProps<typeof InventoryTable>;

function renderTable(over: Partial<Props> = {}) {
  const items = (over.items as unknown[]) ?? mixedPage();
  return render(
    <InventoryTable
      items={items as never}
      lookups={LOOKUPS}
      total={new Set((items as Array<{ id: string }>).map((i) => i.id)).size}
      initialQuery=""
      pageSize={30}
      canUngroup
      {...over}
    />,
  );
}

/** The keys the TABLE shows, top to bottom (record rows by row key, headers by group key). */
function tableKeys(container: HTMLElement): string[] {
  return [...container.querySelectorAll('tbody tr')]
    .map((tr) => tr.getAttribute('data-row-key') ?? tr.getAttribute('data-group-key'))
    .filter((k): k is string => k !== null);
}

/** The keys the GRID shows, in reading order (cards and drill-down cards). */
function gridKeys(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[data-slot="grid-card"]')].map(
    (c) => c.getAttribute('data-row-key') ?? c.getAttribute('data-group-key') ?? '?',
  );
}

const footerText = () =>
  [...document.querySelectorAll('p')]
    .map((p) => (p.textContent ?? '').replace(/\s+/g, ' ').trim())
    .find((t) => t.endsWith('on hand'));

const gridTab = () => screen.getByRole('tab', { name: 'Grid' });
const tableTab = () => screen.getByRole('tab', { name: 'Table' });
const pageSelectAll = () => screen.getByRole('checkbox', { name: 'Select all rows on this page' });

beforeEach(() => {
  vi.clearAllMocks();
  urlState.params = new URLSearchParams('');
  spy.selectedIds = [];
  previews.length = 0;
  document.cookie = `${INVENTORY_VIEW_COOKIES.items}=; path=/; max-age=0`;
  document.cookie = `${INVENTORY_VIEW_COOKIES.books}=; path=/; max-age=0`;
  window.history.replaceState(null, '', '/dashboard/inventory');
});

describe('the Table / Grid preference', () => {
  it('reads Grid only for exactly "grid"; anything else is Table', () => {
    expect(parseInventoryView('grid')).toBe('grid');
    for (const v of [undefined, null, '', 'table', 'GRID', 'cards']) {
      expect(parseInventoryView(v)).toBe('table');
    }
  });

  it('one cookie per list, a year long, the shell preference shape', () => {
    expect(inventoryViewCookieFor('/dashboard/inventory')).toBe('sp_view_items');
    expect(inventoryViewCookieFor('/dashboard/books')).toBe('sp_view_books');
    expect(inventoryViewCookieFor('/dashboard/rentals/items')).toBe('sp_view_rental_items');
    expect(inventoryViewCookieString('sp_view_items', 'grid')).toBe(
      'sp_view_items=grid; path=/; max-age=31536000; samesite=lax',
    );
    expect(inventoryViewCookieString('sp_view_books', 'table')).toBe(
      'sp_view_books=table; path=/; max-age=31536000; samesite=lax',
    );
  });

  it('Table is the default; the server-read choice is the first render (no swap)', () => {
    const { container, unmount } = renderTable();
    expect(container.querySelector('table')).not.toBeNull();
    expect(container.querySelector('[data-slot="inventory-grid"]')).toBeNull();
    expect(tableTab()).toHaveAttribute('aria-selected', 'true');
    unmount();
    const grid = renderTable({ initialView: 'grid' });
    expect(grid.container.querySelector('table')).toBeNull();
    expect(grid.container.querySelector('[data-slot="inventory-grid"]')).not.toBeNull();
    expect(gridTab()).toHaveAttribute('aria-selected', 'true');
  });

  it("switching writes this list's cookie (Items and Books each keep their own)", async () => {
    const user = userEvent.setup();
    const { unmount } = renderTable();
    await user.click(gridTab());
    expect(document.cookie).toContain('sp_view_items=grid');
    await user.click(tableTab());
    expect(document.cookie).toContain('sp_view_items=table');
    unmount();
    renderTable({
      items: [row('b1', { item_type: 'book' })] as never,
      showBookFields: true,
      basePath: '/dashboard/books',
      rowLinkPrefix: '/dashboard/books',
    });
    await user.click(gridTab());
    expect(document.cookie).toContain('sp_view_books=grid');
  });
});

describe('the Grid draws the SAME page as the Table', () => {
  it('same entries, same keys, same order; the footer totals do not change', async () => {
    const user = userEvent.setup();
    const { container } = renderTable();
    const keysInTable = tableKeys(container);
    const footerInTable = footerText();
    expect(keysInTable).toEqual([
      'plain-1',
      'plain-2',
      'sku-group:CB-1',
      'style-group:tee',
      'display-group:grp-desk',
    ]);

    await user.click(gridTab());
    expect(container.querySelector('table')).toBeNull();
    expect(gridKeys(container)).toEqual(keysInTable);
    expect(footerText()).toBe(footerInTable);

    await user.click(tableTab());
    expect(tableKeys(container)).toEqual(keysInTable);
  });

  it('page membership is unchanged by the toggle: the same pager, the same range', async () => {
    const user = userEvent.setup();
    renderTable({ total: 75, page: 2 });
    const showing = () =>
      [...document.querySelectorAll('span')]
        .map((s) => (s.textContent ?? '').trim())
        .filter((t) => /^Showing \d+–\d+ of \d+$/.test(t));
    const before = showing();
    const pager = screen
      .getAllByRole('button', { name: /jump to page/i })
      .map((b) => b.textContent);
    expect(before.length).toBe(2);
    await user.click(gridTab());
    expect(showing()).toEqual(before);
    expect(
      screen.getAllByRole('button', { name: /jump to page/i }).map((b) => b.textContent),
    ).toEqual(pager);
  });

  it('a drilled-down group opens its records INLINE: the same rows the expanded table shows', async () => {
    const user = userEvent.setup();
    const { container } = renderTable();
    await user.click(screen.getByRole('button', { name: 'Expand Tee (3 sizes)' }));
    await user.click(screen.getByRole('button', { name: 'Expand CB-1 (2 placements)' }));
    const expandedTable = tableKeys(container);
    expect(expandedTable).toEqual(
      expect.arrayContaining(['split:L1', 'split:L2', 'tee-s', 'tee-m', 'tee-l']),
    );

    // The expansion survives the toggle: the grid opens the same groups.
    await user.click(gridTab());
    expect(gridKeys(container)).toEqual(expandedTable);
    const teeToggle = screen.getByRole('button', { name: 'Collapse Tee (3 sizes)' });
    expect(teeToggle).toHaveAttribute('aria-expanded', 'true');
    const panel = document.getElementById(teeToggle.getAttribute('aria-controls')!)!;
    expect(panel).toHaveAttribute('role', 'group');
    expect(
      [...panel.querySelectorAll('[data-slot="grid-card"]')].map((c) =>
        c.getAttribute('data-row-key'),
      ),
    ).toEqual(['tee-s', 'tee-m', 'tee-l']);

    // Collapsing in the grid closes it in the table too (one state).
    await user.click(teeToggle);
    expect(screen.getByRole('button', { name: 'Expand Tee (3 sizes)' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(gridKeys(container)).not.toContain('tee-s');
  });
});

describe('Grid selection: the same Set, the same row keys', () => {
  it("a card's checkbox is its row's checkbox: same name, same row key, and the tick shows in both views", async () => {
    const user = userEvent.setup();
    const { container } = renderTable({ initialView: 'grid' });
    const box = screen.getByRole('checkbox', { name: 'Select Mousepad' });
    expect(box.closest('[data-row-key]')).toHaveAttribute('data-row-key', 'plain-2');
    // Outside the name link: the box never navigates.
    expect(box.closest('a')).toBeNull();
    await user.click(box);
    expect(box).toHaveAttribute('aria-checked', 'true');
    expect(spy.selectedIds).toEqual(['plain-2']);
    expect(container.querySelector('[data-row-key="plain-2"]')).toHaveAttribute('data-selected');

    await user.click(tableTab());
    expect(screen.getByRole('checkbox', { name: 'Select Mousepad' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(spy.selectedIds).toEqual(['plain-2']);
  });

  it('a split record keeps one key per rack row in the grid, and the bar counts it once', async () => {
    const user = userEvent.setup();
    renderTable({ initialView: 'grid' });
    await user.click(screen.getByRole('button', { name: 'Expand CB-1 (2 placements)' }));
    const [rack1, rack2] = screen.getAllByRole('checkbox', { name: 'Select Chromebook' });
    expect(rack1!.closest('[data-row-key]')).toHaveAttribute('data-row-key', 'split:L1');
    expect(rack2!.closest('[data-row-key]')).toHaveAttribute('data-row-key', 'split:L2');
    await user.click(rack1!);
    expect(rack1).toHaveAttribute('aria-checked', 'true');
    expect(rack2).toHaveAttribute('aria-checked', 'false');
    await user.click(rack2!);
    expect(spy.selectedIds).toEqual(['split']);
  });

  it('the page select-all above the grid: its name, mixed state, and every record of the page incl. collapsed group cards', async () => {
    const user = userEvent.setup();
    renderTable({ initialView: 'grid' });
    expect(pageSelectAll()).toHaveAttribute('aria-checked', 'false');
    await user.click(screen.getByRole('checkbox', { name: 'Select Laptop Backpack' }));
    expect(pageSelectAll()).toHaveAttribute('aria-checked', 'mixed');
    await user.click(pageSelectAll());
    expect(pageSelectAll()).toHaveAttribute('aria-checked', 'true');
    // Every record on the page, members of the collapsed group cards too.
    expect([...spy.selectedIds].sort()).toEqual(
      ['g1', 'g2', 'plain-1', 'plain-2', 'split', 'tee-l', 'tee-m', 'tee-s'].sort(),
    );
    // Collapsing nothing changed it; drilling down shows them ticked.
    await user.click(screen.getByRole('button', { name: 'Expand group Desk Set (2 records)' }));
    expect(screen.getByRole('checkbox', { name: 'Select Desk Lamp' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    // The Table's header box agrees.
    await user.click(tableTab());
    expect(pageSelectAll()).toHaveAttribute('aria-checked', 'true');
    await user.click(pageSelectAll());
    expect(spy.selectedIds).toEqual([]);
  });

  it('selection on another page survives the page select-all (page-scoped)', async () => {
    const user = userEvent.setup();
    const { rerender } = renderTable({ initialView: 'grid', total: 60 });
    await user.click(screen.getByRole('checkbox', { name: 'Select Mousepad' }));
    rerender(
      <InventoryTable
        items={[row('p2-a', { name: 'Page Two A' }), row('p2-b', { name: 'Page Two B' })] as never}
        lookups={LOOKUPS}
        total={60}
        page={2}
        initialQuery=""
        pageSize={30}
        canUngroup
        initialView="grid"
      />,
    );
    await user.click(pageSelectAll());
    expect([...spy.selectedIds].sort()).toEqual(['p2-a', 'p2-b', 'plain-2']);
    await user.click(pageSelectAll());
    expect(spy.selectedIds).toEqual(['plain-2']);
  });

  it('group cards are not selectable: no checkbox on a header card', () => {
    const { container } = renderTable({ initialView: 'grid' });
    for (const key of ['sku-group:CB-1', 'style-group:tee', 'display-group:grp-desk']) {
      const card = container.querySelector(`[data-group-key="${key}"]`)!;
      expect(card.querySelectorAll('[role="checkbox"]')).toHaveLength(0);
    }
  });

  it('the card body is inert: only the checkbox toggles and only the name navigates', () => {
    const { container } = renderTable({ initialView: 'grid' });
    const card = container.querySelector('[data-row-key="plain-2"]')! as HTMLElement;
    // A click on the media, the figures, the meta line: nothing happens.
    fireEvent.click(card);
    fireEvent.click(card.querySelector('[data-slot="grid-card-media"]')!);
    fireEvent.click(card.querySelector('[data-slot="grid-card-quantity"]')!);
    expect(spy.selectedIds).toEqual([]);
    expect(routerMock.push).not.toHaveBeenCalled();
    // One link on the card, and it is the name (no stretched link over the body).
    const links = within(card).getAllByRole('link');
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveTextContent('Mousepad');
    expect(links[0]!.getAttribute('href')).toMatch(/^\/dashboard\/inventory\/plain-2\?return=/);
    expect(card.querySelector('[data-slot="grid-card-name"]')!.className).not.toContain('after:');
  });

  it('the Table / Grid control stays usable while rows are ticked (it is not in the swapped toolbar)', async () => {
    const user = userEvent.setup();
    renderTable();
    await user.click(screen.getByRole('checkbox', { name: 'Select Mousepad' }));
    expect(gridTab().closest('.invisible')).toBeNull();
    await user.click(gridTab());
    expect(screen.getByRole('checkbox', { name: 'Select Mousepad' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });
});

describe('Grid card content: what the row shows, nothing else', () => {
  it('Items: photo (the thumb, never a master), name link with its full name as title, SKU, category and charter, on hand with its sub-line, location and the Rack line', () => {
    const { container } = renderTable({
      initialView: 'grid',
      items: [
        row('bp', {
          name: 'L4L Laptop Backpack — Heather Gray, a name long enough to need two lines',
          sku: 'SP-BK7Q2-GRY',
          image_url: null,
          image_thumb_url: 'https://img.test/bp-thumb.webp',
          quantity_on_hand: 142,
          placed_quantity: 120,
          staged_quantity: 22,
          placed_racks: ['18-B'],
          charter_id: 'ch-1',
        }),
      ] as never,
    });
    const card = container.querySelector('[data-row-key="bp"]')! as HTMLElement;
    const img = card.querySelector('img')!;
    expect(img).toHaveAttribute('src', 'https://img.test/bp-thumb.webp');
    expect(img).toHaveAttribute('data-unoptimized', 'true');
    // The master loads on hover only, on demand for a thumb-only row.
    expect(previews.find((p) => p.title?.startsWith('L4L Laptop'))?.srcLoader).toBeTypeOf(
      'function',
    );
    const link = within(card).getByRole('link');
    expect(link).toHaveAttribute('title', link.textContent);
    expect(within(card).getByText('SP-BK7Q2-GRY')).toBeInTheDocument();
    expect(within(card).getByText('Swag')).toBeInTheDocument();
    expect(within(card).getByTitle('Learn4Life Academy')).toHaveTextContent('L4LA');
    expect(card.querySelector('[data-slot="grid-card-quantity"]')).toHaveTextContent('142on hand');
    expect(within(card).getByText('120 placed ·', { exact: false })).toBeInTheDocument();
    expect(within(card).getByText('22 awaiting put-away')).toHaveClass('text-warning');
    expect(within(card).getByText('North DC')).toBeInTheDocument();
    expect(within(card).getByText('Rack')).toBeInTheDocument();
    expect(within(card).getByText('18-B')).toBeInTheDocument();
    expect(within(card).getByText('In stock')).toBeInTheDocument();
  });

  it('Items: "Generic" with its explanation; a site holding as amber "No rack"; staging in amber; "+N in other warehouses"; first two racks then "+N" with the full list', () => {
    const { container } = renderTable({
      initialView: 'grid',
      items: [
        {
          ...row('site'),
          rowKey: 'site:S',
          line_quantity: 3,
          placement_label: 'DC4',
          placement_kind: 'site',
        },
        {
          ...row('stg'),
          rowKey: 'stg:G',
          line_quantity: 2,
          placement_label: 'Staging',
          placement_kind: 'staging',
        },
        row('many', { placed_racks: ['1-A', '2-B', '3-C', '4-D'], elsewhere_quantity: 12 }),
      ] as never,
    });
    const site = container.querySelector('[data-row-key="site:S"]')! as HTMLElement;
    expect(within(site).getByText('No rack')).toHaveClass('text-warning');
    expect(within(site).getByText('No rack')).toHaveAttribute(
      'title',
      'At DC4 (the site), not on a rack. Use Set rack to put it away.',
    );
    expect(within(site).getByTitle(/Generic stock/)).toHaveTextContent('Generic');
    const stg = container.querySelector('[data-row-key="stg:G"]')! as HTMLElement;
    expect(within(stg).getByText('Staging')).toHaveClass('text-warning');
    expect(within(stg).getByText('awaiting put-away')).toBeInTheDocument();
    const many = container.querySelector('[data-row-key="many"]')! as HTMLElement;
    const shown = within(many).getByTitle('1-A, 2-B, 3-C, 4-D');
    expect(shown).toHaveTextContent('1-A, 2-B +2');
    // The full list is the accessible text too, not only the title.
    expect(within(shown).getByText('1-A, 2-B, 3-C, 4-D')).toHaveClass('sr-only');
    expect(within(many).getByText('+12 in other warehouses')).toBeInTheDocument();
  });

  it('Items: the staff "In other warehouses" row is a card that names no place to act on', () => {
    const { container } = renderTable({
      initialView: 'grid',
      items: [
        {
          ...row('qa', { name: 'QA Chrome', elsewhere_quantity: 12 }),
          rowKey: `qa:${ELSEWHERE_PLACEMENT_KIND}`,
          line_quantity: 12,
          placement_label: ELSEWHERE_PLACEMENT_LABEL,
          placement_kind: ELSEWHERE_PLACEMENT_KIND,
        },
      ] as never,
    });
    const card = container.querySelector(`[data-row-key="qa:${ELSEWHERE_PLACEMENT_KIND}"]`)!;
    expect(within(card as HTMLElement).getByText(ELSEWHERE_PLACEMENT_LABEL)).toHaveClass(
      'text-muted-foreground',
    );
    expect(within(card as HTMLElement).queryByText('awaiting put-away')).toBeNull();
  });

  it('Books: Grade, the book rack with "+N in other warehouses", the crate dot (its colour as the title) and number; never an ISBN', () => {
    const { container } = renderTable({
      initialView: 'grid',
      showBookFields: true,
      basePath: '/dashboard/books',
      rowLinkPrefix: '/dashboard/books',
      items: [
        row('dune', {
          name: 'Dune',
          sku: 'BK-DUNE',
          item_type: 'book',
          barcode: '9780441013593',
          custom_fields: {
            book_grade: '9',
            book_rack_number: '39',
            book_rack_row: 'B',
            book_crate_number: '12',
            book_crate_color: 'red',
          },
          placed_holdings: [],
          elsewhere_quantity: 5,
        }),
      ] as never,
    });
    const card = container.querySelector('[data-row-key="dune"]')! as HTMLElement;
    expect(within(card).getByText('Gr 9')).toBeInTheDocument();
    expect(within(card).getByText('39-B')).toBeInTheDocument();
    expect(within(card).getByText('+5 in other warehouses')).toBeInTheDocument();
    expect(within(card).getByText('Crate')).toBeInTheDocument();
    expect(within(card).getByText('12')).toBeInTheDocument();
    expect(card.querySelector('[title="Red"]')).not.toBeNull();
    expect(card.textContent).not.toContain('9780441013593');
    expect(within(card).getByRole('link').getAttribute('href')).toMatch(
      /^\/dashboard\/books\/dune/,
    );
  });

  it('Rentals items: "{avail} avail · {out} out" and the status from available', () => {
    const { container } = renderTable({
      initialView: 'grid',
      basePath: '/dashboard/rentals/items',
      rowLinkPrefix: '/dashboard/rentals/items',
      reservedByItem: new Map([['cam', 1]]),
      items: [row('cam', { name: 'Camera', quantity_on_hand: 1 })] as never,
    });
    const card = container.querySelector('[data-row-key="cam"]')! as HTMLElement;
    expect(within(card).getByText('0 avail · 1 out', { exact: false })).toBeInTheDocument();
    expect(within(card).getByText('Out of stock')).toBeInTheDocument();
  });

  it('a size-run member says its size where others say their category', async () => {
    const user = userEvent.setup();
    const { container } = renderTable({ initialView: 'grid' });
    await user.click(screen.getByRole('button', { name: 'Expand Tee (3 sizes)' }));
    const m = container.querySelector('[data-row-key="tee-m"]')! as HTMLElement;
    expect(within(m).getByText('M')).toBeInTheDocument();
    expect(within(m).queryByText('Apparel')).toBeNull();
  });

  it('the first 12 cards load their photo with priority, as the first 12 rows do', () => {
    const items = Array.from({ length: 14 }, (_, i) =>
      row(`p${String(i).padStart(2, '0')}`, {
        name: `Photo ${i}`,
        sku: `PH-${i}`,
        image_thumb_url: `https://img.test/${i}.webp`,
      }),
    );
    const { container } = renderTable({ initialView: 'grid', items: items as never });
    const flags = [...container.querySelectorAll('[data-slot="grid-card"] img')].map((i) =>
      i.getAttribute('data-priority'),
    );
    expect(flags.slice(0, 12).every((f) => f === 'true')).toBe(true);
    expect(flags.slice(12)).toEqual(['false', 'false']);
  });

  it('a record without a photo shows the missing-photo hatch, not a broken image', () => {
    const { container } = renderTable({ initialView: 'grid' });
    const card = container.querySelector('[data-row-key="plain-2"]')!;
    expect(card.querySelector('img')).toBeNull();
    expect(card.querySelector('[data-slot="missing-photo"]')).not.toBeNull();
  });
});

describe('Grid group cards: the header row, as a card', () => {
  it('a size run: its "N sizes" badge, roll-up on hand, rack summary and a drill-down named like the chevron', () => {
    const { container } = renderTable({ initialView: 'grid' });
    const card = container.querySelector('[data-group-key="style-group:tee"]')! as HTMLElement;
    expect(within(card).getAllByText('3 sizes').length).toBeGreaterThan(0);
    expect(card.querySelector('[data-slot="grid-card-quantity"]')).toHaveTextContent('30on hand');
    expect(within(card).getByRole('button', { name: 'Expand Tee (3 sizes)' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  it('a SKU family: its link, SKU, roll-ups ("Multiple") and the rack summary', () => {
    const { container } = renderTable({
      initialView: 'grid',
      items: [
        {
          ...row('a', { name: 'Chromebook', sku: 'CB-1', primary_location_id: 'loc-north' }),
          placed_racks: ['38-A'],
        },
        {
          ...row('b', { name: 'Chromebook', sku: 'CB-1', primary_location_id: 'loc-south' }),
          placed_racks: ['12-B'],
        },
      ] as never,
    });
    const card = container.querySelector('[data-group-key="sku-group:CB-1"]')! as HTMLElement;
    expect(within(card).getByRole('link', { name: 'Chromebook' })).toBeInTheDocument();
    expect(within(card).getByText('CB-1')).toBeInTheDocument();
    expect(
      within(card).getByTitle('Placements span multiple sites — expand to see each'),
    ).toHaveTextContent('Multiple');
    expect(within(card).getByTitle('Placements span: 38-A, 12-B')).toHaveTextContent('2 locations');
    expect(card.querySelector('[data-slot="grid-card-quantity"]')).toHaveTextContent('20on hand');
  });

  it('a named group: "N records" (or "N matching"), the first record with a photo, Rename and Remove with their gates', async () => {
    const user = userEvent.setup();
    const items = [
      row('g1', { name: 'Desk Lamp', ...inGroup('grp-desk', 'Desk Set') }),
      row('g2', {
        name: 'Desk Tray',
        ...inGroup('grp-desk', 'Desk Set'),
        image_thumb_url: 'https://img.test/tray.webp',
      }),
    ];
    const { container, unmount } = renderTable({
      initialView: 'grid',
      items: items as never,
      canRenameGroups: true,
    });
    const card = container.querySelector(
      '[data-group-key="display-group:grp-desk"]',
    )! as HTMLElement;
    expect(within(card).getByText('Desk Set')).toBeInTheDocument();
    expect(within(card).getAllByText('2 records').length).toBeGreaterThan(0);
    expect(card.querySelector('img')).toHaveAttribute('src', 'https://img.test/tray.webp');
    await user.click(within(card).getByRole('button', { name: 'Rename group Desk Set' }));
    expect(screen.getByTestId('rename-dialog')).toHaveTextContent('rename grp-desk');
    await user.click(within(card).getByRole('button', { name: 'Remove from group Desk Set' }));
    expect(screen.getByTestId('remove-dialog')).toHaveTextContent('remove g1,g2');
    unmount();

    // Staff who can edit items remove, never rename; a viewer gets neither.
    renderTable({ initialView: 'grid', items: items as never });
    expect(screen.queryByRole('button', { name: /^Rename group/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Remove from group Desk Set' })).toBeInTheDocument();
  });

  it('a named group under a filter says "N matching"', () => {
    urlState.params = new URLSearchParams('stock=low');
    renderTable({
      initialView: 'grid',
      items: [
        row('g1', { quantity_on_hand: 0, reorder_point: 5, ...inGroup('grp-desk', 'Desk Set') }),
        row('g2', { quantity_on_hand: 0, reorder_point: 5, ...inGroup('grp-desk', 'Desk Set') }),
      ] as never,
    });
    expect(
      screen.getByRole('button', { name: 'Expand group Desk Set (2 matching)' }),
    ).toBeInTheDocument();
  });

  it('server mode on a multi-page result marks a group card partial, with its reason', () => {
    const { container } = renderTable({
      initialView: 'grid',
      total: 45,
      items: [
        row('g1', inGroup('grp-desk', 'Desk Set')),
        row('g2', inGroup('grp-desk', 'Desk Set')),
      ] as never,
    });
    const card = container.querySelector('[data-group-key="display-group:grp-desk"]')!;
    const qty = card.querySelector('[data-slot="grid-card-quantity"]')!;
    expect(qty.textContent).toContain('*');
    expect(
      within(qty as HTMLElement).getByTitle(/other pages may hold more of this group/i),
    ).toBeInTheDocument();
  });

  it('Books: a title on several racks reads "N racks +N unset" on its card', () => {
    const book = (id: string, number: string | null, rowLetter: string | null) =>
      row(id, {
        name: 'Persepolis',
        sku: 'SP-THV69-MG8',
        item_type: 'book',
        custom_fields:
          number == null
            ? {}
            : { book_rack_number: number, ...(rowLetter ? { book_rack_row: rowLetter } : {}) },
      });
    const { container } = renderTable({
      initialView: 'grid',
      showBookFields: true,
      items: [book('n1', '38', 'A'), book('n2', '12', 'B'), book('n3', null, null)] as never,
    });
    const card = container.querySelector(
      '[data-group-key="sku-group:SP-THV69-MG8"]',
    )! as HTMLElement;
    expect(within(card).getByText('2 racks +1 unset')).toBeInTheDocument();
  });
});

describe('the Items tour reaches a record in both views', () => {
  it("'Dig into any item' lands on a table row in Table and on a card in Grid", () => {
    const step = ITEMS_PAGE_TOUR.steps.find((s) => s.title === 'Dig into any item');
    expect(step?.target).toBeTruthy();
    const table = renderTable();
    expect(table.container.querySelector(step!.target!)?.tagName).toBe('TR');
    table.unmount();
    const grid = renderTable({ initialView: 'grid' });
    expect(grid.container.querySelector(step!.target!)?.getAttribute('data-slot')).toBe(
      'grid-card',
    );
  });
});
