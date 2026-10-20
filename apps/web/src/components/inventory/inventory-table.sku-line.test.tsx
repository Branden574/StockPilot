import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Owner decision 2026-10-19: SKU stacked under the item name. The Items,
// Books and Rentals items tables have no SKU column any more: 11 cells on
// Items and 13 on Books, in every row kind. Each row's Item cell prints the
// SKU on a mono line of its own under the name, as plain text outside the
// name link, so it is still selected and copied on its own, found by the
// search and ordered by the Sort menu. On hand, 14-day and Status are trimmed
// to their content and keep every word and state.

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
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), message: vi.fn() } }));
vi.mock('@/server/actions/saved-views', () => ({
  createSavedViewAction: vi.fn(),
  deleteSavedViewAction: vi.fn(),
  setActiveWarehouseAction: vi.fn(),
  toggleSavedViewShareAction: vi.fn(),
}));
vi.mock('@/lib/download-export', () => ({ downloadInventoryExport: vi.fn() }));
vi.mock('@/components/ui/image-hover-preview', () => ({
  // Children only: the hover card (which repeats the SKU as its subtitle)
  // never renders here, so each row prints its SKU exactly once.
  ImageHoverPreview: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  prewarmPreviewImages: vi.fn(),
}));
vi.mock('@/lib/cycle-counts/use-count-selection', () => ({
  useCountSelection: (selector: (s: { add: () => void }) => unknown) => selector({ add: vi.fn() }),
}));
vi.mock('@/components/inventory/display-group-dialogs', () => ({
  GroupSelectedDialog: () => <div data-testid="group-dialog" />,
  RemoveFromGroupDialog: () => <div data-testid="remove-dialog" />,
  RenameGroupDialog: () => <div data-testid="rename-dialog" />,
}));
vi.mock('@/components/inventory/bulk-actions', () => ({
  BulkActions: () => <div data-testid="bulk-actions" />,
}));

import { InventoryTable, type InstantDatasetItem } from './inventory-table';

const LOOKUPS = {
  categories: new Map<string, { name: string; color: string | null }>([
    ['cat-swag', { name: 'Swag', color: null }],
  ]),
  locations: new Map<string, { name: string }>([['loc-north', { name: 'North DC' }]]),
  charters: new Map<string, { name: string; code: string | null }>(),
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

/** An Items page with every row kind: a plain record, one record split
 *  across a rack and staging (a SKU header over two split rows), a size run,
 *  a named group whose records keep their own SKUs, a named group whose
 *  records share one, and a record outside it with that same SKU. */
function itemsPage() {
  return [
    row('plain', { name: 'Mousepad', sku: 'MP-01' }),
    {
      ...row('split', { name: 'Chromebook', sku: 'CB-1' }),
      rowKey: 'split:L1',
      line_quantity: 4,
      placement_label: '1-A',
      placement_kind: 'rack',
    },
    {
      ...row('split', { name: 'Chromebook', sku: 'CB-1' }),
      rowKey: 'split:S1',
      line_quantity: 6,
      placement_label: 'Staging',
      placement_kind: 'staging',
    },
    row('tee-s', { name: 'Tee - S', sku: 'TEE-S' }),
    row('tee-m', { name: 'Tee - M', sku: 'TEE-M' }),
    row('g1', { name: 'Desk Lamp', sku: 'LAMP-1', ...inGroup('grp-desk', 'Desk Set') }),
    row('g2', { name: 'Desk Tray', sku: 'TRAY-1', ...inGroup('grp-desk', 'Desk Set') }),
    row('p1', { name: 'Pad A', sku: 'PAD-9', ...inGroup('grp-pads', 'Pads') }),
    row('p2', { name: 'Pad B', sku: 'PAD-9', ...inGroup('grp-pads', 'Pads') }),
    row('p3', { name: 'Pad C', sku: 'PAD-9' }),
  ];
}

/** A Books page: a plain title, one title on two rows (a SKU header), and a
 *  named group of two titles with their own SKUs. */
function booksPage() {
  const book = { item_type: 'book' };
  return [
    row('dune', { ...book, name: 'Dune', sku: 'BK-DUNE' }),
    row('alg-1', { ...book, name: 'Into Algebra 1', sku: 'BK-ALG', quantity_on_hand: 4 }),
    row('alg-2', { ...book, name: 'Into Algebra 1', sku: 'BK-ALG', quantity_on_hand: 6 }),
    row('bio', { ...book, name: 'Biology', sku: 'BK-BIO', ...inGroup('grp-sci', 'Science Shelf') }),
    row('chem', {
      ...book,
      name: 'Chemistry',
      sku: 'BK-CHEM',
      ...inGroup('grp-sci', 'Science Shelf'),
    }),
  ];
}

type Props = React.ComponentProps<typeof InventoryTable>;

const BOOKS: Partial<Props> = {
  showBookFields: true,
  basePath: '/dashboard/books',
  rowLinkPrefix: '/dashboard/books',
};

function renderTable(over: Partial<Props> = {}) {
  const items = (over.items as unknown[] | undefined) ?? itemsPage();
  return render(
    <InventoryTable
      items={items as never}
      lookups={LOOKUPS}
      total={new Set((items as Array<{ id: string }>).map((i) => i.id)).size}
      initialQuery=""
      pageSize={30}
      canUngroup
      canRenameGroups
      {...over}
    />,
  );
}

function dataset(id: string, over: Partial<InstantDatasetItem> = {}): InstantDatasetItem {
  return {
    id,
    name: `Item ${id}`,
    sku: `SKU-${id}`,
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

/** Instant mode (the whole dataset on the client), with the list URL's query. */
function renderInstant(items: InstantDatasetItem[], search = '', over: Partial<Props> = {}) {
  urlState.params = new URLSearchParams(search);
  const books = over.showBookFields === true;
  const base = books ? '/dashboard/books' : '/dashboard/inventory';
  window.history.replaceState(null, '', search ? `${base}?${search}` : base);
  return render(
    <InventoryTable
      items={items}
      lookups={LOOKUPS}
      total={items.length}
      initialQuery={urlState.params.get('q') ?? ''}
      pageSize={30}
      instant={{ items, view: books ? 'books' : 'items' }}
      {...over}
    />,
  );
}

const bodyRows = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('tbody tr')) as HTMLTableRowElement[];
const recordRow = (container: HTMLElement, key: string) =>
  container.querySelector(`tr[data-row-key="${key}"]`) as HTMLTableRowElement;
const headerRow = (container: HTMLElement, key: string) =>
  container.querySelector(`tr[data-group-key="${key}"]`) as HTMLTableRowElement;
const sizeRunHeader = (container: HTMLElement) =>
  container.querySelector('tr[data-group-key^="style-group:"]') as HTMLTableRowElement;
const skuLine = (tr: Element) => tr.querySelector<HTMLElement>('[data-slot="item-cell-sku"]');
const headerLabels = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('thead th')).map((th) => th.textContent ?? '');

/** Opens every header (size runs, SKU families, named groups) by its chevron. */
async function expandAll(user: ReturnType<typeof userEvent.setup>) {
  for (;;) {
    const next = screen.queryAllByRole('button', { name: /^Expand / });
    if (next.length === 0) return;
    await user.click(next[0]!);
  }
}

/** What each row is: a record, a member under a header, or the header's kind. */
function rowKinds(container: HTMLElement): string[] {
  return [
    ...new Set(
      bodyRows(container).map((tr) =>
        tr.dataset.rowKind === 'header'
          ? (tr.dataset.groupKey ?? '').split(':')[0]!
          : (tr.dataset.rowKind ?? 'none'),
      ),
    ),
  ].sort();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  urlState.params = new URLSearchParams('');
  window.history.replaceState(null, '', '/dashboard/inventory');
  window.localStorage.clear();
});

describe('one cell fewer in every row kind (owner decision 2026-10-19: SKU stacked under the item name)', () => {
  it('Items: 11 header cells and no SKU column; every record, member, split and header row has 11', async () => {
    const user = userEvent.setup();
    const { container } = renderTable();
    expect(headerLabels(container)).toEqual([
      '',
      'Item',
      'Category',
      'Charter',
      'Location',
      'Rack',
      'On hand',
      'Coverage',
      '14-day · qty',
      'Status',
      'Updated',
    ]);
    expect(screen.queryByRole('columnheader', { name: 'SKU' })).toBeNull();

    await expandAll(user);
    // Every kind of row is on screen, the staging split row among them.
    expect(rowKinds(container)).toEqual([
      'display-group',
      'member',
      'record',
      'sku-group',
      'style-group',
    ]);
    expect(recordRow(container, 'split:S1')).not.toBeNull();
    for (const tr of bodyRows(container)) expect(tr.children).toHaveLength(11);
  });

  it('Books: 13 header cells and no SKU column; every record, member and header row has 13', async () => {
    const user = userEvent.setup();
    const { container } = renderTable({ ...BOOKS, items: booksPage() as never });
    expect(headerLabels(container)).toEqual([
      '',
      'Item',
      'Category',
      'Charter',
      'Location',
      'Grade',
      'Rack',
      'Crate',
      'On hand',
      'Coverage',
      '14-day · qty',
      'Status',
      'Updated',
    ]);
    expect(screen.queryByRole('columnheader', { name: 'SKU' })).toBeNull();

    await expandAll(user);
    expect(rowKinds(container)).toEqual(['display-group', 'member', 'record', 'sku-group']);
    for (const tr of bodyRows(container)) expect(tr.children).toHaveLength(13);
  });

  it('the no-match line spans the whole table: 11 cells on Items, 13 on Books', () => {
    const items = [dataset('a', { name: 'Alpha Widget' })];
    const first = renderInstant(items, 'q=zzz');
    const line = first.container.querySelector('tbody td[colspan]') as HTMLTableCellElement;
    expect(line.colSpan).toBe(11);
    expect(first.container.querySelectorAll('thead th')).toHaveLength(11);
    first.unmount();

    const books = renderInstant(items, 'q=zzz', BOOKS);
    const bookLine = books.container.querySelector('tbody td[colspan]') as HTMLTableCellElement;
    expect(bookLine.colSpan).toBe(13);
    expect(books.container.querySelectorAll('thead th')).toHaveLength(13);
  });
});

describe('the SKU line under the name', () => {
  it('every Items row kind prints it: plain text in its own block after the name, outside the link, mono', async () => {
    const user = userEvent.setup();
    const { container } = renderTable();
    await expandAll(user);
    for (const tr of bodyRows(container)) {
      const itemCell = tr.children[1]!;
      const line = skuLine(tr);
      expect(line).not.toBeNull();
      expect(itemCell).toContainElement(line);
      expect(line!.tagName).toBe('DIV');
      // It may wrap inside the column (anywhere in a long run), so a long SKU
      // never widens the table.
      expect(line).toHaveClass(
        'text-muted-foreground',
        '[overflow-wrap:anywhere]',
        'font-mono',
        'text-[11.5px]',
      );
      expect(line).not.toHaveClass('whitespace-nowrap');
      // Not a link and nothing to press: a drag or a triple-click copies
      // exactly the SKU, as it did from its own column.
      expect(line!.closest('a')).toBeNull();
      expect(line!.querySelector('a, button, input')).toBeNull();
      const name = itemCell.querySelector('[data-slot="item-cell-name"]')!;
      expect(name.compareDocumentPosition(line!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }

    // Records, members and split rows print their own SKU and nothing else.
    expect(skuLine(recordRow(container, 'plain'))!.textContent).toBe('MP-01');
    expect(skuLine(recordRow(container, 'split:L1'))!.textContent).toBe('CB-1');
    expect(skuLine(recordRow(container, 'split:S1'))!.textContent).toBe('CB-1');
    expect(skuLine(recordRow(container, 'tee-s'))!.textContent).toBe('TEE-S');
    expect(skuLine(recordRow(container, 'g1'))!.textContent).toBe('LAMP-1');
    expect(skuLine(recordRow(container, 'p3'))!.textContent).toBe('PAD-9');
    // A SKU header: the shared SKU.
    expect(skuLine(headerRow(container, 'sku-group:CB-1'))!.textContent).toBe('CB-1');
    // A named group whose records keep their own SKUs says so, with its reason.
    const desk = skuLine(headerRow(container, 'display-group:grp-desk'))!;
    expect(desk.textContent).toBe('Multiple');
    expect(within(desk).getByText('Multiple')).toHaveAttribute(
      'title',
      'These records keep their own SKUs — expand to see each',
    );
    // A named group whose records share one SKU shows it.
    expect(skuLine(headerRow(container, 'display-group:grp-pads'))!.textContent).toBe('PAD-9');
    // A size run spans several SKUs: a dash, as its SKU cell showed.
    const run = skuLine(sizeRunHeader(container))!;
    expect(run.textContent).toBe('—');
    expect(within(run).getByText('—')).toHaveClass('font-sans', 'italic');
  });

  it('the name stays the first link in a record row, and the SKU never joins it', () => {
    const { container } = renderTable();
    const tr = recordRow(container, 'plain');
    const link = tr.querySelector('a[href]')!;
    expect(link).toHaveTextContent('Mousepad');
    expect(link.textContent).not.toContain('MP-01');
    expect(link.getAttribute('href')).toMatch(/^\/dashboard\/inventory\/plain\?return=/);
    // Printed once per row, as its own column did.
    expect(within(tr).getAllByText('MP-01')).toHaveLength(1);
  });

  it('Books rows and headers print it the same way', async () => {
    const user = userEvent.setup();
    const { container } = renderTable({ ...BOOKS, items: booksPage() as never });
    await expandAll(user);
    for (const tr of bodyRows(container)) {
      const line = skuLine(tr);
      expect(line).not.toBeNull();
      expect(line).toHaveClass('font-mono');
      expect(line!.closest('a')).toBeNull();
    }
    expect(skuLine(recordRow(container, 'dune'))!.textContent).toBe('BK-DUNE');
    expect(skuLine(recordRow(container, 'alg-2'))!.textContent).toBe('BK-ALG');
    expect(skuLine(headerRow(container, 'sku-group:BK-ALG'))!.textContent).toBe('BK-ALG');
    expect(skuLine(headerRow(container, 'display-group:grp-sci'))!.textContent).toBe('Multiple');
    expect(skuLine(recordRow(container, 'chem'))!.textContent).toBe('BK-CHEM');
  });

  it('a long SKU wraps inside the Item cell in every row kind, and the line still holds exactly the SKU', async () => {
    // The app allows 64-character SKUs, and the books import mints one from a
    // title (spaces and all). Each wraps in its line instead of widening the
    // column and the table; a soft wrap adds no character, so copying the line
    // still gives exactly the SKU, and the search and the Sort menu read
    // `item.sku` as before.
    const sku64 = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789-ABCDEFGHJKLMNPQRSTUVWXYZ01234';
    const titleSku = 'Number Stories for Little Learners-MABCD-001WXYZ';
    expect(sku64).toHaveLength(64);
    const user = userEvent.setup();
    const { container } = renderTable({
      items: [
        row('long', { name: 'Long SKU', sku: sku64 }),
        row('t1', { name: 'Number Stories', sku: titleSku }),
        row('t2', { name: 'Number Stories', sku: titleSku }),
        row('g1', { name: 'Lamp', sku: sku64, ...inGroup('grp-long', 'Long Set') }),
        row('g2', { name: 'Tray', sku: sku64, ...inGroup('grp-long', 'Long Set') }),
      ] as never,
    });
    await expandAll(user);
    const lines = [
      skuLine(recordRow(container, 'long'))!,
      skuLine(headerRow(container, `sku-group:${titleSku}`))!,
      skuLine(recordRow(container, 't1'))!,
      skuLine(headerRow(container, 'display-group:grp-long'))!,
      skuLine(recordRow(container, 'g2'))!,
    ];
    expect(lines.map((l) => l.textContent)).toEqual([sku64, titleSku, titleSku, sku64, sku64]);
    for (const line of lines) {
      expect(line).toHaveClass('[overflow-wrap:anywhere]');
      expect(line).not.toHaveClass('whitespace-nowrap');
      expect(line.closest('.whitespace-nowrap')).toBeNull();
    }
  });

  it('Rentals items rows print it too', () => {
    const { container } = renderTable({
      basePath: '/dashboard/rentals/items',
      rowLinkPrefix: '/dashboard/rentals/items',
      reservedByItem: new Map([['cam', 1]]),
      items: [row('cam', { name: 'Camera', sku: 'CAM-7', quantity_on_hand: 1 })] as never,
    });
    expect(skuLine(recordRow(container, 'cam'))!.textContent).toBe('CAM-7');
    expect(recordRow(container, 'cam').children).toHaveLength(11);
  });
});

describe('On hand: the figure is mono, the notes are not', () => {
  const backpack = () =>
    row('bp', {
      name: 'Backpack',
      sku: 'BP-1',
      quantity_on_hand: 142,
      placed_quantity: 120,
      staged_quantity: 22,
      placed_racks: ['18-B'],
    });
  // checkbox, Item, Category, Charter, Location, Rack, On hand
  const onHandCell = (tr: Element) => tr.children[6] as HTMLElement;

  it('a record: the figure keeps its mono face; "N placed ·" stays whole and the amber count may wrap before "put-away"', () => {
    const { container } = renderTable({ items: [backpack()] as never });
    const cell = onHandCell(recordRow(container, 'bp'));
    expect(cell).not.toHaveClass('font-mono');
    expect(within(cell).getByText('142')).toHaveClass(
      'font-mono',
      'text-[13.5px]',
      'font-medium',
      'tabular-nums',
    );
    const placed = within(cell).getByText('120 placed ·');
    expect(placed).toHaveClass('text-muted-foreground', 'whitespace-nowrap');
    const awaiting = within(cell).getByText('22 awaiting put-away');
    expect(awaiting).toHaveClass('text-warning');
    expect(awaiting).not.toHaveClass('whitespace-nowrap');
    // The count stays with "awaiting" (a no-break space).
    expect(awaiting.textContent).toBe('22 awaiting put-away');
    expect(awaiting.closest('.font-mono')).toBeNull();
    expect(awaiting.parentElement).toHaveClass('text-balance');
  });

  it('a staging split row: the figure is mono, "awaiting put-away" is one text node in the body face', async () => {
    const user = userEvent.setup();
    const { container } = renderTable();
    await user.click(screen.getByRole('button', { name: /^Expand CB-1/ }));
    const cell = onHandCell(recordRow(container, 'split:S1'));
    expect(within(cell).getByText('6')).toHaveClass('font-mono');
    const note = within(cell).getByText('awaiting put-away');
    expect(note).toHaveClass('text-warning', 'text-balance');
    expect(note).not.toHaveClass('whitespace-nowrap');
    expect(note.closest('.font-mono')).toBeNull();
  });

  it('a Grid card keeps its notes exactly as before (whole phrases, one line each)', () => {
    const { container } = renderTable({ items: [backpack()] as never, initialView: 'grid' });
    const card = container.querySelector('[data-row-key="bp"]') as HTMLElement;
    const awaiting = within(card).getByText('22 awaiting put-away');
    expect(awaiting).toHaveClass('text-warning', 'whitespace-nowrap');
    expect(awaiting.textContent).toBe('22 awaiting put-away');
    expect(awaiting.parentElement).not.toHaveClass('text-balance');
    expect(within(card).getByText('120 placed ·', { exact: false })).toHaveClass(
      'whitespace-nowrap',
    );
  });

  it('Rentals items: "{avail} avail · {out} out" reads in the body face under a mono figure', () => {
    const { container } = renderTable({
      basePath: '/dashboard/rentals/items',
      rowLinkPrefix: '/dashboard/rentals/items',
      reservedByItem: new Map([['cam', 1]]),
      items: [row('cam', { name: 'Camera', quantity_on_hand: 1 })] as never,
    });
    const cell = onHandCell(recordRow(container, 'cam'));
    expect(within(cell).getByText('1')).toHaveClass('font-mono');
    // The same words; each phrase stays whole, so a second line starts with
    // "1 out", never with the dot.
    const avail = within(cell).getByText('0 avail ·');
    const out = within(cell).getByText('1 out');
    expect(avail).toHaveClass('whitespace-nowrap');
    expect(out).toHaveClass('whitespace-nowrap');
    const note = avail.parentElement!;
    expect(note).toBe(out.parentElement);
    expect(note.textContent).toBe('0 avail · 1 out');
    expect(note).toHaveClass('text-balance');
    expect(note.closest('.font-mono')).toBeNull();
    expect(within(cell.closest('tr')!).getByText('Out of stock')).toBeInTheDocument();
  });

  it('Rentals items in Grid keep "{avail} avail · {out} out" as one run of text', () => {
    const { container } = renderTable({
      initialView: 'grid',
      basePath: '/dashboard/rentals/items',
      rowLinkPrefix: '/dashboard/rentals/items',
      reservedByItem: new Map([['cam', 1]]),
      items: [row('cam', { name: 'Camera', quantity_on_hand: 1 })] as never,
    });
    const card = container.querySelector('[data-row-key="cam"]') as HTMLElement;
    const note = within(card).getByText('0 avail · 1 out');
    expect(note.children).toHaveLength(0);
    expect(note).not.toHaveClass('text-balance');
  });

  it('a header keeps its "*" with the figure, and the explanation on the cell', () => {
    // Server mode, more records than this page: the SKU family total is partial.
    const { container } = renderTable({
      items: [row('a', { sku: 'PAIR' }), row('b', { sku: 'PAIR' })] as never,
      total: 90,
    });
    const header = headerRow(container, 'sku-group:PAIR');
    const cell = onHandCell(header);
    expect(cell).toHaveAttribute('title', expect.stringContaining('other pages may hold more'));
    const figure = cell.querySelector('.font-mono')!;
    expect(figure).toHaveTextContent('20*');
  });
});

describe('the 14-day toggle', () => {
  it('keeps its words and its name in both modes; each part stays whole', async () => {
    const user = userEvent.setup();
    renderTable({ items: [row('a')] as never });
    const qty = screen.getByRole('button', { name: 'Sparkline mode: quantity trend' });
    expect(qty.textContent).toBe('14-day · qty');
    expect(within(qty).getByText('14-day')).toHaveClass('whitespace-nowrap');
    expect(within(qty).getByText('· qty')).toHaveClass('whitespace-nowrap');

    await user.click(qty);
    await user.click(screen.getByRole('button', { name: 'Move count' }));
    const moves = screen.getByRole('button', { name: 'Sparkline mode: movement count' });
    expect(moves.textContent).toBe('14-day · moves');
    expect(within(moves).getByText('· moves')).toHaveClass('whitespace-nowrap');

    await user.click(moves);
    await user.click(screen.getByRole('button', { name: 'Quantity trend' }));
    expect(screen.getByRole('button', { name: 'Sparkline mode: quantity trend' }).textContent).toBe(
      '14-day · qty',
    );
  });
});

describe('the Item cell may wrap between pieces, never inside one', () => {
  it('Rename group and Remove from group each stay on one line; their line may wrap between them, under the SKU', () => {
    const { container } = renderTable();
    const header = headerRow(container, 'display-group:grp-desk');
    const rename = within(header).getByRole('button', { name: 'Rename group Desk Set' });
    const remove = within(header).getByRole('button', { name: 'Remove from group Desk Set' });
    for (const button of [rename, remove]) expect(button).toHaveClass('whitespace-nowrap');
    const line = rename.parentElement!;
    expect(remove.parentElement).toBe(line);
    expect(line).toHaveAttribute('data-slot', 'item-cell-actions');
    expect(line).toHaveClass('flex', 'flex-wrap');
    const sku = skuLine(header)!;
    expect(sku).not.toContainElement(rename);
    expect(sku.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('wrapped Rename and Remove keep clear of each other and of the SKU (touch targets, WCAG 2.5.8)', () => {
    const { container } = renderTable();
    const header = headerRow(container, 'display-group:grp-desk');
    const rename = within(header).getByRole('button', { name: 'Rename group Desk Set' });
    // Both carry the shared 44 px touch target, so on a phone or a coarse
    // pointer the line keeps 14 px from the SKU line and between its own
    // lines ((44 - 18) / 2 = 13): a tap on Rename's centre is Rename's, and a
    // long-press on the SKU selects the SKU. On a fine pointer two wrapped
    // actions sit 6 px apart, outside each other's 24 px circle.
    for (const name of ['Rename group Desk Set', 'Remove from group Desk Set']) {
      expect(within(header).getByRole('button', { name })).toHaveClass('before:min-h-11');
    }
    expect(rename.parentElement).toHaveClass(
      'gap-y-1.5',
      'max-sm:gap-y-3.5',
      'pointer-coarse:gap-y-3.5',
      'max-sm:mt-3.5',
      'pointer-coarse:mt-3.5',
    );
  });

  it('Add to group may drop under its chip in the table, and stays on one line', () => {
    const { container } = renderTable();
    const tr = recordRow(container, 'p3');
    expect(within(tr).getByText('Same SKU as records in Pads')).toBeInTheDocument();
    const add = within(tr).getByRole('button', { name: 'Add to group Pads: Pad C' });
    expect(add).toHaveClass('whitespace-nowrap');
    expect(add.closest('.flex-wrap')).not.toBeNull();
  });

  it('a row whose chip offers Add to group keeps 14 px around it where the touch target is on; other rows do not move', async () => {
    const user = userEvent.setup();
    const { container } = renderTable();
    await expandAll(user);
    const nameLine = (tr: Element) =>
      tr.querySelector('[data-slot="item-cell-name"]')!.parentElement!;
    // Pad C shares Pads' SKU outside the group: its chip offers Add to group,
    // whose 44 px target would otherwise cover most of the SKU line under it
    // (or the name above a wrapped chip) on a phone or a tablet.
    const p3 = recordRow(container, 'p3');
    expect(within(p3).getByRole('button', { name: 'Add to group Pads: Pad C' })).toHaveClass(
      'before:min-h-11',
    );
    expect(skuLine(p3)).toHaveClass('max-sm:mt-3.5', 'pointer-coarse:mt-3.5');
    expect(nameLine(p3)).toHaveClass('max-sm:gap-y-3.5', 'pointer-coarse:gap-y-3.5');
    // A group member's "In group" chip has no action, and a plain row no chip.
    for (const key of ['g1', 'plain']) {
      const tr = recordRow(container, key);
      expect(within(tr).queryByRole('button', { name: /^Add to group/ })).toBeNull();
      expect(skuLine(tr)).not.toHaveClass('max-sm:mt-3.5');
      expect(nameLine(tr)).not.toHaveClass('max-sm:gap-y-3.5');
    }
  });

  it('without the right to group, the same chip has no action and its row keeps the plain spacing', () => {
    const { container } = renderTable({ canUngroup: false });
    const p3 = recordRow(container, 'p3');
    expect(within(p3).getByText('Same SKU as records in Pads')).toBeInTheDocument();
    expect(within(p3).queryByRole('button', { name: /^Add to group/ })).toBeNull();
    expect(skuLine(p3)).not.toHaveClass('max-sm:mt-3.5');
    expect(skuLine(p3)).not.toHaveClass('pointer-coarse:mt-3.5');
  });
});

describe('each column pads alike in its header cell and in every row kind', () => {
  /** A cell's side padding, as pl-* and pr-* (px-N reads as pl-N pr-N). */
  const sides = (el: Element) => {
    const out: string[] = [];
    for (const c of Array.from(el.classList)) {
      const m = /^(px|pl|pr)-(.+)$/.exec(c);
      if (!m) continue;
      if (m[1] === 'px') out.push(`pl-${m[2]}`, `pr-${m[2]}`);
      else out.push(c);
    }
    return out.sort().join(' ');
  };

  async function columnsOf(over: Partial<Props>) {
    const user = userEvent.setup();
    const { container } = renderTable(over);
    await expandAll(user);
    const heads = Array.from(container.querySelectorAll('thead th'));
    const labels = headerLabels(container).map((l) => (l.startsWith('14-day') ? '14-day' : l));
    for (const tr of bodyRows(container)) {
      Array.from(tr.children).forEach((td, i) => {
        expect(sides(td), `${tr.dataset.rowKey ?? tr.dataset.groupKey} ${labels[i]}`).toBe(
          sides(heads[i]!),
        );
      });
    }
    return Object.fromEntries(labels.map((l, i) => [l, sides(heads[i]!)]));
  }

  it('Items: 12 px inside the table, the trimmed On hand, 14-day and Status, 16 at the edges', async () => {
    const pads = await columnsOf({});
    expect(pads).toEqual({
      '': 'pl-4 pr-0',
      Item: 'pl-3 pr-3',
      Category: 'pl-3 pr-3',
      Charter: 'pl-3 pr-3',
      Location: 'pl-3 pr-3',
      Rack: 'pl-3 pr-3',
      'On hand': 'pl-1 pr-3',
      Coverage: 'pl-3 pr-3',
      '14-day': 'pl-1 pr-3',
      Status: 'pl-3 pr-1',
      Updated: 'pl-3 pr-4',
    });
  });

  it('Books: 8 px a side for every inner column, so its two extra columns fit a 1440 screen', async () => {
    const pads = await columnsOf({ ...BOOKS, items: booksPage() as never });
    expect(pads).toEqual({
      '': 'pl-4 pr-0',
      Item: 'pl-3 pr-3',
      Category: 'pl-2 pr-2',
      Charter: 'pl-2 pr-2',
      Location: 'pl-2 pr-2',
      Grade: 'pl-2 pr-2',
      Rack: 'pl-2 pr-2',
      Crate: 'pl-2 pr-2',
      'On hand': 'pl-1 pr-2',
      Coverage: 'pl-2 pr-2',
      '14-day': 'pl-1 pr-2',
      Status: 'pl-2 pr-1',
      Updated: 'pl-3 pr-4',
    });
  });

  it('the Item and Location floors: 220 and 88 on Items, 208 and 80 on Books (64 px for a site name on both)', () => {
    const items = renderTable();
    const itemsRow = recordRow(items.container, 'plain');
    expect(itemsRow.children[1]).toHaveClass('min-w-[220px]');
    expect(itemsRow.children[4]).toHaveClass('min-w-[88px]');
    items.unmount();

    const books = renderTable({ ...BOOKS, items: booksPage() as never });
    const booksRow = recordRow(books.container, 'dune');
    expect(booksRow.children[1]).toHaveClass('min-w-[208px]');
    expect(booksRow.children[1]).not.toHaveClass('min-w-[220px]');
    expect(booksRow.children[4]).toHaveClass('min-w-[80px]');
    const header = headerRow(books.container, 'sku-group:BK-ALG');
    expect(header.children[1]).toHaveClass('min-w-[208px]');
    expect(header.children[4]).toHaveClass('min-w-[80px]');
  });
});

describe('the SKU is still found and ordered as before', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('instant mode: typing a SKU keeps its row, with no request', async () => {
    const user = userEvent.setup();
    renderInstant([
      dataset('a', { name: 'Alpha Widget', sku: 'AW-100' }),
      dataset('b', { name: 'Beta Gadget', sku: 'BG-200' }),
    ]);
    await user.type(screen.getByRole('textbox', { name: 'Search items' }), 'bg-2');
    const link = await screen.findByRole('link', { name: 'Beta Gadget' });
    expect(screen.queryByRole('link', { name: 'Alpha Widget' })).toBeNull();
    expect(skuLine(link.closest('tr')!)!.textContent).toBe('BG-200');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('the Sort menu still offers SKU (A → Z) and SKU (Z → A), and a SKU sort lists the rows by their SKU line', async () => {
    const user = userEvent.setup();
    const items = [
      dataset('z', { name: 'Zed', sku: 'A-1' }),
      dataset('a', { name: 'Alpha', sku: 'C-3' }),
      dataset('m', { name: 'Mid', sku: 'B-2' }),
    ];
    const asc = renderInstant(items, 'sort=sku_asc');
    const skus = () => bodyRows(asc.container).map((tr) => skuLine(tr)!.textContent);
    expect(skus()).toEqual(['A-1', 'B-2', 'C-3']);

    await user.click(screen.getByRole('button', { name: 'Sort by SKU (A → Z)' }));
    expect(screen.getByRole('button', { name: 'SKU (A → Z)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'SKU (Z → A)' })).toBeInTheDocument();
    asc.unmount();

    const desc = renderInstant(items, 'sort=sku_desc');
    expect(bodyRows(desc.container).map((tr) => skuLine(tr)!.textContent)).toEqual([
      'C-3',
      'B-2',
      'A-1',
    ]);
  });
});
