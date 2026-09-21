import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// PERFORMANCE MARKER vs FIRST-ROWS-FIRST. The default Items view mounts over
// the fast 30-row server payload while the full "instant" dataset streams in
// behind it and is ADOPTED by the same mounted table (see the use() handoff
// block in inventory-table.instant.test.tsx, whose scaffolding this file
// borrows). The "useful" mark (lib/perf/marks.ts) is the end of every
// navigation timing, so it has to land when those FIRST rows are on screen:
//
//   - not later, when the dataset adopts (the number would include a wait the
//     person never had: they were already reading the list), and
//   - not twice (a second call is a second "arrival" on the timeline).
//
// marks.ts is mocked; what it does with the call is marks.test.ts's business.

const { routerMock, getSearchParams, markNavigationUseful } = vi.hoisted(() => {
  const routerMock = { replace: vi.fn(), push: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() };
  // Stable per search string — mirrors Next, where useSearchParams returns a
  // stable object per navigation (memo deps rely on it).
  const instance = new URLSearchParams('');
  const getSearchParams = () => instance;
  return { routerMock, getSearchParams, markNavigationUseful: vi.fn() };
});

vi.mock('@/lib/perf/marks', () => ({ markNavigationUseful }));

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

import {
  InventoryTable,
  type InstantAdoptedPayload,
  type InstantDatasetItem,
} from './inventory-table';

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

const PAGE_ROWS = [item({ id: 'a', name: 'Alpha Widget' }), item({ id: 'b', name: 'Beta Gadget' })];

describe('InventoryTable performance marker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn());
    // The marker waits two animation frames; this test is about WHICH render
    // fires it, so frames run at once.
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    window.history.replaceState(null, '', '/dashboard/inventory?q=acme');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('marks useful when the INITIAL server rows mount, while the instant dataset is still pending', () => {
    const pending = new Promise<InstantAdoptedPayload | null>(() => {});
    render(
      <InventoryTable
        items={PAGE_ROWS}
        lookups={EMPTY_LOOKUPS}
        total={2}
        pageSize={30}
        instantPromise={pending}
      />,
    );

    // The first rows are what the person was waiting for, and they are here.
    expect(screen.getByRole('link', { name: 'Alpha Widget' })).toBeInTheDocument();
    expect(markNavigationUseful).toHaveBeenCalledTimes(1);
    // The pathname only: the search term in the address bar stays there.
    expect(markNavigationUseful).toHaveBeenCalledWith('/dashboard/inventory');
  });

  it('does NOT mark again when the streamed dataset is adopted, or on anything the table does afterwards', async () => {
    const user = userEvent.setup();
    let resolvePayload!: (payload: InstantAdoptedPayload | null) => void;
    const promise = new Promise<InstantAdoptedPayload | null>((resolve) => {
      resolvePayload = resolve;
    });
    const tree = (
      <InventoryTable
        items={PAGE_ROWS}
        lookups={EMPTY_LOOKUPS}
        total={2}
        pageSize={30}
        instantPromise={promise}
      />
    );
    const { rerender } = render(tree);
    expect(await screen.findByText(/2 items ·/)).toBeInTheDocument(); // server mode
    expect(markNavigationUseful).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolvePayload({
        items: [...PAGE_ROWS, item({ id: 'c', name: 'Beta Offpage' })],
        view: 'items',
      } satisfies InstantAdoptedPayload);
    });
    // Same nudge, for the same reason, as inventory-table.instant.test.tsx: a
    // promise resolved outside a render pass does not ping the suspended
    // boundary in this environment. Production needs none.
    rerender(tree);

    // Adoption happened (the "SKUs" footer is reachable ONLY in instant mode),
    // on the same mounted instance, so the mount-only marker stayed quiet.
    expect(await screen.findByText(/3 SKUs/)).toBeInTheDocument();
    expect(markNavigationUseful).toHaveBeenCalledTimes(1);

    // Re-renders driven by the table's own state: a search over the adopted dataset.
    await user.type(screen.getByRole('textbox', { name: /search items/i }), 'beta');
    expect(screen.getByRole('link', { name: 'Beta Offpage' })).toBeInTheDocument();
    expect(screen.queryByText('Alpha Widget')).not.toBeInTheDocument();
    expect(markNavigationUseful).toHaveBeenCalledTimes(1);
  });

  it('marks once for a deep link that arrives with its dataset already awaited', () => {
    render(
      <InventoryTable
        items={PAGE_ROWS}
        lookups={EMPTY_LOOKUPS}
        total={2}
        pageSize={30}
        instant={{ items: PAGE_ROWS, view: 'items' }}
      />,
    );
    expect(markNavigationUseful).toHaveBeenCalledTimes(1);
  });
});
