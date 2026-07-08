import { render, screen } from '@testing-library/react';
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
    // Footer counts ITEMS, not expanded lines.
    expect(screen.getByText(/1 SKUs/)).toBeInTheDocument();
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

  it('adopts the streamed dataset with no URL state: the visible rows stay identical (30-row payload IS page 1 of the derivation)', async () => {
    renderStreaming(
      Promise.resolve({
        items: [
          item({ id: 'a', name: 'Alpha Widget' }),
          item({ id: 'b', name: 'Beta Gadget' }),
        ],
        view: 'items',
      } satisfies InstantAdoptedPayload),
    );

    // Post-adoption footer flips to the complete instant totals.
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
