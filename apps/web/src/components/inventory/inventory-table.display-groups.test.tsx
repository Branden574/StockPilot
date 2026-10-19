import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Group selected (migration 0400) on the Items and Books tables: explicit
// display group headers (core composeDisplayList: two or more records present,
// else the record shows an "In group" chip and falls back to its SKU family),
// the chips, the V3 fix (an expanded header's rows are never pulled into a
// size run), and the bulk bar's facts (distinct records, one type, from the
// loaded rows only).

const { routerMock, urlState } = vi.hoisted(() => ({
  routerMock: { replace: vi.fn(), push: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() },
  // The list's URL (a test sets ?stock=low to put the list in a stock view).
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
const { previews } = vi.hoisted(() => ({
  // What each hover preview was handed, by its title (a group header's title
  // is the group's name): the master src and the lazy master loader.
  previews: new Map<string, { src: string | null; srcLoader?: () => Promise<string | null> }>(),
}));
vi.mock('@/components/ui/image-hover-preview', () => ({
  // The hover card's meta (where a header's "partial" mark lives) renders too.
  ImageHoverPreview: ({
    children,
    meta,
    src,
    srcLoader,
    title,
  }: {
    children: React.ReactNode;
    meta?: React.ReactNode;
    src: string | null;
    srcLoader?: () => Promise<string | null>;
    title?: string;
  }) => {
    if (title) previews.set(title, { src, srcLoader });
    return (
      <span>
        {children}
        {meta}
      </span>
    );
  },
  prewarmPreviewImages: vi.fn(),
}));
vi.mock('@/lib/cycle-counts/use-count-selection', () => ({
  useCountSelection: (selector: (s: { add: () => void }) => unknown) => selector({ add: vi.fn() }),
}));
vi.mock('@/components/inventory/display-group-dialogs', () => ({
  GroupSelectedDialog: (p: { itemIds: readonly string[]; initialGroupId?: string | null }) => (
    <div data-testid="group-dialog">
      add {p.itemIds.join(',')} to {p.initialGroupId}
    </div>
  ),
  RemoveFromGroupDialog: (p: { itemIds: readonly string[] }) => (
    <div data-testid="remove-dialog">remove {p.itemIds.join(',')}</div>
  ),
  RenameGroupDialog: (p: { groupId: string }) => (
    <div data-testid="rename-dialog">rename {p.groupId}</div>
  ),
}));

const { spy } = vi.hoisted(() => ({
  spy: {
    selectedIds: [] as string[],
    groupItemIds: undefined as string[] | undefined,
    ungroupItemIds: undefined as string[] | undefined,
    groupingView: undefined as string | undefined,
    onGrouped: undefined as ((groupId: string) => void) | undefined,
  },
}));
vi.mock('@/components/inventory/bulk-actions', () => ({
  BulkActions: (props: {
    selectedIds: string[];
    groupItemIds?: string[];
    ungroupItemIds?: string[];
    groupingView?: string;
    onGrouped?: (groupId: string) => void;
  }) => {
    spy.selectedIds = props.selectedIds;
    spy.groupItemIds = props.groupItemIds;
    spy.ungroupItemIds = props.ungroupItemIds;
    spy.groupingView = props.groupingView;
    spy.onGrouped = props.onGrouped;
    return <div data-testid="bulk-actions" />;
  },
}));

import { InventoryTable } from './inventory-table';

const LOOKUPS = {
  categories: new Map<string, { name: string; color: string | null }>(),
  locations: new Map<string, { name: string }>(),
  charters: new Map<string, { name: string; code: string | null }>(),
};

function row(id: string, sku: string, over: Record<string, unknown> = {}) {
  return {
    id,
    name: `Item ${id}`,
    sku,
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

function bodyRows(container: HTMLElement) {
  return Array.from(container.querySelectorAll('tbody tr'));
}

beforeEach(() => {
  vi.clearAllMocks();
  urlState.params = new URLSearchParams('');
  spy.selectedIds = [];
  spy.groupItemIds = undefined;
  spy.ungroupItemIds = undefined;
  spy.groupingView = undefined;
  previews.clear();
});

describe('InventoryTable: explicit display group headers', () => {
  it('two records with different SKUs on one rack show as ONE header named for the group; each keeps its SKU', async () => {
    const items = [
      row('a', 'POLO-A', { name: 'Polo XXXL', quantity_on_hand: 3, ...inGroup('g', 'Polo XXXL') }),
      row('b', 'POLO-B', { name: 'Polo XXXL', quantity_on_hand: 2, ...inGroup('g', 'Polo XXXL') }),
      row('c', 'OTHER', { name: 'Other' }),
    ];
    const { container } = render(
      <InventoryTable
        items={items as never}
        lookups={LOOKUPS}
        total={3}
        initialQuery=""
        pageSize={30}
        canUngroup
      />,
    );
    // Header + the other row; the members are hidden until expanded.
    expect(bodyRows(container)).toHaveLength(2);
    const header = bodyRows(container)[0]!;
    expect(within(header as HTMLElement).getByText('Polo XXXL')).toBeInTheDocument();
    expect(within(header as HTMLElement).getByText('2 records')).toBeInTheDocument();
    // The SKUs differ by design: the SKU cell says so instead of picking one.
    expect(within(header as HTMLElement).getByText('Multiple')).toBeInTheDocument();
    // On hand counts each record once: 3 + 2.
    expect(within(header as HTMLElement).getAllByText('5').length).toBeGreaterThan(0);

    await userEvent.click(
      screen.getByRole('button', { name: /expand group polo xxxl \(2 records\)/i }),
    );
    expect(bodyRows(container)).toHaveLength(4);
    expect(screen.getByText('POLO-A')).toBeInTheDocument();
    expect(screen.getByText('POLO-B')).toBeInTheDocument();
  });

  it('a group with ONE record on screen does not form: the record keeps its SKU family and shows "In group <name>"', () => {
    const items = [row('a', 'SKU-X', { ...inGroup('g', 'Polo XXXL') }), row('b', 'SKU-X')];
    render(
      <InventoryTable
        items={items as never}
        lookups={LOOKUPS}
        total={2}
        initialQuery=""
        pageSize={30}
      />,
    );
    // The SKU family header (two records of SKU-X) is what forms.
    expect(screen.getByRole('button', { name: /expand SKU-X/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /expand group/i })).not.toBeInTheDocument();
  });

  it('a lone member outside any SKU family wears "In group <name>"', () => {
    const items = [row('a', 'SKU-A', { ...inGroup('g', 'Polo XXXL') }), row('b', 'SKU-B')];
    render(
      <InventoryTable
        items={items as never}
        lookups={LOOKUPS}
        total={2}
        initialQuery=""
        pageSize={30}
      />,
    );
    expect(screen.getByText('In group Polo XXXL')).toBeInTheDocument();
  });

  it('a record in no group sharing a SKU with a group here is offered Add to group (an explicit choice, never automatic)', async () => {
    const items = [
      row('a', 'PAD', { ...inGroup('g', 'Pads') }),
      row('b', 'DESK', { ...inGroup('g', 'Pads') }),
      row('c', 'PAD'),
    ];
    render(
      <InventoryTable
        items={items as never}
        lookups={LOOKUPS}
        total={3}
        initialQuery=""
        pageSize={30}
        canUngroup
      />,
    );
    expect(screen.getByText('Same SKU as records in Pads')).toBeInTheDocument();
    // P11: the button names its group and its record (one per chip).
    await userEvent.click(screen.getByRole('button', { name: 'Add to group Pads: Item c' }));
    expect(screen.getByTestId('group-dialog')).toHaveTextContent('add c to g');
  });

  it('no Add to group, Rename or Remove for a viewer who cannot edit items', () => {
    const items = [
      row('a', 'PAD', { ...inGroup('g', 'Pads') }),
      row('b', 'DESK', { ...inGroup('g', 'Pads') }),
      row('c', 'PAD'),
    ];
    render(
      <InventoryTable
        items={items as never}
        lookups={LOOKUPS}
        total={3}
        initialQuery=""
        pageSize={30}
      />,
    );
    expect(screen.queryByRole('button', { name: /^Add to group/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Rename group/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Remove from group/ })).not.toBeInTheDocument();
  });

  it('the header offers Rename and Remove for the records on screen', async () => {
    const items = [
      row('a', 'A', { ...inGroup('g', 'Pads') }),
      row('b', 'B', { ...inGroup('g', 'Pads') }),
    ];
    render(
      <InventoryTable
        items={items as never}
        lookups={LOOKUPS}
        total={2}
        initialQuery=""
        pageSize={30}
        canUngroup
        canRenameGroups
      />,
    );
    // P11: each header's buttons name their group, so two headers' buttons
    // never share one accessible name.
    await userEvent.click(screen.getByRole('button', { name: 'Remove from group Pads' }));
    expect(screen.getByTestId('remove-dialog')).toHaveTextContent('remove a,b');
    await userEvent.click(screen.getByRole('button', { name: 'Rename group Pads' }));
    expect(screen.getByTestId('rename-dialog')).toHaveTextContent('rename g');
  });

  it('Rename is offered to a manager only (security review SEC-1: the database refuses anyone else, whatever they can see)', () => {
    const items = [
      row('a', 'A', { ...inGroup('g', 'Pads') }),
      row('b', 'B', { ...inGroup('g', 'Pads') }),
    ];
    render(
      <InventoryTable
        items={items as never}
        lookups={LOOKUPS}
        total={2}
        initialQuery=""
        pageSize={30}
        canUngroup
      />,
    );
    // Staff who can edit items still remove; only the name is a manager's.
    expect(screen.getByRole('button', { name: /^Remove from group/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Rename group/ })).not.toBeInTheDocument();
  });

  // People review P5: "N matching" whenever anything narrows the list (a
  // search, a filter, a stock view, Expected or Archived), the same words in
  // the chevron's name. P5 also said a group's header shows no cover; the
  // owner overruled that on 2026-10-12: it shows the first picture among the
  // group's records (see the cover tests below).
  it('a stock view counts the header as matching, in its words and its button name; the header shows the first record picture (owner 2026-10-12)', () => {
    urlState.params = new URLSearchParams('stock=low');
    const items = [
      row('a', 'A', {
        ...inGroup('g', 'Pads'),
        quantity_on_hand: 0,
        reorder_point: 5,
        image_thumb_url: 'https://img.test/a.png',
      }),
      row('b', 'B', { ...inGroup('g', 'Pads'), quantity_on_hand: 0, reorder_point: 5 }),
    ];
    const { container } = render(
      <InventoryTable
        items={items as never}
        lookups={LOOKUPS}
        total={2}
        initialQuery=""
        pageSize={30}
      />,
    );
    const header = bodyRows(container)[0] as HTMLElement;
    expect(within(header).getByText('2 matching')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Expand group Pads (2 matching)' }),
    ).toBeInTheDocument();
    expect(header.querySelector('img')?.getAttribute('src')).toBe('https://img.test/a.png');
  });

  it('a lifecycle view counts as narrowing only when it shows fewer records than the default: Archived yes, Active or All no (P5)', () => {
    const items = [
      row('a', 'A', { ...inGroup('g', 'Pads') }),
      row('b', 'B', { ...inGroup('g', 'Pads') }),
    ];
    const header = (status: string) => {
      urlState.params = new URLSearchParams(`status=${status}`);
      const { container, unmount } = render(
        <InventoryTable
          items={items as never}
          lookups={LOOKUPS}
          total={2}
          initialQuery=""
          pageSize={30}
        />,
      );
      const text = (bodyRows(container)[0] as HTMLElement).textContent ?? '';
      unmount();
      return text;
    };
    expect(header('archived')).toContain('2 matching');
    expect(header('discontinued')).toContain('2 matching');
    expect(header('active')).toContain('2 records');
    expect(header('all')).toContain('2 records');
  });

  it('server mode on a multi-page result marks the group header partial', () => {
    const items = [
      row('a', 'A', { ...inGroup('g', 'Pads') }),
      row('b', 'B', { ...inGroup('g', 'Pads') }),
    ];
    const { container } = render(
      <InventoryTable
        items={items as never}
        lookups={LOOKUPS}
        total={45}
        initialQuery=""
        pageSize={30}
      />,
    );
    const header = bodyRows(container)[0] as HTMLElement;
    // Both places that explain the "*" use the group's words: the hover card's
    // figure and (fixed in redesign P3.2) the On hand cell, which said "other
    // pages may hold more of this SKU" over a group of different SKUs.
    expect(within(header).getAllByTitle(/other pages may hold more of this group/i)).toHaveLength(
      2,
    );
    expect(within(header).queryByTitle(/of this SKU/i)).toBeNull();
  });

  it('Books: one header for two editions of one title, no size runs', () => {
    const items = [
      row('e1', 'BK-1', {
        name: 'Earth Science - S',
        item_type: 'book',
        barcode: '9780306406157',
        ...inGroup('g', 'Earth Science'),
      }),
      row('e2', 'BK-2', {
        name: 'Earth Science - S',
        item_type: 'book',
        barcode: '9781861972712',
        ...inGroup('g', 'Earth Science'),
      }),
      row('x', 'BK-3', { name: 'Hoodie - M', item_type: 'book' }),
      row('y', 'BK-4', { name: 'Hoodie - L', item_type: 'book' }),
    ];
    const { container } = render(
      <InventoryTable
        items={items as never}
        lookups={LOOKUPS}
        total={4}
        initialQuery=""
        pageSize={30}
        showBookFields
      />,
    );
    expect(
      screen.getByRole('button', { name: /expand group earth science \(2 records\)/i }),
    ).toBeInTheDocument();
    // The two sized-looking books stay rows: Books never get size runs.
    expect(bodyRows(container)).toHaveLength(3);
  });
});

describe('InventoryTable: the V3 fix (an expanded header never feeds a size run)', () => {
  it('A and B (SKU X, "Tee - S"), C "Tee - M", D "Tee - L": the run is C and D, collapsed or with X expanded', async () => {
    const items = [
      row('A', 'X', { name: 'Tee - S', quantity_on_hand: 4 }),
      row('B', 'X', { name: 'Tee - S', quantity_on_hand: 4 }),
      row('C', 'Y', { name: 'Tee - M', quantity_on_hand: 2 }),
      row('D', 'Z', { name: 'Tee - L', quantity_on_hand: 4 }),
    ];
    const { container } = render(
      <InventoryTable
        items={items as never}
        lookups={LOOKUPS}
        total={4}
        initialQuery=""
        pageSize={30}
      />,
    );
    expect(screen.getByRole('button', { name: /expand tee \(2 sizes\)/i })).toBeInTheDocument();
    expect(bodyRows(container)).toHaveLength(2); // SKU X header, the run
    await userEvent.click(screen.getByRole('button', { name: /expand X \(2 placements\)/i }));
    // X's two rows render under X; the run still holds exactly C and D.
    expect(bodyRows(container)).toHaveLength(4);
    expect(screen.getByRole('button', { name: /expand tee \(2 sizes\)/i })).toBeInTheDocument();
    expect(screen.queryByText(/4 sizes|3 sizes/)).not.toBeInTheDocument();
  });
});

describe('InventoryTable: Group selected in the bulk bar', () => {
  async function selectAll() {
    await userEvent.click(screen.getAllByRole('checkbox')[0]!);
  }

  // Re-pinned by Ungroup anything (owner 2026-10-12; was: "... and Remove for
  // the grouped ones", groupedItemIds handed to the bar's Remove from group):
  // the bar's Ungroup takes the grouped record out of its group. Claim kept:
  // the grouped record is offered a way out of its group from the bar.
  it('offers Group selected for two or more DISTINCT records of one type, and Ungroup for the grouped ones', async () => {
    const items = [row('a', 'A', { ...inGroup('g', 'Pads') }), row('b', 'B'), row('c', 'C')];
    render(
      <InventoryTable
        items={items as never}
        lookups={LOOKUPS}
        total={3}
        initialQuery=""
        pageSize={30}
        canUngroup
      />,
    );
    await selectAll();
    expect([...(spy.groupItemIds ?? [])].sort()).toEqual(['a', 'b', 'c']);
    expect(spy.ungroupItemIds).toEqual(['a']);
    expect(spy.groupingView).toBe('items');
  });

  // Completeness review C3: on success the list opens the new group, so the
  // person sees the records they grouped under its header.
  it('after a grouping the table opens the group it was told about', async () => {
    const items = [
      row('a', 'A', { ...inGroup('g', 'Pads') }),
      row('b', 'B', { ...inGroup('g', 'Pads') }),
    ];
    const { container } = render(
      <InventoryTable
        items={items as never}
        lookups={LOOKUPS}
        total={2}
        initialQuery=""
        pageSize={30}
        canUngroup
      />,
    );
    expect(bodyRows(container)).toHaveLength(1);
    act(() => spy.onGrouped?.('g'));
    expect(bodyRows(container)).toHaveLength(3);
    expect(screen.getByRole('button', { name: /collapse group pads/i })).toBeInTheDocument();
  });

  it('two rack rows of ONE record are one record: not enough to group', async () => {
    const items = [row('a', 'A')];
    render(
      <InventoryTable
        items={
          [
            { ...row('a', 'A'), rowKey: 'a:L1', line_quantity: 1 },
            { ...row('a', 'A'), rowKey: 'a:L2', line_quantity: 3 },
          ] as never
        }
        lookups={LOOKUPS}
        total={items.length}
        initialQuery=""
        pageSize={30}
        canUngroup
      />,
    );
    await selectAll();
    expect(spy.selectedIds).toEqual(['a']);
    expect(spy.groupItemIds ?? []).toEqual([]);
  });

  // People review P3: server mode keeps a selection across pages, so the
  // records picked on an earlier page are not among the loaded rows.
  it('Books in server mode: a selection across two pages is still offered Group selected (P3)', async () => {
    const book = (id: string) => row(id, `BK-${id}`, { item_type: 'book', name: `Book ${id}` });
    const { rerender } = render(
      <InventoryTable
        items={[book('a'), book('b')] as never}
        lookups={LOOKUPS}
        total={60}
        initialQuery=""
        pageSize={30}
        showBookFields
        canUngroup
      />,
    );
    await selectAll();
    rerender(
      <InventoryTable
        items={[book('c'), book('d')] as never}
        lookups={LOOKUPS}
        total={60}
        initialQuery=""
        pageSize={30}
        page={2}
        showBookFields
        canUngroup
      />,
    );
    await selectAll();
    expect([...spy.selectedIds].sort()).toEqual(['a', 'b', 'c', 'd']);
    expect([...(spy.groupItemIds ?? [])].sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(spy.groupingView).toBe('books');
  });

  it('mixed Items and Books are not offered; nor is anything without items:update', async () => {
    const mixed = [row('a', 'A'), row('b', 'B', { item_type: 'book' })];
    const { unmount } = render(
      <InventoryTable
        items={mixed as never}
        lookups={LOOKUPS}
        total={2}
        initialQuery=""
        pageSize={30}
        canUngroup
      />,
    );
    await selectAll();
    expect(spy.groupItemIds ?? []).toEqual([]);
    unmount();
    render(
      <InventoryTable
        items={[row('a', 'A'), row('b', 'B')] as never}
        lookups={LOOKUPS}
        total={2}
        initialQuery=""
        pageSize={30}
      />,
    );
    await selectAll();
    expect(spy.groupItemIds ?? []).toEqual([]);
  });
});

// Owner 2026-10-12, verbatim: "so the picture disapears it should just use the
// first picture of whatever was chosen for the grouping". A group's header
// shows the picture of the FIRST record, in the order the header lists them,
// that has one (thumb or master), and its hover preview shows that record's
// master; with no picture anywhere in the group it keeps the placeholder.
describe('InventoryTable: a group header shows the first picture among its records', () => {
  it('skips records without a picture and shows the first one that has one, thumb in the row and master in the preview', () => {
    const items = [
      row('a', 'GOWN-S', { ...inGroup('g', 'Grad gowns') }),
      row('b', 'GOWN-M', {
        ...inGroup('g', 'Grad gowns'),
        image_url: 'https://img.test/b-master.png',
        image_thumb_url: 'https://img.test/b-thumb.webp',
      }),
      row('c', 'GOWN-L', {
        ...inGroup('g', 'Grad gowns'),
        image_url: 'https://img.test/c-master.png',
        image_thumb_url: 'https://img.test/c-thumb.webp',
      }),
    ];
    const { container } = render(
      <InventoryTable
        items={items as never}
        lookups={LOOKUPS}
        total={3}
        initialQuery=""
        pageSize={30}
      />,
    );
    const header = bodyRows(container)[0] as HTMLElement;
    expect(within(header).getByText('Grad gowns')).toBeInTheDocument();
    expect(header.querySelector('img')?.getAttribute('src')).toBe('https://img.test/b-thumb.webp');
    expect(previews.get('Grad gowns')?.src).toBe('https://img.test/b-master.png');
    expect(previews.get('Grad gowns')?.srcLoader).toBeUndefined();
  });

  it("follows the order the header lists its records in: stored sizes put S before L, so S's picture wins", () => {
    const items = [
      row('l', 'CAP-L', {
        ...inGroup('g', 'Caps'),
        variant_size: 'L',
        image_url: 'https://img.test/l.png',
      }),
      row('s', 'CAP-S', {
        ...inGroup('g', 'Caps'),
        variant_size: 'S',
        image_url: 'https://img.test/s.png',
      }),
    ];
    const { container } = render(
      <InventoryTable
        items={items as never}
        lookups={LOOKUPS}
        total={2}
        initialQuery=""
        pageSize={30}
      />,
    );
    const header = bodyRows(container)[0] as HTMLElement;
    expect(header.querySelector('img')?.getAttribute('src')).toBe('https://img.test/s.png');
    expect(previews.get('Caps')?.src).toBe('https://img.test/s.png');
  });

  it("a thumb-only record's master loads on demand for the preview, from that record", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ url: 'https://img.test/b-master-signed.png' }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const items = [
        row('a', 'A', { ...inGroup('g', 'Pads') }),
        row('thumbonly', 'B', {
          ...inGroup('g', 'Pads'),
          image_thumb_url: 'https://img.test/b-thumb.webp',
        }),
      ];
      const { container } = render(
        <InventoryTable
          items={items as never}
          lookups={LOOKUPS}
          total={2}
          initialQuery=""
          pageSize={30}
        />,
      );
      const header = bodyRows(container)[0] as HTMLElement;
      expect(header.querySelector('img')?.getAttribute('src')).toBe(
        'https://img.test/b-thumb.webp',
      );
      const preview = previews.get('Pads');
      expect(preview?.src).toBeNull();
      expect(preview?.srcLoader).toBeTypeOf('function');
      await expect(preview!.srcLoader!()).resolves.toBe('https://img.test/b-master-signed.png');
      expect(fetchMock).toHaveBeenCalledWith('/api/items/thumbonly/image-master');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps the placeholder when no record in the group has a picture', () => {
    const items = [
      row('a', 'A', { ...inGroup('g', 'Pads') }),
      row('b', 'B', { ...inGroup('g', 'Pads') }),
    ];
    const { container } = render(
      <InventoryTable
        items={items as never}
        lookups={LOOKUPS}
        total={2}
        initialQuery=""
        pageSize={30}
      />,
    );
    const header = bodyRows(container)[0] as HTMLElement;
    expect(header.querySelector('img')).toBeNull();
    expect(previews.get('Pads')?.src).toBeNull();
    expect(previews.get('Pads')?.srcLoader).toBeUndefined();
  });
});
