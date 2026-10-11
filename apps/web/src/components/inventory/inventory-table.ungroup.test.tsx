import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Ungroup in the Items and Books bulk bar (design 5): offered for the
// selected records that share their SKU with another LOADED record, to a
// viewer who can edit items. The facts come from the loaded rows only: no
// per-row query, no browser-only preference (the server-planned page 1 is
// untouched).

const { routerMock } = vi.hoisted(() => ({
  routerMock: { replace: vi.fn(), push: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() },
}));
vi.mock('next/navigation', () => ({
  useRouter: () => routerMock,
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

const { spy } = vi.hoisted(() => ({
  spy: { selectedIds: [] as string[], ungroupItemIds: undefined as string[] | undefined },
}));
vi.mock('@/components/inventory/bulk-actions', () => ({
  BulkActions: (props: { selectedIds: string[]; ungroupItemIds?: string[] }) => {
    spy.selectedIds = props.selectedIds;
    spy.ungroupItemIds = props.ungroupItemIds;
    return <div data-testid="bulk-actions" />;
  },
}));

import { InventoryTable } from './inventory-table';

const LOOKUPS = {
  categories: new Map<string, { name: string; color: string | null }>(),
  locations: new Map<string, { name: string }>(),
  charters: new Map<string, { name: string; code: string | null }>(),
};

function row(id: string, sku: string) {
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
    created_at: '2026-01-01T00:00:00+00:00',
    updated_at: '2026-01-02T00:00:00+00:00',
  };
}

const ITEMS = [row('a', 'SP-PAIR'), row('b', 'SP-PAIR'), row('c', 'SP-ALONE')];

beforeEach(() => {
  vi.clearAllMocks();
  spy.selectedIds = [];
  spy.ungroupItemIds = undefined;
});

async function selectAll() {
  await userEvent.click(screen.getAllByRole('checkbox')[0]!);
}

describe('InventoryTable: Ungroup in the bulk bar', () => {
  it('hands the bulk bar the selected records that share a SKU with another loaded record', async () => {
    render(
      <InventoryTable
        items={ITEMS as never}
        lookups={LOOKUPS}
        total={3}
        initialQuery=""
        pageSize={30}
        canUngroup
      />,
    );
    await selectAll();
    expect([...spy.selectedIds].sort()).toEqual(['a', 'b', 'c']);
    expect([...(spy.ungroupItemIds ?? [])].sort()).toEqual(['a', 'b']);
  });

  it('offers nothing to a viewer who cannot edit items', async () => {
    render(
      <InventoryTable
        items={ITEMS as never}
        lookups={LOOKUPS}
        total={3}
        initialQuery=""
        pageSize={30}
      />,
    );
    await selectAll();
    expect(spy.selectedIds.length).toBe(3);
    expect(spy.ungroupItemIds ?? []).toEqual([]);
  });

  it('Books too', async () => {
    render(
      <InventoryTable
        items={ITEMS.map((r) => ({ ...r, item_type: 'book' })) as never}
        lookups={LOOKUPS}
        total={3}
        initialQuery=""
        pageSize={30}
        showBookFields
        canUngroup
      />,
    );
    await selectAll();
    expect([...(spy.ungroupItemIds ?? [])].sort()).toEqual(['a', 'b']);
  });
});
