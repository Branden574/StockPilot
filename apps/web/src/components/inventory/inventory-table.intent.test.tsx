import { fireEvent, render, screen } from '@testing-library/react';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Scaffolding borrowed from inventory-table.perf.test.tsx.

const { routerMock, getSearchParams, markNavigationUseful, markNavigationIntent } = vi.hoisted(() => {
  const routerMock = { replace: vi.fn(), push: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() };
  // Stable per search string — mirrors Next, where useSearchParams returns a
  // stable object per navigation (memo deps rely on it).
  const instance = new URLSearchParams('');
  const getSearchParams = () => instance;
  return {
    routerMock,
    getSearchParams,
    markNavigationUseful: vi.fn(),
    markNavigationIntent: vi.fn(),
  };
});

vi.mock('@/lib/perf/marks', () => ({ markNavigationUseful, markNavigationIntent }));

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

vi.mock('@/lib/download-export', () => ({ downloadInventoryExport: vi.fn() }));

vi.mock('@/components/inventory/bulk-actions', () => ({
  BulkActions: () => <div data-testid="bulk-actions" />,
}));

vi.mock('@/components/ui/image-hover-preview', () => ({
  ImageHoverPreview: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  prewarmPreviewImages: vi.fn(),
}));

vi.mock('@/lib/cycle-counts/use-count-selection', () => ({
  useCountSelection: (selector: (s: { add: () => void }) => unknown) => selector({ add: vi.fn() }),
}));

import { InventoryTable, type InstantDatasetItem } from './inventory-table';

function item(
  over: Partial<InstantDatasetItem> & { id: string; name: string },
): InstantDatasetItem {
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


// ITEM ROWS WARM THEIR ROUTE ON INTENT (not on view). The row link used to be
// a plain <Link prefetch={false}>, which in next/link also turns hover and
// touch prefetch off, so the item route's shape was unknown until the click
// and its skeleton painted a server round trip late. IntentLink warms the one
// row a person approaches: when the pointer arrives, on focus (after a short
// dwell), or on pointer-down; never on render.

const ROWS = [item({ id: 'a', name: 'Alpha Widget' }), item({ id: 'b', name: 'Beta Gadget' })];

describe('InventoryTable item rows warm on intent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn());
    window.history.replaceState(null, '', '/dashboard/inventory');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function renderTable() {
    render(<InventoryTable items={ROWS} lookups={EMPTY_LOOKUPS} total={2} pageSize={30} />);
    return screen.getByRole('link', { name: 'Alpha Widget' });
  }

  it('rendering the rows warms nothing', () => {
    renderTable();
    expect(routerMock.prefetch).not.toHaveBeenCalled();
  });

  it('hovering a row name warms that item route the moment the pointer arrives, and only it', () => {
    // No dwell for rows: Next reuses a warm-up only once it has finished, so it
    // needs a round trip's head start on the click.
    const link = renderTable();
    fireEvent.pointerEnter(link);
    expect(routerMock.prefetch).toHaveBeenCalledTimes(1);
    const warmed = String(routerMock.prefetch.mock.calls[0]?.[0]);
    expect(warmed.startsWith('/dashboard/inventory/a?return=')).toBe(true);
  });

  it('pointer-down warms at once', () => {
    const link = renderTable();
    fireEvent.pointerDown(link);
    expect(routerMock.prefetch).toHaveBeenCalledTimes(1);
  });
});
