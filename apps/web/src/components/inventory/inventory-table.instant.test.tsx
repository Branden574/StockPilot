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

vi.mock('@/components/inventory/bulk-actions', () => ({
  BulkActions: () => <div data-testid="bulk-actions" />,
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

  it('expands placement rows per page when the Items dataset ships holdings (one line per rack)', () => {
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

    // One item → two rendered rows, one per rack, with per-line labels.
    expect(screen.getAllByRole('link', { name: 'Split Item' })).toHaveLength(2);
    expect(screen.getByText('1-A')).toBeInTheDocument();
    expect(screen.getByText('2-C')).toBeInTheDocument();
    // Footer counts ITEMS, not expanded lines.
    expect(screen.getByText(/1 SKUs/)).toBeInTheDocument();
  });
});

// FIRST-ROWS-FIRST STREAMING (cold-start plan rank 4): the default view
// mounts in server mode with the 30-row payload while the full dataset
// streams behind as `instantPromise`. HARD CONTRACT under test:
//   (a) rows are visible before the dataset settles,
//   (b) keystrokes during the gap NEVER route to the server-filter path
//       (no /api/items/search fetch, no router navigation) — they buffer
//       locally,
//   (c) the moment the dataset lands, the buffered search applies through
//       the instant pipeline and yields the identical complete answer,
//   (d) a null resolution (over-cap org / loader failure) drops back to
//       plain server mode, including re-enabling the server search for
//       any buffered keystrokes.
describe('InventoryTable streamed instant adoption (rank 4)', () => {
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

  it('renders the server rows immediately, buffers keystrokes off the server-search path, then applies them via the instant pipeline when the dataset lands', async () => {
    const user = userEvent.setup();
    let resolvePayload!: (p: InstantAdoptedPayload | null) => void;
    const promise = new Promise<InstantAdoptedPayload | null>((resolve) => {
      resolvePayload = resolve;
    });
    renderStreaming(promise);

    // (a) first-paint rows visible while the dataset is still pending.
    expect(screen.getByRole('link', { name: 'Alpha Widget' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Beta Gadget' })).toBeInTheDocument();

    // (b) type during the gap: local narrowing only — give the 150ms
    // server-search debounce ample time to prove it never fires.
    await user.type(screen.getByRole('textbox', { name: /search items/i }), 'beta');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(routerMock.replace).not.toHaveBeenCalled();
    expect(routerMock.push).not.toHaveBeenCalled();
    expect(screen.getByRole('link', { name: 'Beta Gadget' })).toBeInTheDocument();
    expect(screen.queryByText('Alpha Widget')).not.toBeInTheDocument();

    // (c) dataset lands (includes an OFF-PAGE row the 30-row payload
    // never had) → the buffered q now derives over the FULL dataset with
    // complete instant-mode totals, still zero server traffic.
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
    expect(screen.getByText(/2 SKUs/)).toBeInTheDocument();
    expect(screen.queryByText(/searching…/)).not.toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
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

  it('null resolution (over-cap org / loader failure) drops back to plain server mode and re-enables the server search for buffered keystrokes', async () => {
    const user = userEvent.setup();
    let resolvePayload!: (p: InstantAdoptedPayload | null) => void;
    const promise = new Promise<InstantAdoptedPayload | null>((resolve) => {
      resolvePayload = resolve;
    });
    renderStreaming(promise);

    await user.type(screen.getByRole('textbox', { name: /search items/i }), 'beta');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(fetchSpy).not.toHaveBeenCalled();

    resolvePayload(null);
    // Server mode resumes: the buffered q now takes today's
    // /api/items/search path.
    await vi.waitFor(() => {
      expect(fetchSpy).toHaveBeenCalled();
    });
    const calledUrl = String(fetchSpy.mock.calls[0]![0]);
    expect(calledUrl).toContain('/api/items/search');
    expect(calledUrl).toContain('q=beta');
  });
});
