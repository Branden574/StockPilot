import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// THE RACK COLUMN FOR A MEMBER WHO CANNOT SEE EVERY WAREHOUSE (0371)
// ═══════════════════════════════════════════════════════════════════════════
//
// Staff and viewers read holdings only in their own warehouses, so the rack
// cells describe those. The rest of an item's stock is counted, never named:
//   • the Items list (one line per holding) gets ONE more line, "In other
//     warehouses", so its lines still add up to on hand;
//   • a cell that describes the whole item (Books, an un-expanded row) gets a
//     "+N in other warehouses" suffix.

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

import { InventoryTable } from './inventory-table';
import { ELSEWHERE_PLACEMENT_KIND, ELSEWHERE_PLACEMENT_LABEL } from '@/lib/placements';

const EMPTY_LOOKUPS = {
  categories: new Map<string, { name: string; color: string | null }>(),
  locations: new Map<string, { name: string }>(),
  charters: new Map<string, { name: string; code: string | null }>(),
};

function row(over: Record<string, unknown> & { id: string; name: string }) {
  return {
    sku: `SKU-${over.id}`,
    status: 'active' as const,
    quantity_on_hand: 32,
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

function renderTable(items: unknown[], opts: { showBookFields?: boolean } = {}) {
  getSearchParams('');
  window.history.replaceState(null, '', '/dashboard/inventory');
  return render(
    <InventoryTable
      items={items as never}
      lookups={EMPTY_LOOKUPS}
      total={items.length}
      initialQuery=""
      pageSize={30}
      showBookFields={opts.showBookFields}
    />,
  );
}

beforeEach(() => vi.clearAllMocks());

describe('InventoryTable: stock in other warehouses', () => {
  it('Items list: the "In other warehouses" line is a count, next to the lines the member can see', async () => {
    const user = userEvent.setup();
    // The shape the Items page builds: one row per visible holding, plus one
    // for the rest (page.tsx placementRows).
    const base = row({ id: 'chrome', name: 'QA Chrome', elsewhere_quantity: 12 });
    renderTable([
      {
        ...base,
        rowKey: 'chrome:loc-unp',
        line_quantity: 20,
        placement_label: 'Unplaced',
        placement_kind: 'unplaced',
      },
      {
        ...base,
        rowKey: `chrome:${ELSEWHERE_PLACEMENT_KIND}`,
        line_quantity: 12,
        placement_label: ELSEWHERE_PLACEMENT_LABEL,
        placement_kind: ELSEWHERE_PLACEMENT_KIND,
      },
    ]);
    // Collapsed, the SKU header counts it as stock elsewhere, never as a
    // placement with no rack set.
    expect(screen.getByText('+12 in other warehouses')).toBeInTheDocument();
    expect(screen.queryByText(/unset/)).not.toBeInTheDocument();
    // Expanded: its own line, next to the line the member can see.
    await user.click(screen.getByRole('button', { name: /Expand SKU-chrome/ }));
    expect(screen.getByText('In other warehouses')).toBeInTheDocument();
    // Never presented as stock awaiting put-away: only the Unplaced line is.
    expect(screen.getAllByText('awaiting put-away')).toHaveLength(1);
  });

  it('an un-expanded row: the visible racks, then "+N in other warehouses"', () => {
    renderTable([
      row({ id: 'a', name: 'Widget', placed_racks: ['1-A'], elsewhere_quantity: 12 }),
    ]);
    expect(screen.getByText('1-A')).toBeInTheDocument();
    expect(screen.getByText('+12 in other warehouses')).toBeInTheDocument();
  });

  it('an un-expanded row with no visible rack reads "+N in other warehouses", not a dash', () => {
    renderTable([row({ id: 'a', name: 'Widget', placed_racks: [], elsewhere_quantity: 7 })]);
    expect(screen.getByText('+7 in other warehouses')).toBeInTheDocument();
  });

  it('Books: the rack label, then "+N in other warehouses"', () => {
    renderTable(
      [
        row({
          id: 'b',
          name: 'Persepolis',
          item_type: 'book',
          custom_fields: { book_rack_number: '39', book_rack_row: 'B' },
          placed_holdings: [],
          elsewhere_quantity: 5,
        }),
      ],
      { showBookFields: true },
    );
    expect(screen.getByText('39-B')).toBeInTheDocument();
    expect(screen.getByText('+5 in other warehouses')).toBeInTheDocument();
  });

  it('nothing is added for a manager (no elsewhere_quantity)', () => {
    renderTable([row({ id: 'a', name: 'Widget', placed_racks: ['1-A'] })]);
    expect(screen.queryByText(/in other warehouses/)).not.toBeInTheDocument();
  });
});
