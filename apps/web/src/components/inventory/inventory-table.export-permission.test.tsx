import { cleanup, render, screen, within } from '@testing-library/react';
import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// B68: the Items and Books table drew its toolbar Export for every member and
// gave the bulk bar no say, while the export answers only items:export (staff
// and viewers lack it by default). The table now draws the toolbar Export and
// hands the bulk bar's gate on only when the page says canExport. The harness
// is inventory-table.selection.test.tsx's, with BulkActions mocked to capture
// its props.

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
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
vi.mock('@/components/ui/image-hover-preview', () => ({
  ImageHoverPreview: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  prewarmPreviewImages: vi.fn(),
}));
vi.mock('@/lib/cycle-counts/use-count-selection', () => ({
  useCountSelection: (selector: (s: { add: () => void }) => unknown) => selector({ add: vi.fn() }),
}));
const { bulk } = vi.hoisted(() => ({ bulk: { props: null as null | Record<string, unknown> } }));
vi.mock('@/components/inventory/bulk-actions', () => ({
  BulkActions: (props: Record<string, unknown>) => {
    bulk.props = props;
    return <div data-testid="bulk-actions" />;
  },
}));

import { InventoryTable } from './inventory-table';

const LOOKUPS = {
  categories: new Map<string, { name: string; color: string | null }>(),
  locations: new Map<string, { name: string }>(),
  charters: new Map<string, { name: string; code: string | null }>(),
};

function row(id: string) {
  return {
    id,
    name: `Item ${id}`,
    sku: `SKU-${id}`,
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
    created_at: '2026-01-01T00:00:00+00:00',
    updated_at: '2026-01-02T00:00:00+00:00',
  };
}

function renderTable(props: { canExport?: boolean; showBookFields?: boolean } = {}) {
  return render(
    <InventoryTable
      items={[row('a'), row('b')] as never}
      lookups={LOOKUPS}
      total={2}
      initialQuery=""
      {...props}
    />,
  );
}

/** The toolbar's Export menu button. BulkActions is mocked, and the bulk layer
 *  (always mounted, made invisible by a class jsdom ignores) is searched apart. */
function toolbarExport(): HTMLElement | null {
  const outsideBulk = screen
    .queryAllByRole('button', { name: /^Export$/i })
    .filter(
      (b) => !within(screen.getByTestId('bulk-actions')).queryAllByRole('button').includes(b),
    );
  return outsideBulk[0] ?? null;
}

beforeEach(() => {
  vi.clearAllMocks();
  bulk.props = null;
  window.history.replaceState(null, '', '/dashboard/inventory');
});

describe('InventoryTable: Export only when the page says canExport (B68)', () => {
  it('with canExport omitted: no toolbar Export, and the bulk bar is told false', () => {
    renderTable();
    expect(toolbarExport()).toBeNull();
    expect(bulk.props?.canExport).toBe(false);
  });

  it('with canExport false: the same', () => {
    renderTable({ canExport: false });
    expect(toolbarExport()).toBeNull();
    expect(bulk.props?.canExport).toBe(false);
  });

  it('with canExport true: the toolbar Export is there, and the bulk bar is told true', () => {
    renderTable({ canExport: true });
    expect(toolbarExport()).not.toBeNull();
    expect(bulk.props?.canExport).toBe(true);
  });

  it('the Books view (the same table) follows the same flag', () => {
    renderTable({ showBookFields: true });
    expect(toolbarExport()).toBeNull();
    expect(bulk.props?.canExport).toBe(false);
    cleanup();
    renderTable({ showBookFields: true, canExport: true });
    expect(toolbarExport()).not.toBeNull();
    expect(bulk.props?.canExport).toBe(true);
    expect(bulk.props?.itemType).toBe('book');
  });
});
