import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

// THE TABLE OVER THE ROWS THE PAGES SEND. The Items and Books pages hand the
// table only the columns it reads, and the full dataset packed (field names
// once; lib/inventory/client-row.ts). Here the table is drawn twice for the
// same made-up view: once from the whole loader rows as plain objects, once
// from the rows as the pages now send them. Every state below must draw the
// same markup: rows, racks, crates, photos, totals, value on hand, pager.
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
  useCountSelection: (selector: (s: { add: () => void }) => unknown) => selector({ add: vi.fn() }),
}));

import {
  packInventoryClientRows,
  toInventoryClientRows,
  withoutFlatTrends,
} from '@/lib/inventory/client-row';
import { syntheticListView, type PayloadProfile } from '@/test/inventory-payload.test.fixture';

import {
  InventoryTable,
  type InstantAdoptedPayload,
  type InstantDatasetItem,
} from './inventory-table';

const LOOKUPS = {
  categories: new Map<string, { name: string; color: string | null }>(),
  locations: new Map<string, { name: string }>(),
  charters: new Map<string, { name: string; code: string | null }>(),
};

type Sent = 'whole' | 'as-sent';

function dataset(profile: PayloadProfile, sent: Sent) {
  const v = syntheticListView(120, profile);
  const whole = v.items as unknown as InstantDatasetItem[];
  if (sent === 'whole') {
    return { items: whole, page: whole.slice(0, 30), trends: v.trends, placement: v.placement };
  }
  const slim = toInventoryClientRows(whole);
  return {
    items: packInventoryClientRows(slim),
    page: slim.slice(0, 30),
    trends: withoutFlatTrends(v.trends, slim),
    placement: v.placement,
  };
}

function drawDeepLink(profile: PayloadProfile, sent: Sent, search: string): string {
  getSearchParams(search);
  const base = profile === 'books' ? '/dashboard/books' : '/dashboard/inventory';
  window.history.replaceState(null, '', search ? `${base}?${search}` : base);
  const d = dataset(profile, sent);
  const books = profile === 'books';
  const { container } = render(
    <InventoryTable
      items={d.page}
      lookups={LOOKUPS}
      total={120}
      pageSize={30}
      trends={d.trends}
      showBookFields={books}
      basePath={base}
      rowLinkPrefix={base}
      instant={
        books
          ? { items: d.items, view: 'books' }
          : { items: d.items, placement: d.placement, view: 'items' }
      }
    />,
  );
  const html = container.innerHTML;
  cleanup();
  return html;
}

describe('the table draws the same view from the rows the pages send', () => {
  const states: Array<[PayloadProfile, string]> = [
    ['items', ''],
    ['items', 'stock=low'],
    ['items', 'stock=out'],
    ['items', 'status=archived'],
    ['items', 'q=LTB000000012'],
    ['items', 'q=MDL-1'],
    ['items', 'rack=12-D'],
    ['items', 'charter=generic'],
    ['items', 'sort=qty_desc&page=2'],
    ['items', 'sort=name_asc&page=3'],
    ['seeded', ''],
    ['seeded', 'stock=low'],
    ['books', ''],
    ['books', 'rack=12-D'],
    ['books', 'q=9781000000042'],
    ['books', 'sort=created_asc&page=2'],
  ];
  for (const [profile, search] of states) {
    it(`${profile} ${search || '(default view)'}`, () => {
      const whole = drawDeepLink(profile, 'whole', search);
      const sent = drawDeepLink(profile, 'as-sent', search);
      expect(whole.length).toBeGreaterThan(1000);
      expect(sent).toBe(whole);
    });
  }

  it('a search typed into the box answers the same', async () => {
    const results: string[] = [];
    for (const sent of ['whole', 'as-sent'] as Sent[]) {
      const user = userEvent.setup();
      getSearchParams('');
      window.history.replaceState(null, '', '/dashboard/inventory');
      const d = dataset('items', sent);
      const { container } = render(
        <InventoryTable
          items={d.page}
          lookups={LOOKUPS}
          total={120}
          pageSize={30}
          trends={d.trends}
          instant={{ items: d.items, placement: d.placement, view: 'items' }}
        />,
      );
      await user.type(screen.getByRole('textbox', { name: /search items/i }), 'steel');
      results.push(container.innerHTML);
      cleanup();
    }
    expect(results[0]).toContain('Steel');
    expect(results[1]).toBe(results[0]);
  });

  it('the streamed default view adopts a packed dataset and draws the same', async () => {
    const results: string[] = [];
    for (const sent of ['whole', 'as-sent'] as Sent[]) {
      getSearchParams('stock=low');
      window.history.replaceState(null, '', '/dashboard/inventory?stock=low');
      const d = dataset('items', sent);
      const payload: InstantAdoptedPayload = {
        items: d.items,
        placement: d.placement,
        trends: d.trends,
        view: 'items',
      };
      const promise = Promise.resolve(payload);
      const tree = (
        <InventoryTable
          items={d.page}
          lookups={LOOKUPS}
          total={120}
          pageSize={30}
          instantPromise={promise}
        />
      );
      const { container, rerender } = render(tree);
      await act(async () => {});
      // jsdom/React-act quirk (inventory-table.instant.test.tsx): re-render
      // the identical tree so use() reads the settled promise.
      rerender(tree);
      await act(async () => {});
      // Adopted: the footer counts the low-stock view over the whole dataset
      // (12 of the 120 rows), not the 120 the first page was handed.
      expect(container.textContent).toMatch(/12 SKUs · \$504\.10 on hand/);
      results.push(container.innerHTML);
      cleanup();
    }
    expect(results[1]).toBe(results[0]);
  });
});
