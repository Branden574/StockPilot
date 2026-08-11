import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// INSTANT-MODE table behavior: full-dataset local derivation, one
// complete answer per keystroke (NO two-phase "(searching…)" pipeline,
// NO /api/items/search fetch), deep-link hydration straight from the
// URL, and pagination via shallow history.pushState instead of a server
// navigation. The pure derivation math itself is pinned in
// lib/inventory/instant-mode.test.ts — this suite covers the component
// wiring.

const { routerMock, getSearchParams } = vi.hoisted(() => {
  const routerMock = {
    replace: vi.fn(),
    push: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  };
  // Stable per search string — mirrors Next, where useSearchParams
  // returns a stable object per navigation (memo deps rely on it).
  let instance = new URLSearchParams('');
  const getSearchParams = (next?: string) => {
    if (next !== undefined && next !== instance.toString()) {
      instance = new URLSearchParams(next);
    }
    return instance;
  };
  return { routerMock, getSearchParams };
});

vi.mock('next/navigation', () => ({
  useRouter: () => routerMock,
  useSearchParams: () => getSearchParams(),
  usePathname: () => '/dashboard/inventory',
}));

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

vi.mock('@/lib/download-export', () => ({
  downloadInventoryExport: vi.fn(),
}));

// Capture the props the table hands to BulkActions so the selection tests
// can assert the DISTINCT item-id set (and thus the "N selected" counter,
// which is selectedIds.length) the actions actually run against.
const { bulkActionsSpy } = vi.hoisted(() => ({
  bulkActionsSpy: { selectedIds: [] as string[] },
}));

vi.mock('@/components/inventory/bulk-actions', () => ({
  BulkActions: (props: { selectedIds: string[] }) => {
    bulkActionsSpy.selectedIds = props.selectedIds;
    return <div data-testid="bulk-actions" data-count={props.selectedIds.length} />;
  },
}));

vi.mock('@/components/ui/image-hover-preview', () => ({
  ImageHoverPreview: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  prewarmPreviewImages: vi.fn(),
}));

vi.mock('@/lib/cycle-counts/use-count-selection', () => ({
  useCountSelection: (selector: (s: { add: () => void }) => unknown) =>
    selector({ add: vi.fn() }),
}));

import {
  InventoryTable,
  rowKeysToItemIds,
  type InstantAdoptedPayload,
  type InstantDatasetItem,
} from './inventory-table';

function item(over: Partial<InstantDatasetItem> & { id: string; name: string }): InstantDatasetItem {
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

const EMPTY_LOOKUPS = {
  categories: new Map<string, { name: string; color: string | null }>(),
  locations: new Map<string, { name: string }>(),
  charters: new Map<string, { name: string; code: string | null }>(),
};

function renderInstant({
  items,
  search = '',
  initialQuery = '',
}: {
  items: InstantDatasetItem[];
  search?: string;
  initialQuery?: string;
}) {
  getSearchParams(search);
  window.history.replaceState(null, '', search ? `/dashboard/inventory?${search}` : '/dashboard/inventory');
  return render(
    <InventoryTable
      items={items}
      lookups={EMPTY_LOOKUPS}
      total={items.length}
      initialQuery={initialQuery}
      pageSize={30}
      instant={{ items, view: 'items' }}
    />,
  );
}

describe('InventoryTable instant mode', () => {
  const fetchSpy = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchSpy);
  });

  it('hydrates a ?q= deep link straight from the dataset — complete footer totals, NO "(searching…)" phase, NO search fetch', () => {
    renderInstant({
      items: [
        item({ id: 'a', name: 'Alpha Widget' }),
        item({ id: 'b', name: 'Beta Gadget' }),
      ],
      search: 'q=alpha',
      initialQuery: 'alpha',
    });

    expect(screen.getByRole('link', { name: 'Alpha Widget' })).toBeInTheDocument();
    expect(screen.queryByText('Beta Gadget')).not.toBeInTheDocument();
    // Complete answer: the buildSumPage-mirror footer, not the
    // "Showing N matching" hedge.
    expect(screen.getByText(/1 SKUs/)).toBeInTheDocument();
    expect(screen.queryByText(/searching…/)).not.toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('search narrows rows on each keystroke with zero network traffic and complete totals', async () => {
    const user = userEvent.setup();
    renderInstant({
      items: [
        item({ id: 'a', name: 'Alpha Widget', unit_cost: 3, quantity_on_hand: 4 }),
        item({ id: 'b', name: 'Beta Gadget' }),
        item({ id: 'c', name: 'Beta Gizmo' }),
      ],
    });

    expect(screen.getByText(/3 SKUs/)).toBeInTheDocument();

    await user.type(screen.getByRole('textbox', { name: /search items/i }), 'beta');

    expect(screen.queryByText('Alpha Widget')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Beta Gadget' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Beta Gizmo' })).toBeInTheDocument();
    expect(screen.getByText(/2 SKUs/)).toBeInTheDocument();
    expect(screen.queryByText(/searching…/)).not.toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
    // No server navigation either — search is fully local.
    expect(routerMock.replace).not.toHaveBeenCalled();
    expect(routerMock.push).not.toHaveBeenCalled();
  });

  it('matches barcode and model_number locally (authoritative field parity with the server q clause)', async () => {
    const user = userEvent.setup();
    renderInstant({
      items: [
        item({ id: 'a', name: 'Alpha Widget', barcode: '9780544336261' }),
        item({ id: 'b', name: 'Beta Gadget', model_number: 'LNY-2000' }),
      ],
    });

    const box = screen.getByRole('textbox', { name: /search items/i });
    await user.type(box, '9780544');
    expect(screen.getByRole('link', { name: 'Alpha Widget' })).toBeInTheDocument();
    expect(screen.queryByText('Beta Gadget')).not.toBeInTheDocument();

    await user.clear(box);
    await user.type(box, 'lny-2000');
    expect(screen.getByRole('link', { name: 'Beta Gadget' })).toBeInTheDocument();
    expect(screen.queryByText('Alpha Widget')).not.toBeInTheDocument();
  });

  it('hydrates a ?status=archived deep link client-side (the dataset carries every status)', () => {
    renderInstant({
      items: [
        item({ id: 'a', name: 'Live Item', status: 'active' }),
        item({ id: 'b', name: 'Old Item', status: 'archived' }),
      ],
      search: 'status=archived',
    });

    expect(screen.getByRole('link', { name: 'Old Item' })).toBeInTheDocument();
    expect(screen.queryByText('Live Item')).not.toBeInTheDocument();
    expect(screen.getByText(/1 SKUs/)).toBeInTheDocument();
  });

  // Task 8: the "Auto-archived" badge + the Archived view's "Auto-archived
  // only" filter chip.
  it('shows the Auto-archived badge only on rows the system archived', () => {
    renderInstant({
      items: [
        item({ id: 'a', name: 'System Archived', status: 'archived', auto_archived: true }),
        item({ id: 'b', name: 'Manually Archived', status: 'archived', auto_archived: false }),
      ],
      search: 'status=archived',
    });

    // Both rows show the base "Archived" badge; only the system-archived
    // row also carries "Auto-archived".
    expect(screen.getAllByText('Archived')).toHaveLength(2);
    expect(screen.getByText('Auto-archived')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'System Archived' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Manually Archived' })).toBeInTheDocument();
  });

  it('does not render the "Auto-archived only" chip outside the Archived view', () => {
    renderInstant({ items: [item({ id: 'a', name: 'Live Item' })] });
    expect(screen.queryByRole('link', { name: 'Auto-archived only' })).not.toBeInTheDocument();
  });

  it('renders the "Auto-archived only" chip (linking to ?auto=1) in the Archived view, unpressed by default', () => {
    renderInstant({
      items: [item({ id: 'a', name: 'Old Item', status: 'archived' })],
      search: 'status=archived',
    });
    const chip = screen.getByRole('link', { name: 'Auto-archived only' });
    expect(chip).toHaveAttribute('href', expect.stringContaining('auto=1'));
    expect(chip).toHaveAttribute('aria-pressed', 'false');
  });

  it('marks the chip pressed and drops the param (not auto=0) once ?auto=1 is set', () => {
    renderInstant({
      items: [item({ id: 'a', name: 'Old Item', status: 'archived' })],
      search: 'status=archived&auto=1',
    });
    const chip = screen.getByRole('link', { name: 'Auto-archived only' });
    expect(chip).toHaveAttribute('aria-pressed', 'true');
    expect(chip).toHaveAttribute('href', expect.not.stringContaining('auto='));
  });

  it('?status=archived&auto=1 deep link narrows to auto_archived rows only', () => {
    renderInstant({
      items: [
        item({ id: 'a', name: 'System Archived', status: 'archived', auto_archived: true }),
        item({ id: 'b', name: 'Manually Archived', status: 'archived', auto_archived: false }),
      ],
      search: 'status=archived&auto=1',
    });

    expect(screen.getByRole('link', { name: 'System Archived' })).toBeInTheDocument();
    expect(screen.queryByText('Manually Archived')).not.toBeInTheDocument();
    expect(screen.getByText(/1 SKUs/)).toBeInTheDocument();
  });

  it('paginates locally: Next → is a shallow history.pushState, never a router navigation', async () => {
    const user = userEvent.setup();
    const many = Array.from({ length: 35 }, (_, i) =>
      item({ id: `i${String(i).padStart(2, '0')}`, name: `Bulk Item ${String(i).padStart(2, '0')}` }),
    );
    renderInstant({ items: many });

    // 35 rows at 30/page → 2 pages, pagination visible.
    expect(screen.getAllByRole('button', { name: /jump to page/i })[0]).toHaveTextContent(
      'Page 1 of 2',
    );

    await user.click(screen.getAllByRole('link', { name: /next/i })[0]!);

    expect(window.location.search).toBe('?page=2');
    expect(routerMock.push).not.toHaveBeenCalled();
    expect(routerMock.replace).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('keeps pagination visible DURING a search (results are complete and paginate like any filter)', async () => {
    const user = userEvent.setup();
    const many = Array.from({ length: 40 }, (_, i) =>
      item({ id: `m${String(i).padStart(2, '0')}`, name: `Match ${String(i).padStart(2, '0')}` }),
    );
    renderInstant({ items: many });

    await user.type(screen.getByRole('textbox', { name: /search items/i }), 'match');

    expect(screen.getByText(/40 SKUs/)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /jump to page/i }).length).toBeGreaterThan(0);
  });

  it('out-of-range ?page= deep links clamp to the last real page instead of rendering an empty window', () => {
    const many = Array.from({ length: 35 }, (_, i) =>
      item({ id: `p${String(i).padStart(2, '0')}`, name: `Paged ${String(i).padStart(2, '0')}` }),
    );
    renderInstant({ items: many, search: 'page=99' });

    expect(screen.queryByText('No items match your filters.')).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /jump to page/i })[0]).toHaveTextContent(
      'Page 2 of 2',
    );
  });

  it('expands placement rows per page when the Items dataset ships holdings (one line per rack)', async () => {
    // CHANGED (Model B / SKU grouping): a SKU with >1 placement now
    // collapses into ONE header row by default — the one-row-per-rack
    // layout only reappears after expanding the group. Was: asserted 2
    // rendered rows with no interaction.
    const user = userEvent.setup();
    getSearchParams('');
    window.history.replaceState(null, '', '/dashboard/inventory');
    const rows = [item({ id: 'a', name: 'Split Item', quantity_on_hand: 500 })];
    render(
      <InventoryTable
        items={rows}
        lookups={EMPTY_LOOKUPS}
        total={1}
        pageSize={30}
        instant={{
          items: rows,
          view: 'items',
          placement: {
            a: [
              { locationId: 'L1', label: '1-A', kind: 'rack', quantity: 250 },
              { locationId: 'L2', label: '2-C', kind: 'rack', quantity: 250 },
            ],
          },
        }}
      />,
    );

    // Collapsed by default: ONE grouped row, headline = the summed total.
    expect(screen.getAllByRole('link', { name: 'Split Item' })).toHaveLength(1);
    expect(screen.getByText('500')).toBeInTheDocument();
    expect(screen.queryByText('1-A')).not.toBeInTheDocument();

    // Expand → one item, two rendered placement rows, one per rack, with
    // per-line labels (the header's own row/link stays visible too).
    await user.click(screen.getByRole('button', { name: /expand/i }));
    expect(screen.getAllByRole('link', { name: 'Split Item' })).toHaveLength(3);
    expect(screen.getByText('1-A')).toBeInTheDocument();
    expect(screen.getByText('2-C')).toBeInTheDocument();
    // Footer terms name what they count: ONE distinct SKU, but TWO
    // rendered rows (the two racks). "rows" must follow the screen.
    expect(screen.getByText(/1 SKUs/)).toBeInTheDocument();
    expect(screen.getByText(/2 rows/)).toBeInTheDocument();
  });

  it('marks staging/unplaced split rows AMBER with an "awaiting put-away" line', async () => {
    // CHANGED (Model B / SKU grouping): expand the collapsed SKU group
    // first — these assertions used to hold with no interaction.
    const user = userEvent.setup();
    getSearchParams('');
    window.history.replaceState(null, '', '/dashboard/inventory');
    const rows = [item({ id: 'b', name: 'Awaiting Item', quantity_on_hand: 8 })];
    render(
      <InventoryTable
        items={rows}
        lookups={EMPTY_LOOKUPS}
        total={1}
        pageSize={30}
        instant={{
          items: rows,
          view: 'items',
          placement: {
            b: [
              { locationId: 'R1', label: 'A1', kind: 'rack', quantity: 5 },
              { locationId: 'S1', label: 'Staging', kind: 'staging', quantity: 2 },
              { locationId: 'U1', label: 'Unplaced', kind: 'unplaced', quantity: 1 },
            ],
          },
        }}
      />,
    );

    await user.click(screen.getByRole('button', { name: /expand/i }));

    // The two not-put-away buckets each surface an "awaiting put-away" line;
    // the placed rack row does not.
    expect(screen.getAllByText('awaiting put-away')).toHaveLength(2);

    // The staging/unplaced RACK-column labels render in the amber warning
    // token; the placed rack label does not.
    const staging = screen.getByText('Staging');
    const unplaced = screen.getByText('Unplaced');
    const placed = screen.getByText('A1');
    expect(staging.className).toContain('text-warning');
    expect(unplaced.className).toContain('text-warning');
    expect(placed.className).not.toContain('text-warning');
  });

  // Model B: same-SKU placements collapse into ONE grouped row with the
  // summed on-hand total, expandable via a chevron. Adapted from the SDD
  // brief's test skeleton to this file's harness (item()/renderInstant/
  // the `placement` map for split rows).
  it('groups placements of one SKU into a single row showing the summed total, expandable', async () => {
    const user = userEvent.setup();
    getSearchParams('');
    window.history.replaceState(null, '', '/dashboard/inventory');
    const rows = [
      item({ id: 'g', name: 'Acer Chromebook', sku: 'SP-G69UU-05H', quantity_on_hand: 281 }),
    ];
    render(
      <InventoryTable
        items={rows}
        lookups={EMPTY_LOOKUPS}
        total={1}
        pageSize={30}
        instant={{
          items: rows,
          view: 'items',
          placement: {
            g: [
              { locationId: 'L1', label: 'CVW-Manchester · 1-A', kind: 'rack', quantity: 75 },
              { locationId: 'L2', label: 'CVLYII-Visalia · 1-C', kind: 'rack', quantity: 100 },
              { locationId: 'L3', label: 'CVSII-Madera · 2-A', kind: 'rack', quantity: 106 },
            ],
          },
        }}
      />,
    );

    // ONE SKU row, headline total 281 (not three separate rows by default).
    expect(screen.getByText('281')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Acer Chromebook' })).toHaveLength(1);
    expect(screen.queryByText('CVW-Manchester · 1-A')).not.toBeInTheDocument();

    // Expand → placements visible.
    await user.click(screen.getByRole('button', { name: /expand|show placements|SP-G69UU-05H/i }));
    expect(screen.getByText('CVW-Manchester · 1-A')).toBeInTheDocument();
    expect(screen.getByText('CVSII-Madera · 2-A')).toBeInTheDocument();
  });

  // `status` is a PER-PLACEMENT field — genuinely distinct inventory_items
  // rows sharing one SKU can have different statuses (e.g. discontinued at
  // one site, active at another). The group-header Status badge must never
  // read as a plain healthy "In stock" when part of the group is
  // discontinued/archived — it must roll up conservatively instead of
  // reading only the first placement (see rollupStatus in group-by-sku.ts).
  it('group header status never shows a plain healthy badge when a placement is discontinued', () => {
    // status=all: the default view filters to active-only, which would
    // hide the discontinued placement entirely rather than exercise the
    // rollup — mirrors the existing "?status=archived deep link" test.
    getSearchParams('status=all');
    window.history.replaceState(null, '', '/dashboard/inventory?status=all');
    const rows = [
      item({ id: 'a', name: 'Mixed Status Widget', sku: 'SKU-MIXED', status: 'active', quantity_on_hand: 100 }),
      item({ id: 'b', name: 'Mixed Status Widget', sku: 'SKU-MIXED', status: 'discontinued', quantity_on_hand: 50 }),
    ];
    render(
      <InventoryTable
        items={rows}
        lookups={EMPTY_LOOKUPS}
        total={2}
        pageSize={30}
        instant={{ items: rows, view: 'items' }}
      />,
    );

    // Collapsed by default: ONE grouped header row for the shared SKU.
    expect(screen.getAllByRole('link', { name: 'Mixed Status Widget' })).toHaveLength(1);
    // The header must surface the discontinued placement, not a healthy
    // "In stock" badge that hides it.
    expect(screen.getByText('Discontinued')).toBeInTheDocument();
    expect(screen.queryByText('In stock')).not.toBeInTheDocument();
  });

  // Model B: a SKU family is the UNIT OF DISPLAY, so it is also the unit
  // of pagination — instant mode packs a whole family onto one page
  // (deriveInstantView → runAwarePages) and the header sums the rows it
  // expands to. Three rows of one SKU with pageSize=2 therefore land on a
  // SINGLE page, header 75 + 100 + 106 = 281.
  // This assertion used to read "Page 1 of 2": the ROWS were already kept
  // together, but the footer derived its page count from
  // ceil(total / pageSize) and advertised a second page that held nothing.
  it('keeps a 3-row SKU family whole on one page and totals all three (footer never advertises an empty page)', () => {
    getSearchParams('');
    window.history.replaceState(null, '', '/dashboard/inventory');
    const rows = [
      item({
        id: 'a',
        name: 'Split Widget',
        sku: 'SP-SPLIT',
        quantity_on_hand: 75,
        updated_at: '2026-01-03T00:00:00+00:00',
      }),
      item({
        id: 'b',
        name: 'Split Widget',
        sku: 'SP-SPLIT',
        quantity_on_hand: 100,
        updated_at: '2026-01-02T00:00:00+00:00',
      }),
      item({
        id: 'c',
        name: 'Split Widget',
        sku: 'SP-SPLIT',
        quantity_on_hand: 106,
        updated_at: '2026-01-01T00:00:00+00:00',
      }),
    ];
    render(
      <InventoryTable
        items={rows}
        lookups={EMPTY_LOOKUPS}
        total={3}
        pageSize={2}
        instant={{ items: rows, view: 'items' }}
      />,
    );

    // One page, so no pagination at all — and certainly not a "Page 1 of 2"
    // whose page 2 would be empty.
    expect(screen.queryByRole('button', { name: /jump to page/i })).not.toBeInTheDocument();

    // Header shows the FULL sum (75 + 100 + 106 = 281), never a
    // page-slice sum (75 + 100 = 175).
    expect(screen.getByText('281')).toBeInTheDocument();
    expect(screen.queryByText('175')).not.toBeInTheDocument();
  });
});

// ── BOOKS: the SAME Model B SKU grouping the Items list has ──────────
// Books were gated out of SKU grouping on the premise that "books never
// split rows". They don't split PLACEMENT rows (the books page passes
// unsplit items), but mig 0234 made SKU uniqueness (organization_id, sku,
// charter_id, bin_location) — so one title legitimately exists as several
// inventory_items rows, one per charter/rack, and the Books list rendered
// the same title several times. These pin both halves of the fix: the
// grouping itself, and the 14-column header layout it has to line up with
// (the books body row emits Grade/Rack/Crate where items emits one Rack
// cell, so a 12-cell header would shift every column right of Location).
describe('InventoryTable books SKU grouping', () => {
  const fetchSpy = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchSpy);
  });

  function renderBooks({
    items,
    search = '',
    total,
    pageSize = 30,
    serverMode = false,
  }: {
    items: InstantDatasetItem[];
    search?: string;
    total?: number;
    pageSize?: number;
    /** Omit the `instant` prop → the degraded server-mode path, where the
     *  table only ever sees the current page and must DISCLOSE a possibly
     *  partial group total rather than present it as complete. */
    serverMode?: boolean;
  }) {
    getSearchParams(search);
    window.history.replaceState(
      null,
      '',
      search ? `/dashboard/books?${search}` : '/dashboard/books',
    );
    return render(
      <InventoryTable
        items={items}
        lookups={EMPTY_LOOKUPS}
        total={total ?? items.length}
        pageSize={pageSize}
        rowLinkPrefix="/dashboard/books"
        basePath="/dashboard/books"
        showBookFields
        {...(serverMode ? {} : { instant: { items, view: 'books' as const } })}
      />,
    );
  }

  /** Two+ inventory_items rows of ONE title — the real L4L North Region
   *  shape ("Into Algebra 1", sp-8n8lr-8nd, 3 rows). */
  function algebraRows(): InstantDatasetItem[] {
    return [
      item({ id: 'a1', name: 'Into Algebra 1', sku: 'sp-8n8lr-8nd', quantity_on_hand: 4 }),
      item({ id: 'a2', name: 'Into Algebra 1', sku: 'sp-8n8lr-8nd', quantity_on_hand: 6 }),
      item({ id: 'a3', name: 'Into Algebra 1', sku: 'sp-8n8lr-8nd', quantity_on_hand: 2 }),
    ];
  }

  const bodyRows = (container: HTMLElement) =>
    Array.from(container.querySelectorAll('tbody tr')) as HTMLTableRowElement[];

  it('collapses several inventory_items rows of ONE book SKU into a single row showing the summed on-hand, expandable', async () => {
    const user = userEvent.setup();
    renderBooks({ items: algebraRows() });

    // ONE row for the title, headline total 4 + 6 + 2 = 12.
    expect(screen.getAllByRole('link', { name: 'Into Algebra 1' })).toHaveLength(1);
    expect(screen.getByText('12')).toBeInTheDocument();

    // Expand → the three underlying rows (plus the header's own link).
    await user.click(screen.getByRole('button', { name: /expand/i }));
    expect(screen.getAllByRole('link', { name: 'Into Algebra 1' })).toHaveLength(4);
    expect(screen.getByText('4')).toBeInTheDocument();
    expect(screen.getByText('6')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  // The structural risk: the books layout is 14 columns, the SKU header
  // was written for the 12-column items layout. A cell-count assertion is
  // the only thing that catches a future column being added to the body
  // but not the header.
  it('books group header emits the SAME 14 cells as a books body row', async () => {
    const user = userEvent.setup();
    const { container } = renderBooks({ items: algebraRows() });

    const collapsed = bodyRows(container);
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0]!.children).toHaveLength(14);

    await user.click(screen.getByRole('button', { name: /expand/i }));
    const expanded = bodyRows(container);
    expect(expanded).toHaveLength(4); // header + 3 placements
    expect(expanded[0]!.children).toHaveLength(14);
    expect(expanded[1]!.children).toHaveLength(14);
  });

  it('items group header still emits 12 cells, matching an items body row (no regression)', async () => {
    const user = userEvent.setup();
    getSearchParams('');
    window.history.replaceState(null, '', '/dashboard/inventory');
    const rows = [
      item({ id: 'i1', name: 'Acer Chromebook', sku: 'SP-G69UU-05H', quantity_on_hand: 75 }),
      item({ id: 'i2', name: 'Acer Chromebook', sku: 'SP-G69UU-05H', quantity_on_hand: 100 }),
    ];
    const { container } = render(
      <InventoryTable
        items={rows}
        lookups={EMPTY_LOOKUPS}
        total={2}
        pageSize={30}
        instant={{ items: rows, view: 'items' }}
      />,
    );

    expect(bodyRows(container)[0]!.children).toHaveLength(12);
    await user.click(screen.getByRole('button', { name: /expand/i }));
    const expanded = bodyRows(container);
    expect(expanded[0]!.children).toHaveLength(12);
    expect(expanded[1]!.children).toHaveLength(12);
  });

  // book_grade lives in custom_fields PER inventory_items row, so two
  // placements of one title can genuinely carry different grades (one
  // graded during a PO import, the other by hand). Showing the first
  // placement's grade as the group's would misfile the title.
  it('grade rolls up: "Multiple" when placements disagree, the shared value when they agree', () => {
    const differing = renderBooks({
      items: [
        item({
          id: 'g1',
          name: 'Persepolis',
          sku: 'SP-THV69-MG8',
          custom_fields: { book_grade: '3' },
        }),
        item({
          id: 'g2',
          name: 'Persepolis',
          sku: 'SP-THV69-MG8',
          custom_fields: { book_grade: '7' },
        }),
      ],
    });
    expect(screen.getByText('Multiple')).toBeInTheDocument();
    expect(screen.queryByText('Gr 3')).not.toBeInTheDocument();
    expect(screen.queryByText('Gr 7')).not.toBeInTheDocument();
    differing.unmount();

    renderBooks({
      items: [
        item({
          id: 'g3',
          name: 'Persepolis',
          sku: 'SP-THV69-MG8',
          custom_fields: { book_grade: '3' },
        }),
        item({
          id: 'g4',
          name: 'Persepolis',
          sku: 'SP-THV69-MG8',
          custom_fields: { book_grade: '3' },
        }),
      ],
    });
    expect(screen.getByText('Gr 3')).toBeInTheDocument();
    expect(screen.queryByText('Multiple')).not.toBeInTheDocument();
  });

  // Rack is the field the owner physically walks to. When placements
  // agree the concrete label beats a count; when they differ, a COUNT is
  // the only honest value — never one placement's rack.
  it('rack rolls up: the shared label when placements agree, "N racks" when they differ', () => {
    const differing = renderBooks({
      items: [
        item({
          id: 'r1',
          name: 'Persepolis',
          sku: 'SP-THV69-MG8',
          custom_fields: { book_rack_number: '38', book_rack_row: 'A' },
        }),
        item({
          id: 'r2',
          name: 'Persepolis',
          sku: 'SP-THV69-MG8',
          custom_fields: { book_rack_number: '12', book_rack_row: 'B' },
        }),
      ],
    });
    expect(screen.getByText('2 racks')).toBeInTheDocument();
    expect(screen.queryByText('38-A')).not.toBeInTheDocument();
    expect(screen.queryByText('12-B')).not.toBeInTheDocument();
    differing.unmount();

    renderBooks({
      items: [
        item({
          id: 'r3',
          name: 'Persepolis',
          sku: 'SP-THV69-MG8',
          custom_fields: { book_rack_number: '38', book_rack_row: 'A' },
        }),
        item({
          id: 'r4',
          name: 'Persepolis',
          sku: 'SP-THV69-MG8',
          custom_fields: { book_rack_number: '38', book_rack_row: 'A' },
        }),
      ],
    });
    expect(screen.getByText('38-A')).toBeInTheDocument();
    expect(screen.queryByText(/racks/)).not.toBeInTheDocument();
  });

  // The crate COLOUR is a visual aid attached to a crate NUMBER — a
  // coloured dot for a group whose placements sit in different crates
  // sends staff to the wrong crate. Never a swatch unless both agree.
  it('crate rolls up: no swatch at all when placements sit in different crates', () => {
    const differing = renderBooks({
      items: [
        item({
          id: 'c1',
          name: 'Persepolis',
          sku: 'SP-THV69-MG8',
          custom_fields: { book_crate_number: '5', book_crate_color: 'red' },
        }),
        item({
          id: 'c2',
          name: 'Persepolis',
          sku: 'SP-THV69-MG8',
          custom_fields: { book_crate_number: '8', book_crate_color: 'red' },
        }),
      ],
    });
    const header = bodyRows(differing.container)[0]!;
    // Crate is col 9 of 14 (0-indexed 8).
    const crateCell = header.children[8] as HTMLElement;
    expect(crateCell.textContent).toBe('Multiple');
    expect(crateCell.querySelectorAll('[style*="background-color"]')).toHaveLength(0);
    differing.unmount();

    const agreeing = renderBooks({
      items: [
        item({
          id: 'c3',
          name: 'Persepolis',
          sku: 'SP-THV69-MG8',
          custom_fields: { book_crate_number: '5', book_crate_color: 'red' },
        }),
        item({
          id: 'c4',
          name: 'Persepolis',
          sku: 'SP-THV69-MG8',
          custom_fields: { book_crate_number: '5', book_crate_color: 'red' },
        }),
      ],
    });
    const agreeCell = bodyRows(agreeing.container)[0]!.children[8] as HTMLElement;
    expect(agreeCell.textContent).toBe('5');
    expect(agreeCell.querySelectorAll('[style*="background-color"]')).toHaveLength(1);
  });

  // Direct book-flavored twin of the items test: a discontinued placement
  // must never hide behind a healthy badge on the collapsed header.
  it('book group header status never shows a plain healthy badge when a placement is discontinued', () => {
    renderBooks({
      items: [
        item({
          id: 's1',
          name: 'Into Algebra 1',
          sku: 'sp-8n8lr-8nd',
          status: 'active',
          quantity_on_hand: 100,
        }),
        item({
          id: 's2',
          name: 'Into Algebra 1',
          sku: 'sp-8n8lr-8nd',
          status: 'discontinued',
          quantity_on_hand: 50,
        }),
      ],
      search: 'status=all',
    });

    expect(screen.getAllByRole('link', { name: 'Into Algebra 1' })).toHaveLength(1);
    expect(screen.getByText('Discontinued')).toBeInTheDocument();
    expect(screen.queryByText('In stock')).not.toBeInTheDocument();
  });

  // The common case must be byte-identical to today: most titles live as
  // exactly one row and must NOT sprout a chevron or a tinted header.
  it('a book SKU with exactly one row renders as a plain row — no chevron, no header treatment', () => {
    const { container } = renderBooks({
      items: [item({ id: 'solo', name: 'Solo Title', sku: 'SP-SOLO-1' })],
    });

    expect(screen.queryByRole('button', { name: /expand/i })).not.toBeInTheDocument();
    const rows = bodyRows(container);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.className).not.toContain('bg-muted/30');
    expect(rows[0]!.children).toHaveLength(14);
  });

  // Books are never sized — groupBySizeRun must stay OFF for them. This
  // pins the gate in `styledRenderItems` that the SKU-grouping fix must
  // not take down with it.
  it('size runs stay OFF for books: distinct-SKU "- L / - XL / - 2XL" titles render as plain rows', () => {
    const { container } = renderBooks({
      items: [
        item({ id: 'z1', name: 'Reader - L', sku: 'SP-READ-L' }),
        item({ id: 'z2', name: 'Reader - XL', sku: 'SP-READ-XL' }),
        item({ id: 'z3', name: 'Reader - 2XL', sku: 'SP-READ-2XL' }),
      ],
    });

    expect(screen.queryByRole('button', { name: /expand/i })).not.toBeInTheDocument();
    expect(bodyRows(container)).toHaveLength(3);
    expect(screen.queryByText(/sizes/)).not.toBeInTheDocument();
  });

  // Bulk actions target PLACEMENTS, never the header — the header has no
  // synthetic row behind it to act on.
  it('the group header carries no checkbox while its placement rows do', async () => {
    const user = userEvent.setup();
    const { container } = renderBooks({ items: algebraRows() });

    const header = bodyRows(container)[0]!;
    expect(header.querySelectorAll('[role="checkbox"]')).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: /expand/i }));
    const placement = bodyRows(container)[1]!;
    expect(placement.querySelectorAll('[role="checkbox"]')).toHaveLength(1);
  });

  // Books inherit the partial-total disclosure unchanged. SERVER mode only
  // ever sees the current page, so a multi-row group on a multi-page list
  // is flagged rather than presented as complete (bug pattern #18).
  it('server mode marks a multi-row book group total as partial with the "*" disclosure', () => {
    const { container } = renderBooks({
      items: [
        item({ id: 'p1', name: 'Into Algebra 1', sku: 'sp-8n8lr-8nd', quantity_on_hand: 4 }),
        item({ id: 'p2', name: 'Into Algebra 1', sku: 'sp-8n8lr-8nd', quantity_on_hand: 6 }),
      ],
      total: 60,
      pageSize: 30,
      serverMode: true,
    });

    expect(screen.getByText('10')).toBeInTheDocument();
    expect(screen.getByText('*')).toBeInTheDocument();
    // On hand is col 10 of 14 (0-indexed 9) and carries the disclosure.
    const onHand = bodyRows(container)[0]!.children[9] as HTMLElement;
    expect(onHand.getAttribute('title')).toContain('only counts placements on the current page');
  });

  // INSTANT mode paginates GROUP-AWARE, so a title's rows are never cut
  // by a page boundary: one header, the true total, no asterisk. Books
  // twin of the "Split Widget" test.
  it('instant mode keeps a book title whole on one page — true total, no "*"', () => {
    renderBooks({ items: algebraRows(), pageSize: 2 });

    expect(screen.queryByRole('button', { name: /jump to page/i })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /expand/i })).toHaveLength(1);
    // 4 + 6 + 2 = 12, not a page-slice 10.
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.queryByText('*')).not.toBeInTheDocument();
  });
});

// ── SKU-GROUP CORRECTNESS, ON BOTH SURFACES ─────────────────────────
// Everything below runs the SAME assertion against the Items list and
// the Books list. The grouping code is shared and the Items list has
// been live on it for weeks — enabling Books did not create these
// defects, it made them common (19 book SKUs in the owner's org have
// several rows, while items rarely straddle a page boundary). A fix
// that only helps Books is not a fix.
describe('InventoryTable SKU-group correctness (Items and Books)', () => {
  const fetchSpy = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchSpy);
    // The stock-view toggle persists in localStorage SHARED by both
    // lists — clear it so one test's toggle never leaks into the next.
    window.localStorage.clear();
  });

  const SURFACES = [
    { label: 'items', books: false, base: '/dashboard/inventory', cells: 12 },
    { label: 'books', books: true, base: '/dashboard/books', cells: 14 },
  ] as const;

  function renderSurface(
    surface: (typeof SURFACES)[number],
    {
      items,
      search = '',
      pageSize = 30,
      lookups = EMPTY_LOOKUPS,
      trends,
      total,
      serverMode = false,
    }: {
      items: InstantDatasetItem[];
      search?: string;
      pageSize?: number;
      lookups?: typeof EMPTY_LOOKUPS;
      trends?: Map<string, { qtySeries: number[]; moveSeries: number[] }>;
      /** Server-mode row total (the view's UNSEARCHED count). */
      total?: number;
      /** Omit the `instant` prop → the degraded server-mode path. */
      serverMode?: boolean;
    },
  ) {
    getSearchParams(search);
    window.history.replaceState(null, '', search ? `${surface.base}?${search}` : surface.base);
    return render(
      <InventoryTable
        items={items}
        lookups={lookups}
        total={total ?? items.length}
        pageSize={pageSize}
        rowLinkPrefix={surface.base}
        basePath={surface.base}
        showBookFields={surface.books}
        trends={trends}
        {...(serverMode
          ? {}
          : { instant: { items, view: surface.books ? ('books' as const) : ('items' as const) } })}
      />,
    );
  }

  const bodyRows = (container: HTMLElement) =>
    Array.from(container.querySelectorAll('tbody tr')) as HTMLTableRowElement[];
  const headerRows = (container: HTMLElement) =>
    bodyRows(container).filter((r) => r.className.includes('bg-muted/30'));
  /** The pagination footer's "Showing X–Y of N" readout (top + bottom
   *  render the same string). */
  const showingText = () =>
    Array.from(document.querySelectorAll('span'))
      .map((s) => s.textContent ?? '')
      .find((t) => /^Showing \d+–\d+ of \d+$/.test(t));

  /** 4 rows of ONE SKU (3 each) newest-first, then 3 unrelated singles.
   *  Under updated_desc the family lands exactly where a fixed
   *  pageSize=2 slice would cut it in half. */
  function familyAtBoundary(): InstantDatasetItem[] {
    return [
      ...[1, 2, 3, 4].map((n) =>
        item({
          id: `f${n}`,
          name: 'Persepolis',
          sku: 'SP-THV69-MG8',
          quantity_on_hand: 3,
          updated_at: `2026-01-${20 - n}T00:00:00+00:00`,
        }),
      ),
      ...[1, 2, 3].map((n) =>
        item({
          id: `s${n}`,
          name: `Single ${n}`,
          sku: `SP-SINGLE-${n}`,
          quantity_on_hand: 1,
          updated_at: `2026-01-0${n}T00:00:00+00:00`,
        }),
      ),
    ];
  }

  describe.each(SURFACES)('$label list', (surface) => {
    // D1. Grouping runs over the CURRENT PAGE SLICE while the header
    // showed the SKU's FULL cross-page total, so every page holding two
    // or more placements rendered its own header claiming ALL the stock —
    // the same title twice, 12 on both. The fix paginates over GROUPS: a
    // family is never cut, so it can only ever produce one header.
    it('never renders a second header for one SKU on another page', () => {
      const rows = familyAtBoundary();

      const page1 = renderSurface(surface, { items: rows, pageSize: 2 });
      const h1 = headerRows(page1.container);
      expect(h1).toHaveLength(1);
      // All four placements, 3 each — not the 2-row page slice.
      expect(h1[0]!.textContent).toContain('12');
      page1.unmount();

      // Every remaining page: the family is gone, no second header.
      for (const p of ['page=2', 'page=3']) {
        const later = renderSurface(surface, { items: rows, search: p, pageSize: 2 });
        expect(headerRows(later.container)).toHaveLength(0);
        expect(screen.queryByText('Persepolis')).not.toBeInTheDocument();
        later.unmount();
      }
    });

    // D1, second half: a page that runs long to keep a family whole must
    // not claim it is showing pageSize rows. Page 1 holds the 4-row
    // family; the footer used to read "Showing 1–2 of 7".
    it('reports the row range the page ACTUALLY covers, not page × pageSize', () => {
      const rows = familyAtBoundary();

      const page1 = renderSurface(surface, { items: rows, pageSize: 2 });
      expect(showingText()).toBe('Showing 1–4 of 7');
      page1.unmount();

      // Page 2 starts after the long page, not at pageSize + 1.
      const page2 = renderSurface(surface, { items: rows, search: 'page=2', pageSize: 2 });
      expect(showingText()).toBe('Showing 5–6 of 7');
      page2.unmount();

      renderSurface(surface, { items: rows, search: 'page=3', pageSize: 2 });
      expect(showingText()).toBe('Showing 7–7 of 7');
    });

    // D2(a). ?expected=1 exists to show items auto-created from a PO that
    // have never received stock (mig 0277). The header dropped the flag,
    // so a title whose rows are ALL expected collapsed into one "Out of
    // stock" badge inside the view whose entire purpose is the opposite.
    it('badges an all-expected group as Expected, not Out of stock', () => {
      const { container } = renderSurface(surface, {
        search: 'expected=1',
        items: [
          item({
            id: 'e1',
            name: 'Into Algebra 1',
            sku: 'sp-8n8lr-8nd',
            quantity_on_hand: 0,
            awaiting_first_receipt: true,
          }),
          item({
            id: 'e2',
            name: 'Into Algebra 1',
            sku: 'sp-8n8lr-8nd',
            quantity_on_hand: 0,
            awaiting_first_receipt: true,
          }),
        ],
      });

      expect(screen.getAllByRole('button', { name: /expand/i })).toHaveLength(1);
      // Scoped to the header's badge cell — "Expected" is also the name
      // of the filter chip in the toolbar.
      const badge = headerRows(container)[0]!.children[surface.cells - 2]!;
      expect(badge.textContent).toBe('Expected');
      expect(badge.textContent).not.toContain('Out of stock');
    });

    // D2(b). Same defect for mig 0266's auto-archive flag — and the
    // every()-not-some() rule: a group where only SOME rows were archived
    // by the system must NOT claim the softer "Auto-archived" reading.
    it('badges an all-auto-archived group Auto-archived, a mixed one plain Archived', () => {
      const archived = (id: string, auto: boolean) =>
        item({
          id,
          name: 'Retired Title',
          sku: 'SP-RETIRED-1',
          status: 'archived',
          quantity_on_hand: 0,
          auto_archived: auto,
        });

      const all = renderSurface(surface, {
        search: 'status=archived',
        items: [archived('x1', true), archived('x2', true)],
      });
      expect(screen.getByText('Auto-archived')).toBeInTheDocument();
      all.unmount();

      renderSurface(surface, {
        search: 'status=archived',
        items: [archived('y1', true), archived('y2', false)],
      });
      expect(screen.getByText('Archived')).toBeInTheDocument();
      expect(screen.queryByText('Auto-archived')).not.toBeInTheDocument();
    });

    // D3. "On hand: placed only" persists in localStorage SHARED by both
    // lists, so flipping it once on Items left Books in placed-only. The
    // header summed TOTAL on-hand while its rows showed PLACED — a header
    // that did not equal the sum of its own children.
    it('header total equals the sum of its rows under BOTH stock-view toggle states', async () => {
      const user = userEvent.setup();
      const { container } = renderSurface(surface, {
        items: [
          item({
            id: 'q1',
            name: 'Persepolis',
            sku: 'SP-THV69-MG8',
            quantity_on_hand: 10,
            placed_quantity: 4,
            unplaced_quantity: 6,
          }),
          item({
            id: 'q2',
            name: 'Persepolis',
            sku: 'SP-THV69-MG8',
            quantity_on_hand: 6,
            placed_quantity: 1,
            unplaced_quantity: 5,
          }),
        ],
      });
      // On hand is the cell right before the coverage bar: 12-cell items
      // layout → index 7, 14-cell books layout → index 9.
      const onHandIdx = surface.cells - 5;
      const headerOnHand = () => headerRows(container)[0]!.children[onHandIdx]!.textContent ?? '';

      // Default (total): 10 + 6.
      expect(headerOnHand()).toContain('16');

      await user.click(screen.getByRole('button', { name: /toggle on-hand view/i }));
      // Placed only: 4 + 1 — the number the expanded rows now show.
      expect(headerOnHand()).toContain('5');
      expect(headerOnHand()).not.toContain('16');

      await user.click(screen.getByRole('button', { name: /expand/i }));
      const placements = bodyRows(container).slice(1);
      const rowSum = placements.reduce(
        (sum, r) =>
          sum + Number((r.children[onHandIdx]!.textContent ?? '').match(/^\d+/)?.[0] ?? 0),
        0,
      );
      expect(rowSum).toBe(5);
    });

    // The common case must stay byte-identical: one placement, no header,
    // no chevron — and the header's cell count must match a body row's
    // exactly (12 items / 14 books) or every column right of Location
    // shifts.
    it('a one-placement SKU renders as a plain row, and a group header matches the body cell count', async () => {
      const user = userEvent.setup();
      const solo = renderSurface(surface, {
        items: [item({ id: 'solo', name: 'Solo', sku: 'SP-SOLO-1' })],
      });
      expect(screen.queryByRole('button', { name: /expand/i })).not.toBeInTheDocument();
      const soloRows = bodyRows(solo.container);
      expect(soloRows).toHaveLength(1);
      expect(soloRows[0]!.className).not.toContain('bg-muted/30');
      expect(soloRows[0]!.children).toHaveLength(surface.cells);
      solo.unmount();

      const { container } = renderSurface(surface, {
        items: [
          item({ id: 'g1', name: 'Pair', sku: 'SP-PAIR-1' }),
          item({ id: 'g2', name: 'Pair', sku: 'SP-PAIR-1' }),
        ],
      });
      await user.click(screen.getByRole('button', { name: /expand/i }));
      for (const row of bodyRows(container)) {
        expect(row.children).toHaveLength(surface.cells);
      }
    });

    // W1 + W2. The on-hand NUMBER follows the "placed only" toggle (it
    // mirrors the body's number cell); the HEALTH cells must NOT — the
    // body's badge/bar read the item's on-hand regardless of the toggle.
    // Applying the display quantity to the badge made a collapsed header
    // read "Out of stock" over rows that every one of them read "In
    // stock".
    it('badge follows the group on-hand, not the placed-only display total', async () => {
      const user = userEvent.setup();
      const { container } = renderSurface(surface, {
        items: [
          item({
            id: 'w1a',
            name: 'Persepolis',
            sku: 'SP-THV69-MG8',
            quantity_on_hand: 10,
            placed_quantity: 0,
            unplaced_quantity: 10,
            updated_at: '2026-01-09T00:00:00+00:00',
          }),
          item({
            id: 'w1b',
            name: 'Persepolis',
            sku: 'SP-THV69-MG8',
            quantity_on_hand: 6,
            placed_quantity: 0,
            unplaced_quantity: 6,
            updated_at: '2026-01-08T00:00:00+00:00',
          }),
        ],
      });
      const onHandIdx = surface.cells - 5;
      const badgeIdx = surface.cells - 2;
      const header = () => headerRows(container)[0]!;

      await user.click(screen.getByRole('button', { name: /toggle on-hand view/i }));
      // Nothing is placed → the NUMBER is 0 (it mirrors the rows).
      expect(header().children[onHandIdx]!.textContent).toContain('0');
      // …but the group holds 16 units, exactly what every row badges.
      expect(header().children[badgeIdx]!.textContent).toBe('In stock');

      await user.click(screen.getByRole('button', { name: /expand/i }));
      for (const row of bodyRows(container).slice(1)) {
        expect(row.children[badgeIdx]!.textContent).toBe('In stock');
      }
    });

    // W3. Every other per-row field is rolled up, but reorder_point was
    // still taken from items[0] — so a group whose FIRST row has no
    // reorder line badged "In stock" while a sibling row with a reorder
    // point of 50 badged "Low stock" right underneath it.
    it('reorder point rolls up: the header never badges healthier than its rows', async () => {
      const user = userEvent.setup();
      const { container } = renderSurface(surface, {
        items: [
          item({
            id: 'w3a',
            name: 'Persepolis',
            sku: 'SP-THV69-MG8',
            quantity_on_hand: 5,
            reorder_point: 0,
            updated_at: '2026-01-09T00:00:00+00:00',
          }),
          item({
            id: 'w3b',
            name: 'Persepolis',
            sku: 'SP-THV69-MG8',
            quantity_on_hand: 5,
            reorder_point: 50,
            updated_at: '2026-01-08T00:00:00+00:00',
          }),
        ],
      });
      const badgeIdx = surface.cells - 2;
      expect(headerRows(container)[0]!.children[badgeIdx]!.textContent).toBe('Low stock');

      await user.click(screen.getByRole('button', { name: /expand/i }));
      const rowBadges = bodyRows(container)
        .slice(1)
        .map((r) => r.children[badgeIdx]!.textContent);
      expect(rowBadges).toContain('Low stock');
    });

    // W4. The header plotted the FIRST placement's 14-day series beside a
    // SUMMED number — one member's trend presented as the group's. Two
    // members moving in OPPOSITE directions must net out flat.
    it('sparkline aggregates the members series instead of plotting the first', () => {
      const rising = [...Array<number>(13).fill(0), 10];
      const falling = [...Array<number>(13).fill(10), 0];
      const { container } = renderSurface(surface, {
        trends: new Map([
          ['w4a', { qtySeries: rising, moveSeries: rising }],
          ['w4b', { qtySeries: falling, moveSeries: falling }],
        ]),
        items: [
          item({
            id: 'w4a',
            name: 'Persepolis',
            sku: 'SP-THV69-MG8',
            updated_at: '2026-01-09T00:00:00+00:00',
          }),
          item({
            id: 'w4b',
            name: 'Persepolis',
            sku: 'SP-THV69-MG8',
            updated_at: '2026-01-08T00:00:00+00:00',
          }),
        ],
      });
      // Sparkline tones itself from first vs last point: 'up' strokes with
      // the accent, a flat series with the neutral ink token. Plotting
      // only 'w4a' (rising) would stroke accent.
      const spark = headerRows(container)[0]!.children[surface.cells - 3]!;
      const stroke = spark.querySelectorAll('path')[1]!.getAttribute('stroke');
      expect(stroke).toBe('var(--ed-ink-3)');
    });

    // W7. The footer counted ITEM ROWS and labelled them "SKUs" — the one
    // number on screen that directly contradicts the collapsing the list
    // just did (47 book rows, 19 headers, "47 SKUs").
    it('footer counts SKUs under the SKUs label, and names the row count separately', () => {
      renderSurface(surface, {
        items: [
          item({ id: 'w7a', name: 'Persepolis', sku: 'SP-THV69-MG8' }),
          item({ id: 'w7b', name: 'Persepolis', sku: 'SP-THV69-MG8' }),
          item({ id: 'w7c', name: 'Persepolis', sku: 'SP-THV69-MG8' }),
          item({ id: 'w7d', name: 'Solo', sku: 'SP-SOLO-1' }),
        ],
      });
      const footer = Array.from(document.querySelectorAll('p'))
        .map((p) => p.textContent ?? '')
        .find((t) => t.includes('SKUs'))!;
      expect(footer).toContain('2 SKUs');
      expect(footer).toContain('4 rows');
      expect(footer).not.toContain('4 SKUs');
    });

    // W6. In SERVER mode the partial-total asterisk keyed off the view's
    // UNSEARCHED total, so an active search whose whole result set is on
    // screen still stamped "other pages may hold more" on every group.
    it('server mode: an active search whose full result set is on screen is not marked partial', async () => {
      const user = userEvent.setup();
      const rows = [
        item({ id: 'w6a', name: 'Persepolis', sku: 'SP-THV69-MG8', quantity_on_hand: 4 }),
        item({ id: 'w6b', name: 'Persepolis', sku: 'SP-THV69-MG8', quantity_on_hand: 6 }),
      ];
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({ items: rows, total: rows.length }),
      });
      const { container } = renderSurface(surface, {
        items: rows,
        total: 600,
        pageSize: 30,
        serverMode: true,
      });

      // Unsearched, 600 rows over many pages → the disclosure is correct.
      expect(headerRows(container)[0]!.textContent).toContain('*');

      await user.type(screen.getByRole('textbox', { name: /search items/i }), 'Persepolis');
      await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalled());
      await vi.waitFor(() => expect(headerRows(container)[0]!.textContent).not.toContain('*'));
    });
  });

  // D5. Category and Location rolling up to "Multiple" are the two rules
  // that change the EXISTING Items list, and they had no coverage at all
  // — so they are asserted HERE, on Items specifically.
  describe('items list: category + location roll up to "Multiple"', () => {
    const LOOKUPS = {
      categories: new Map([
        ['c1', { name: 'Textbooks', color: null }],
        ['c2', { name: 'Devices', color: null }],
      ]),
      locations: new Map([
        ['l1', { name: 'North Region' }],
        ['l2', { name: 'South Region' }],
      ]),
      charters: new Map<string, { name: string; code: string | null }>(),
    };
    // 12-cell items layout: checkbox, name, sku, CATEGORY, charter,
    // LOCATION, N locations, on hand, bar, spark, badge, updated.
    const CATEGORY_CELL = 3;
    const LOCATION_CELL = 5;

    const pair = (over: Partial<InstantDatasetItem>[]) =>
      over.map((o, i) => item({ id: `m${i}`, name: 'Acer Chromebook', sku: 'SP-G69UU-05H', ...o }));

    it('shows "Multiple" when placements sit in different categories, the shared name when they agree', () => {
      const differing = renderSurface(SURFACES[0], {
        lookups: LOOKUPS,
        items: pair([{ category_id: 'c1' }, { category_id: 'c2' }]),
      });
      const cell = headerRows(differing.container)[0]!.children[CATEGORY_CELL]!;
      expect(cell.textContent).toBe('Multiple');
      expect(cell.querySelector('span')?.getAttribute('title')).toContain('multiple categories');
      differing.unmount();

      const agreeing = renderSurface(SURFACES[0], {
        lookups: LOOKUPS,
        items: pair([{ category_id: 'c1' }, { category_id: 'c1' }]),
      });
      expect(headerRows(agreeing.container)[0]!.children[CATEGORY_CELL]!.textContent).toBe(
        'Textbooks',
      );
    });

    it('shows "Multiple" when placements sit at different sites, the shared site when they agree', () => {
      const differing = renderSurface(SURFACES[0], {
        lookups: LOOKUPS,
        items: pair([{ primary_location_id: 'l1' }, { primary_location_id: 'l2' }]),
      });
      const cell = headerRows(differing.container)[0]!.children[LOCATION_CELL]!;
      expect(cell.textContent).toBe('Multiple');
      expect(cell.querySelector('span')?.getAttribute('title')).toContain('multiple sites');
      differing.unmount();

      const agreeing = renderSurface(SURFACES[0], {
        lookups: LOOKUPS,
        items: pair([{ primary_location_id: 'l1' }, { primary_location_id: 'l1' }]),
      });
      expect(headerRows(agreeing.container)[0]!.children[LOCATION_CELL]!.textContent).toBe(
        'North Region',
      );
    });
  });

  // D4. The books Rack cell printed `items.length` racks — a count of
  // PLACEMENTS. Three placements sharing two racks read "3 racks" while
  // the tooltip beside it correctly listed only "38-A, 12-B".
  describe('books list: the Rack cell counts DISTINCT racks', () => {
    const RACK_CELL = 7; // 14-cell books layout: ..., grade(6), RACK(7), crate(8)
    const rack = (id: string, number: string | null, row: string | null) =>
      item({
        id,
        name: 'Persepolis',
        sku: 'SP-THV69-MG8',
        custom_fields:
          number == null
            ? {}
            : { book_rack_number: number, ...(row ? { book_rack_row: row } : {}) },
      });

    it('counts racks, not placements', () => {
      const { container } = renderSurface(SURFACES[1], {
        items: [rack('k1', '38', 'A'), rack('k2', '38', 'A'), rack('k3', '12', 'B')],
      });
      const cell = headerRows(container)[0]!.children[RACK_CELL]!;
      expect(cell.textContent).toBe('2 racks');
      expect(cell.querySelector('span')?.getAttribute('title')).toBe('Placements span: 38-A, 12-B');
    });

    it('discloses placements with no rack set instead of counting them as a rack', () => {
      const { container } = renderSurface(SURFACES[1], {
        items: [rack('n1', '38', 'A'), rack('n2', '12', 'B'), rack('n3', null, null)],
      });
      const cell = headerRows(container)[0]!.children[RACK_CELL]!;
      expect(cell.textContent).toBe('2 racks +1 unset');
      expect(cell.querySelector('span')?.getAttribute('title')).toContain('+1 with no rack set');
    });
  });

  // W5. D4 was fixed on Books only. The ITEMS header's twin cell still
  // printed `items.length` — a count of placement ROWS — under the label
  // "locations". Same fix, same shape.
  describe('items list: the "N locations" cell counts DISTINCT racks', () => {
    const LOCATIONS_CELL = 6; // 12-cell items layout: ..., location(5), N LOCATIONS(6)
    const shelf = (id: string, number: string | null, row: string | null) =>
      item({
        id,
        name: 'Acer Chromebook',
        sku: 'SP-G69UU-05H',
        custom_fields:
          number == null ? {} : { rack_number: number, ...(row ? { rack_row: row } : {}) },
      });

    it('counts racks, not placement rows', () => {
      const { container } = renderSurface(SURFACES[0], {
        items: [shelf('i1', '38', 'A'), shelf('i2', '38', 'A'), shelf('i3', '12', 'B')],
      });
      const cell = headerRows(container)[0]!.children[LOCATIONS_CELL]!;
      expect(cell.textContent).toBe('2 locations');
      expect(cell.querySelector('span')?.getAttribute('title')).toBe('Placements span: 38-A, 12-B');
    });

    it('discloses rows with no rack set instead of counting them as a location', () => {
      const { container } = renderSurface(SURFACES[0], {
        items: [shelf('j1', '38', 'A'), shelf('j2', '12', 'B'), shelf('j3', null, null)],
      });
      const cell = headerRows(container)[0]!.children[LOCATIONS_CELL]!;
      expect(cell.textContent).toBe('2 locations +1 unset');
      expect(cell.querySelector('span')?.getAttribute('title')).toContain('+1 with no rack set');
    });
  });
});

// FIRST-ROWS-FIRST STREAMING (React 19 use() handoff): the default view
// mounts in server mode with the 30-row payload while the full dataset
// streams behind as `instantPromise`. An invisible <InstantDatasetAdopter>
// reads it with React.use() and adopts it into the STILL-MOUNTED table
// (no `.then().catch()` effect — that was the reverted crash, pattern
// #15). HARD CONTRACT under test:
//   (a) the server rows are visible before the dataset settles,
//   (b) once the dataset lands the table flips into instant mode and an
//       in-progress search re-derives over the FULL dataset — the search
//       box survives because the table instance never remounts,
//   (c) a null resolution (over-cap org / loader failure) leaves the
//       table in plain server mode, where search keeps routing to
//       /api/items/search.
describe('InventoryTable streamed instant adoption (use() handoff)', () => {
  const fetchSpy = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchSpy);
  });

  function renderStreaming(promise: Promise<InstantAdoptedPayload | null>) {
    getSearchParams('');
    window.history.replaceState(null, '', '/dashboard/inventory');
    const pageRows = [
      item({ id: 'a', name: 'Alpha Widget' }),
      item({ id: 'b', name: 'Beta Gadget' }),
    ];
    return render(
      <InventoryTable
        items={pageRows}
        lookups={EMPTY_LOOKUPS}
        total={2}
        pageSize={30}
        instantPromise={promise}
      />,
    );
  }

  it('renders the server rows immediately, then re-derives an in-progress search over the FULL dataset once it lands (search box preserved — the table never remounts)', async () => {
    const user = userEvent.setup();
    let resolvePayload!: (p: InstantAdoptedPayload | null) => void;
    const promise = new Promise<InstantAdoptedPayload | null>((resolve) => {
      resolvePayload = resolve;
    });
    renderStreaming(promise);

    // (a) first-paint rows visible while the dataset is still pending.
    expect(screen.getByRole('link', { name: 'Alpha Widget' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Beta Gadget' })).toBeInTheDocument();

    // Type during the gap: local narrowing gives immediate feedback.
    const box = screen.getByRole('textbox', { name: /search items/i });
    await user.type(box, 'beta');
    expect(screen.getByRole('link', { name: 'Beta Gadget' })).toBeInTheDocument();
    expect(screen.queryByText('Alpha Widget')).not.toBeInTheDocument();

    // (b) dataset lands (includes an OFF-PAGE row the 30-row payload never
    // had) → the PRESERVED q='beta' now derives over the FULL dataset with
    // complete instant-mode totals, and the search box still reads 'beta'
    // (proving the table instance was never torn down and re-mounted).
    resolvePayload({
      items: [
        item({ id: 'a', name: 'Alpha Widget' }),
        item({ id: 'b', name: 'Beta Gadget' }),
        item({ id: 'c', name: 'Beta Offpage' }),
      ],
      view: 'items',
    });
    expect(await screen.findByRole('link', { name: 'Beta Offpage' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Beta Gadget' })).toBeInTheDocument();
    expect(screen.queryByText('Alpha Widget')).not.toBeInTheDocument();
    expect(box).toHaveValue('beta');
    expect(screen.getByText(/2 SKUs/)).toBeInTheDocument();
    expect(screen.queryByText(/searching…/)).not.toBeInTheDocument();
  });

  // REWRITTEN (not weakened). This test used to hand `renderStreaming` an
  // ALREADY-RESOLVED promise and then assert "2 SKUs" as proof the table
  // had flipped to instant mode. Neither half held: an already-settled
  // promise passed at first render never pings the Suspense boundary in
  // this environment, so adoption never ran — and server mode ALSO
  // printed "2 SKUs" for its 2-row total, so the assertion passed on the
  // pre-adoption footer. It could not have failed. It now resolves the
  // promise AFTER first paint (the sibling test's pattern, which is also
  // what streaming does in production) and asserts a string only instant
  // mode produces, so it fails if adoption stops happening.
  it('adopts the streamed dataset with no URL state: the visible rows stay identical (30-row payload IS page 1 of the derivation)', async () => {
    let resolvePayload!: (p: InstantAdoptedPayload | null) => void;
    const promise = new Promise<InstantAdoptedPayload | null>((resolve) => {
      resolvePayload = resolve;
    });
    getSearchParams('');
    window.history.replaceState(null, '', '/dashboard/inventory');
    const pageRows = [
      item({ id: 'a', name: 'Alpha Widget' }),
      item({ id: 'b', name: 'Beta Gadget' }),
    ];
    const tree = (
      <InventoryTable
        items={pageRows}
        lookups={EMPTY_LOOKUPS}
        total={2}
        pageSize={30}
        instantPromise={promise}
      />
    );
    const { rerender } = render(tree);

    // Pre-adoption: server mode, labelling its ITEM-ROW total honestly.
    expect(await screen.findByText(/2 items ·/)).toBeInTheDocument();

    await act(async () => {
      resolvePayload({
        items: [item({ id: 'a', name: 'Alpha Widget' }), item({ id: 'b', name: 'Beta Gadget' })],
        view: 'items',
      } satisfies InstantAdoptedPayload);
    });
    // jsdom/React-act quirk, NOT a product behaviour: a promise resolved
    // outside a render pass does not ping the suspended boundary here, so
    // `use()` only unblocks on the next render. Production streams the
    // payload as an RSC-tracked promise and needs no nudge. Re-render the
    // IDENTICAL tree (no prop changes) to supply that pass.
    rerender(tree);

    // Post-adoption the footer flips to the complete instant totals — the
    // "SKUs" label is reachable ONLY in instant mode, so this now fails if
    // adoption stops happening.
    expect(await screen.findByText(/2 SKUs/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Alpha Widget' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Beta Gadget' })).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('null resolution (over-cap org / loader failure) leaves the table in plain server mode — search still routes to /api/items/search', async () => {
    const user = userEvent.setup();
    renderStreaming(Promise.resolve(null));

    // Server rows present; the null adoption is a no-op (no instant flip).
    expect(await screen.findByRole('link', { name: 'Alpha Widget' })).toBeInTheDocument();

    // A search now takes today's server path (instant mode never engaged).
    await user.type(screen.getByRole('textbox', { name: /search items/i }), 'beta');
    await vi.waitFor(() => {
      expect(fetchSpy).toHaveBeenCalled();
    });
    const calledUrl = String(fetchSpy.mock.calls[0]![0]);
    expect(calledUrl).toContain('/api/items/search');
    expect(calledUrl).toContain('q=beta');
  });
});

// PER-RACK-ROW SELECTION. The Items list splits one item into one table row
// per holding location (rowKey = `${item.id}:${locationId}`). Selection keys
// on rowKey so checking ONE rack row doesn't visually check the item's OTHER
// rack rows (owner's "both Acer Chromebook rows checked, bar says 1
// selected"). But every bulk action is item-level, so the selected rowKeys
// collapse back to DISTINCT item ids at the BulkActions boundary — and the
// "N selected" counter (selectedIds.length) reflects that distinct-item
// count, matching the true scope of the action.
describe('InventoryTable per-rack-row selection', () => {
  const fetchSpy = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    bulkActionsSpy.selectedIds = [];
    vi.stubGlobal('fetch', fetchSpy);
  });

  // One item ('a') sitting in two racks (1-C @ L1, 2-C @ L2) → two split rows.
  function renderTwoRacks() {
    getSearchParams('');
    window.history.replaceState(null, '', '/dashboard/inventory');
    const rows = [item({ id: 'a', name: 'Acer Chromebook 511', quantity_on_hand: 20 })];
    return render(
      <InventoryTable
        items={rows}
        lookups={EMPTY_LOOKUPS}
        total={1}
        pageSize={30}
        instant={{
          items: rows,
          view: 'items',
          placement: {
            a: [
              { locationId: 'L1', label: '1-C', kind: 'rack', quantity: 10 },
              { locationId: 'L2', label: '2-C', kind: 'rack', quantity: 10 },
            ],
          },
        }}
      />,
    );
  }

  it('checking one rack row marks ONLY that row — not the same item’s other rack row', async () => {
    // CHANGED (Model B / SKU grouping): the two rack rows now sit behind
    // a collapsed SKU-group header — expand it first to reach their
    // checkboxes (the header itself is never selectable, so the total
    // checkbox count is unchanged: select-all + the 2 rack checkboxes).
    const user = userEvent.setup();
    renderTwoRacks();

    await user.click(screen.getByRole('button', { name: /expand/i }));

    // Header's own row link + two split rows for the one SKU.
    expect(screen.getAllByRole('link', { name: 'Acer Chromebook 511' })).toHaveLength(3);

    // Checkboxes: [0] = header select-all, [1] = rack 1-C, [2] = rack 2-C.
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes).toHaveLength(3);
    const [, rack1C, rack2C] = boxes;

    // Click rack 1-C only.
    await user.click(rack1C!);

    // ONLY 1-C reads checked; 2-C (same item.id, different rowKey) stays
    // unchecked. This is the bug fix: before, both rack rows co-checked
    // because selection keyed on item.id.
    expect(rack1C).toHaveAttribute('aria-checked', 'true');
    expect(rack2C).toHaveAttribute('aria-checked', 'false');
  });

  it('selecting BOTH racks of ONE item resolves to a single distinct item id — archive/label/export affect 1 item, counter reads 1', async () => {
    // CHANGED (Model B / SKU grouping): expand the collapsed SKU group
    // first to reach the two rack checkboxes.
    const user = userEvent.setup();
    renderTwoRacks();

    await user.click(screen.getByRole('button', { name: /expand/i }));

    const [, rack1C, rack2C] = screen.getAllByRole('checkbox');

    await user.click(rack1C!);
    await user.click(rack2C!);

    // Both rack rows are visually checked…
    expect(rack1C).toHaveAttribute('aria-checked', 'true');
    expect(rack2C).toHaveAttribute('aria-checked', 'true');

    // …yet the item-level action id set (what archive/labels/export/PO/
    // cycle-count run against) and the "N selected" counter are ONE item.
    expect(bulkActionsSpy.selectedIds).toEqual(['a']);
    expect(screen.getByTestId('bulk-actions')).toHaveAttribute('data-count', '1');
  });
});

describe('rowKeysToItemIds', () => {
  it('strips the :locationId suffix and dedupes to distinct item ids (order-stable)', () => {
    expect(rowKeysToItemIds(['id1:locA', 'id1:locB', 'id2:locC'])).toEqual(['id1', 'id2']);
  });

  it('passes bare item-id keys (no colon — a zero-holding row) straight through', () => {
    expect(rowKeysToItemIds(['id1', 'id2'])).toEqual(['id1', 'id2']);
  });

  it('handles a mix of split and bare keys, preserving first-seen order', () => {
    expect(rowKeysToItemIds(['id2:locA', 'id1', 'id2:locB', 'id1'])).toEqual(['id2', 'id1']);
  });

  it('splits on the FIRST colon only (UUID item ids never contain a colon)', () => {
    const uuid = '71b27a4a-7948-4638-bc3f-535974713bd2';
    expect(rowKeysToItemIds([`${uuid}:loc-1`, `${uuid}:loc-2`])).toEqual([uuid]);
  });
});

// ── THE THREE COUNTS ────────────────────────────────────────────────
// This list has three different populations — ITEM ROWS (inventory_items
// rows; Model B lets one SKU be several), PLACEMENT ROWS (what the Items
// list renders: one line per holding), and DISTINCT SKUs (the top-level
// lines after collapsing) — and the previous round labelled them
// interchangeably. Every test below pins ONE label or ONE marker to the
// count it is actually allowed to use. Two of them (W-A, W-C) cover the
// Items list, which has been live for weeks.
describe('InventoryTable count vocabulary (SKUs vs item rows vs placement rows)', () => {
  const fetchSpy = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchSpy);
    window.localStorage.clear();
  });

  const bodyRows = (container: HTMLElement) =>
    Array.from(container.querySelectorAll('tbody tr')) as HTMLTableRowElement[];
  const headerRows = (container: HTMLElement) =>
    bodyRows(container).filter((r) => r.className.includes('bg-muted/30'));
  const footerText = () =>
    Array.from(document.querySelectorAll('p'))
      .map((p) => p.textContent ?? '')
      .find((t) => t.includes('on hand'))!;
  /** The coverage bar's fill percentage inside one rendered row. The
   *  outer track carries the fixed 80px width; its single child is the
   *  fill, whose inline width IS stock/par. */
  const barFillPct = (row: HTMLElement): string | undefined => {
    const track = row.querySelector('span[style*="width: 80px"]');
    return (track?.firstElementChild as HTMLElement | null)?.style.width;
  };

  // W-A. "{n} rows" printed `effectiveTotal`, an ITEM-ROW count, on the
  // one surface where item rows and rendered rows differ: the Items list
  // expands each item into one row per rack. Two items, one of them split
  // across two racks, RENDER three rows — the footer said two, and (since
  // two also equalled the SKU count) suppressed the term entirely.
  it('items list: the "rows" term counts PLACEMENT rows actually rendered, not item rows', () => {
    getSearchParams('');
    window.history.replaceState(null, '', '/dashboard/inventory');
    const rows = [
      item({ id: 'va', name: 'Split Widget', sku: 'SP-SPLIT', quantity_on_hand: 500 }),
      item({ id: 'vb', name: 'Solo Widget', sku: 'SP-SOLO', quantity_on_hand: 7 }),
    ];
    render(
      <InventoryTable
        items={rows}
        lookups={EMPTY_LOOKUPS}
        total={rows.length}
        pageSize={30}
        instant={{
          items: rows,
          view: 'items',
          placement: {
            va: [
              { locationId: 'L1', label: '1-A', kind: 'rack', quantity: 250 },
              { locationId: 'L2', label: '2-C', kind: 'rack', quantity: 250 },
            ],
          },
        }}
      />,
    );

    const footer = footerText();
    expect(footer).toContain('2 SKUs');
    // 2 item rows, but 3 rendered rows (va's two racks + vb's fallback).
    expect(footer).toContain('3 rows');
    expect(footer).not.toContain('2 rows');
  });

  // W-B. W7 was fixed only in the instant-mode footer. Server mode still
  // printed "{total} SKUs" over an ITEM-ROW count — newly reachable on
  // Books, where grouping is now on and one title is several rows.
  it('server mode labels its item-row total "items", never "SKUs" (it cannot count SKUs set-wide)', () => {
    getSearchParams('');
    window.history.replaceState(null, '', '/dashboard/books');
    render(
      <InventoryTable
        items={[
          item({ id: 'sb1', name: 'Into Algebra 1', sku: 'sp-8n8lr-8nd', quantity_on_hand: 4 }),
          item({ id: 'sb2', name: 'Into Algebra 1', sku: 'sp-8n8lr-8nd', quantity_on_hand: 6 }),
        ]}
        lookups={EMPTY_LOOKUPS}
        total={60}
        pageSize={30}
        rowLinkPrefix="/dashboard/books"
        basePath="/dashboard/books"
        showBookFields
      />,
    );

    const footer = footerText();
    expect(footer).toContain('60 items');
    expect(footer).not.toContain('SKUs');
  });

  // W-C. The server-mode partial marker keyed off `placements.length`, a
  // PLACEMENT-row count. ONE item split across two racks is a single
  // paginated unit — it cannot straddle a page — yet it was stamped with
  // a "*" and an "other pages may hold more of this SKU" tooltip. Live
  // Items-list defect.
  it('server mode: one item split across racks is never marked partial (it is one paginated unit)', () => {
    getSearchParams('');
    window.history.replaceState(null, '', '/dashboard/inventory');
    // Server mode receives rows ALREADY placement-expanded by the page:
    // same item id, one row per holding.
    const base = item({ id: 'pc1', name: 'Split Widget', sku: 'SP-SPLIT', quantity_on_hand: 10 });
    const { container } = render(
      <InventoryTable
        items={[
          { ...base, rowKey: 'pc1:L1', line_quantity: 4, placement_label: '1-A' },
          { ...base, rowKey: 'pc1:L2', line_quantity: 6, placement_label: '2-C' },
        ]}
        lookups={EMPTY_LOOKUPS}
        total={60}
        pageSize={30}
      />,
    );

    expect(headerRows(container)).toHaveLength(1);
    expect(screen.getByText('10')).toBeInTheDocument();
    expect(screen.queryByText('*')).not.toBeInTheDocument();
  });

  // W-C, other half: a group of TWO DIFFERENT item rows on a multi-page
  // server-mode result genuinely could straddle a boundary, so the
  // disclosure must still appear. (Guards the fix from over-reaching.)
  it('server mode: a multi-ITEM-row group on a multi-page result is still disclosed as partial', () => {
    getSearchParams('');
    window.history.replaceState(null, '', '/dashboard/inventory');
    const { container } = render(
      <InventoryTable
        items={[
          item({ id: 'pd1', name: 'Split Widget', sku: 'SP-SPLIT', quantity_on_hand: 4 }),
          item({ id: 'pd2', name: 'Split Widget', sku: 'SP-SPLIT', quantity_on_hand: 6 }),
        ]}
        lookups={EMPTY_LOOKUPS}
        total={60}
        pageSize={30}
      />,
    );

    expect(headerRows(container)).toHaveLength(1);
    expect(screen.getByText('*')).toBeInTheDocument();
  });

  // W-D. The split detector counted the full set under the TRIMMED sku
  // while the groups were keyed on the RAW one, so whitespace-variant
  // SKUs shared a single full-set count of 4 that each 2-row group then
  // compared its 2 against — a false "*" and a false "other pages may
  // hold more" tooltip on groups whose every row was on screen.
  it('instant mode: whitespace-variant SKUs are separate groups and neither is falsely marked partial', () => {
    getSearchParams('');
    window.history.replaceState(null, '', '/dashboard/inventory');
    const rows = [
      item({ id: 'wd1', name: 'Alpha', sku: 'ABC', quantity_on_hand: 1 }),
      item({ id: 'wd2', name: 'Alpha', sku: 'ABC', quantity_on_hand: 1 }),
      item({ id: 'wd3', name: 'Alpha', sku: ' ABC', quantity_on_hand: 1 }),
      item({ id: 'wd4', name: 'Alpha', sku: ' ABC', quantity_on_hand: 1 }),
    ];
    const { container } = render(
      <InventoryTable
        items={rows}
        lookups={EMPTY_LOOKUPS}
        total={rows.length}
        pageSize={30}
        instant={{ items: rows, view: 'items' }}
      />,
    );

    // Two distinct top-level lines (the body groups on the raw sku), and
    // the footer's SKU count agrees with them.
    expect(headerRows(container)).toHaveLength(2);
    expect(footerText()).toContain('2 SKUs');
    expect(screen.queryByText('*')).not.toBeInTheDocument();
  });

  // W-E. The header's coverage bar built its par from `healthQuantity`
  // (on-hand MINUS reserved) while every body row builds it from raw
  // on-hand. In the rentals view (the only place reserved is non-zero)
  // the header therefore filled to a different fraction than the rows it
  // summarises.
  it('header coverage bar fills to the same fraction as its rows when stock is reserved', async () => {
    const user = userEvent.setup();
    getSearchParams('');
    window.history.replaceState(null, '', '/dashboard/inventory');
    const rows = [
      item({ id: 're1', name: 'Rental Widget', sku: 'SP-RENT', quantity_on_hand: 100 }),
      item({ id: 're2', name: 'Rental Widget', sku: 'SP-RENT', quantity_on_hand: 100 }),
    ];
    const { container } = render(
      <InventoryTable
        items={rows}
        lookups={EMPTY_LOOKUPS}
        total={rows.length}
        pageSize={30}
        instant={{ items: rows, view: 'items' }}
        reservedByItem={
          new Map([
            ['re1', 50],
            ['re2', 50],
          ])
        }
      />,
    );

    const header = headerRows(container)[0]!;
    await user.click(screen.getByRole('button', { name: /expand/i }));
    const row = bodyRows(container).find((r) => !r.className.includes('bg-muted/30'))!;

    // Body: available 50 / par max(0, 100×1.5, 10) = 150 → 33.33%.
    // Header must summarise at the SAME fraction (100 / 300), not 66.67%.
    expect(barFillPct(row)).toBeDefined();
    expect(barFillPct(header)).toBe(barFillPct(row));
  });
});

// Task 18 — stored product groups become the PRIMARY grouping signal for the
// inventory list, with the name heuristic demoted to the fallback that still
// serves every ungrouped org.
describe('InventoryTable — size runs keyed on a stored product group', () => {
  const bodyRows = (container: HTMLElement) =>
    Array.from(container.querySelectorAll('tbody tr')) as HTMLTableRowElement[];

  function renderGrouped({
    items,
    productGroupUnits,
  }: {
    items: InstantDatasetItem[];
    productGroupUnits?: Record<string, string>;
  }) {
    getSearchParams('');
    window.history.replaceState(null, '', '/dashboard/inventory');
    return render(
      <InventoryTable
        items={items}
        lookups={EMPTY_LOOKUPS}
        total={items.length}
        pageSize={30}
        instant={{ items, view: 'items' }}
        productGroupUnits={productGroupUnits}
      />,
    );
  }

  // The exact case a name regex can never serve: three real variants of one
  // shoe, identically named, differing only by variant_size.
  const pegasus = (): InstantDatasetItem[] => [
    item({ id: 'p10', name: 'Nike Pegasus 41', sku: 'PEG-10', quantity_on_hand: 20, group_id: 'grp-1', variant_size: '10' }),
    item({ id: 'p9', name: 'Nike Pegasus 41', sku: 'PEG-9', quantity_on_hand: 32, group_id: 'grp-1', variant_size: '9' }),
  ];

  it('collapses identically-named variants that share a group_id, and says so in the group vocabulary', () => {
    renderGrouped({ items: pegasus() });
    expect(screen.getByRole('button', { name: /expand nike pegasus 41 \(2 variants\)/i })).toBeInTheDocument();
    // "sizes" is the weaker, name-derived claim — never used for a real group.
    expect(screen.queryByText(/2 sizes/)).not.toBeInTheDocument();
  });

  it('states the roll-up in the group counting unit when the page resolved one', () => {
    renderGrouped({ items: pegasus(), productGroupUnits: { 'grp-1': 'pair' } });
    // Rendered on the header chip AND in the hover-preview subtitle — both
    // are the same claim, so assert it appears rather than that it is unique.
    expect(screen.getAllByText('2 variants · 52 pairs total').length).toBeGreaterThan(0);
  });

  // ── The group header's Rack cell ──────────────────────────────────────
  // This cell used to render the size label, so the Rack column read
  // "2 variants - 52 pairs total" and said nothing about where the stock is.
  // Asserted through the RACK COLUMN specifically (by cell index), because the
  // size label legitimately still appears elsewhere in the row.
  function headerRackCell(container: HTMLElement): string {
    const cells = bodyRows(container)[0]!.querySelectorAll('td');
    // checkbox, Item, SKU, Category, Charter, Location, Rack -> index 6
    return cells[6]?.textContent?.trim() ?? '';
  }

  it('shows the concrete rack in the header when every variant sits in the same one', () => {
    const { container } = renderGrouped({
      items: [
        item({ id: 'p9', name: 'Nike Pegasus 41', sku: 'PEG-9', group_id: 'grp-1', variant_size: '9', placed_racks: ['31-B'] }),
        item({ id: 'p10', name: 'Nike Pegasus 41', sku: 'PEG-10', group_id: 'grp-1', variant_size: '10', placed_racks: ['31-B'] }),
      ],
    });

    expect(headerRackCell(container)).toBe('31-B');
  });

  it('shows a COUNT, never one variant\'s rack, when placements differ', () => {
    const { container } = renderGrouped({
      items: [
        item({ id: 'p9', name: 'Nike Pegasus 41', sku: 'PEG-9', group_id: 'grp-1', variant_size: '9', placed_racks: ['31-B'] }),
        item({ id: 'p10', name: 'Nike Pegasus 41', sku: 'PEG-10', group_id: 'grp-1', variant_size: '10', placed_racks: ['Z9'] }),
      ],
    });

    const cell = headerRackCell(container);
    expect(cell).toBe('2 racks');
    // The honesty property: naming one of them would send staff to the wrong shelf.
    expect(cell).not.toContain('31-B');
    expect(cell).not.toContain('Z9');
  });

  it('counts variants with no rack separately rather than folding them into the rack count', () => {
    const { container } = renderGrouped({
      items: [
        item({ id: 'p9', name: 'Nike Pegasus 41', sku: 'PEG-9', group_id: 'grp-1', variant_size: '9', placed_racks: ['31-B'] }),
        item({ id: 'p10', name: 'Nike Pegasus 41', sku: 'PEG-10', group_id: 'grp-1', variant_size: '10', placed_racks: [] }),
      ],
    });

    // One real rack plus one unplaced variant: "1 rack +1 unset", never "2 racks".
    expect(headerRackCell(container)).toBe('1 rack +1 unset');
  });

  it('shows a dash when nothing in the run is placed', () => {
    const { container } = renderGrouped({
      items: [
        item({ id: 'p9', name: 'Nike Pegasus 41', sku: 'PEG-9', group_id: 'grp-1', variant_size: '9', placed_racks: [] }),
        item({ id: 'p10', name: 'Nike Pegasus 41', sku: 'PEG-10', group_id: 'grp-1', variant_size: '10', placed_racks: [] }),
      ],
    });

    expect(headerRackCell(container)).toBe('\u2014');
  });

  it('does NOT repeat the size roll-up in the Rack column', () => {
    const { container } = renderGrouped({
      items: pegasus(),
      productGroupUnits: { 'grp-1': 'pair' },
    });

    expect(headerRackCell(container)).not.toContain('variants');
    expect(headerRackCell(container)).not.toContain('pairs total');
  });

  // ── Header label vs header link ───────────────────────────────────────
  it('labels the header with the SAME variant it links to', () => {
    // Arrival order 9 then 8 is not size order, and a stored run is size-sorted,
    // so the label used to come from one variant while the link went to another.
    const { container } = renderGrouped({
      items: [
        item({ id: 'nine', name: 'Court Shoe - 9', sku: 'CS-9', group_id: 'grp-9', variant_size: '9' }),
        item({ id: 'eight', name: 'Court Shoe - 8', sku: 'CS-8', group_id: 'grp-9', variant_size: '8' }),
      ],
    });

    const header = bodyRows(container)[0]!;
    const link = header.querySelector('a[href*="/dashboard/inventory/"]');
    expect(link).not.toBeNull();
    // members[0] is size 8, so the link must target it...
    expect(link!.getAttribute('href')).toContain('/dashboard/inventory/eight');
    // ...and the label must not advertise a different variant's size.
    expect(link!.textContent).toBe('Court Shoe');
  });

  it('expands a grouped run in SIZE order, not the list sort order', async () => {
    const user = userEvent.setup();
    const { container } = renderGrouped({ items: pegasus() });
    await user.click(screen.getByRole('button', { name: /expand/i }));
    const skus = bodyRows(container)
      .slice(1)
      .map((r) => r.textContent ?? '');
    expect(skus[0]).toContain('PEG-9');
    expect(skus[1]).toContain('PEG-10');
  });

  // Final-review wave C: a run's unit is the VARIANT, not the rendered row.
  // Every placement row of an item carries the item's TOTAL on hand (the rack's
  // own qty is `line_quantity`), so expanding a multi-placement SKU inside a run
  // added that total once per rack.
  it('counts a multi-placement variant ONCE in the run header total', async () => {
    const user = userEvent.setup();
    getSearchParams('');
    window.history.replaceState(null, '', '/dashboard/inventory');
    const rows = pegasus();
    render(
      <InventoryTable
        items={rows}
        lookups={EMPTY_LOOKUPS}
        total={rows.length}
        pageSize={30}
        instant={{
          items: rows,
          view: 'items',
          placement: {
            // The size-10 shoe sits in two racks: two rendered rows, one
            // variant, 20 on hand in total.
            p10: [
              { locationId: 'L1', label: '1-A', kind: 'rack', quantity: 12 },
              { locationId: 'L2', label: '2-C', kind: 'rack', quantity: 8 },
            ],
          },
        }}
        productGroupUnits={{ 'grp-1': 'pair' }}
      />,
    );

    // Expand the SKU group so both placement rows are rendered — the state in
    // which the run used to read 3 variants / 72 pairs.
    await user.click(screen.getByRole('button', { name: /expand .*PEG-10/i }));
    expect(screen.getAllByText('2 variants · 52 pairs total').length).toBeGreaterThan(0);
    expect(screen.queryByText(/3 variants/)).not.toBeInTheDocument();
    expect(screen.queryByText(/72 pairs/)).not.toBeInTheDocument();
  });

  it('does NOT fold two same-base names carrying DIFFERENT group ids together', () => {
    const { container } = renderGrouped({
      items: [
        item({ id: 'a', name: 'Pink Shirt - L', sku: 'A', group_id: 'grp-1', variant_size: 'L' }),
        item({ id: 'b', name: 'Pink Shirt - XL', sku: 'B', group_id: 'grp-2', variant_size: 'XL' }),
      ],
    });
    expect(screen.queryByRole('button', { name: /expand/i })).not.toBeInTheDocument();
    expect(bodyRows(container)).toHaveLength(2);
  });

  it('leaves an ungrouped org byte-identical — the legacy "N sizes" run is untouched', () => {
    renderGrouped({
      items: [
        item({ id: 'l', name: 'Pink Shirt - L', sku: 'L' }),
        item({ id: 'xl', name: 'Pink Shirt - XL', sku: 'X' }),
      ],
    });
    expect(screen.getByRole('button', { name: /expand pink shirt \(2 sizes\)/i })).toBeInTheDocument();
    expect(screen.queryByText(/variants/)).not.toBeInTheDocument();
  });

  // The pagination twin of the tests above. A group is the unit of DISPLAY, so
  // it must be the unit of PAGINATION: with the family straddling a fixed
  // 2-row slice, one member rendered flat on the next page and the header on
  // this one summed 32 instead of 52.
  it('keeps a group whose names defeat the size regex whole on one page, with the full total', () => {
    getSearchParams('');
    window.history.replaceState(null, '', '/dashboard/inventory');
    const rows = [
      item({ id: 'p9', name: 'Nike Pegasus 41', sku: 'PEG-9', quantity_on_hand: 32, group_id: 'grp-1', variant_size: '9', updated_at: '2026-01-09T00:00:00+00:00' }),
      item({ id: 'x1', name: 'Stapler', sku: 'STP-1', quantity_on_hand: 1, updated_at: '2026-01-08T00:00:00+00:00' }),
      item({ id: 'x2', name: 'Kettle', sku: 'KTL-1', quantity_on_hand: 1, updated_at: '2026-01-07T00:00:00+00:00' }),
      item({ id: 'p10', name: 'Nike Pegasus 41', sku: 'PEG-10', quantity_on_hand: 20, group_id: 'grp-1', variant_size: '10', updated_at: '2026-01-06T00:00:00+00:00' }),
    ];
    render(
      <InventoryTable
        items={rows}
        lookups={EMPTY_LOOKUPS}
        total={rows.length}
        pageSize={2}
        instant={{ items: rows, view: 'items' }}
        productGroupUnits={{ 'grp-1': 'pair' }}
      />,
    );

    // ONE header, both variants behind it, and the roll-up is the whole
    // family (32 + 20), never the page-slice 32.
    expect(screen.getAllByRole('button', { name: /expand/i })).toHaveLength(1);
    expect(screen.getAllByText('2 variants · 52 pairs total').length).toBeGreaterThan(0);
    expect(screen.queryByText('Stapler')).not.toBeInTheDocument();
  });
});
