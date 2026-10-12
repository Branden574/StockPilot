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
  spy: {
    selectedIds: [] as string[],
    ungroupItemIds: undefined as string[] | undefined,
    shownUnder: undefined as ReadonlyMap<string, string> | undefined,
  },
}));
vi.mock('@/components/inventory/bulk-actions', () => ({
  BulkActions: (props: {
    selectedIds: string[];
    ungroupItemIds?: string[];
    ungroupShownUnder?: ReadonlyMap<string, string>;
  }) => {
    spy.selectedIds = props.selectedIds;
    spy.ungroupItemIds = props.ungroupItemIds;
    spy.shownUnder = props.ungroupShownUnder;
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
  spy.shownUnder = undefined;
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

// Ungroup anything (owner 2026-10-12, verbatim: "im supposed to be able to
// check box whatever item and then group or ungroup it that was the point.").
// The owner ticked the eight sizes of a T-shirt size family (each its own SKU)
// and saw no Ungroup. The bar now offers it for any ticked record with
// something to leave that the viewer may undo, and hands over which grouping
// each record is shown under on the list.
describe('InventoryTable: Ungroup anything in the bulk bar', () => {
  const FAM = 'fam-limits-tee';
  const sizes = ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL'].map((size, i) => ({
    ...row(`t${i}`, `TEE-${size}`),
    name: `Limits Tee - ${size}`,
    group_id: FAM,
    variant_size: size,
  }));

  it("the owner's case: the eight sizes of a family, each its own SKU, are offered to someone who may unlink them", async () => {
    render(
      <InventoryTable
        items={sizes as never}
        lookups={LOOKUPS}
        total={8}
        initialQuery=""
        pageSize={30}
        canUngroup
        canUnlinkFamilies
      />,
    );
    await selectAll();
    expect([...(spy.ungroupItemIds ?? [])].sort()).toEqual(sizes.map((r) => r.id).sort());
    for (const r of sizes) expect(spy.shownUnder?.get(r.id)).toBe('family');
  });

  it('a family is not offered to someone who may not unlink one (no sports permission)', async () => {
    render(
      <InventoryTable
        items={sizes as never}
        lookups={LOOKUPS}
        total={8}
        initialQuery=""
        pageSize={30}
        canUngroup
      />,
    );
    await selectAll();
    expect(spy.ungroupItemIds ?? []).toEqual([]);
  });

  it('records in a display group are offered and shown under their group; a lone record keeps its own SKU header kind', async () => {
    const items = [
      { ...row('g1', 'P-1'), display_group_id: 'grp-1', display_group_name: 'Polos' },
      { ...row('g2', 'P-2'), display_group_id: 'grp-1', display_group_name: 'Polos' },
      row('x', 'SOLO'),
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
    await selectAll();
    expect([...(spy.ungroupItemIds ?? [])].sort()).toEqual(['g1', 'g2']);
    expect(spy.shownUnder?.get('g1')).toBe('group');
    expect(spy.shownUnder?.has('x')).toBe(false);
  });

  it("a family member in a group with no other record here shows under its family's run, and leaves the family", async () => {
    const items = [
      { ...sizes[0]!, display_group_id: 'grp-9', display_group_name: 'Front table' },
      sizes[1]!,
    ];
    render(
      <InventoryTable
        items={items as never}
        lookups={LOOKUPS}
        total={2}
        initialQuery=""
        pageSize={30}
        canUngroup
        canUnlinkFamilies
      />,
    );
    await selectAll();
    expect(spy.shownUnder?.get(sizes[0]!.id)).toBe('family');
    expect([...(spy.ungroupItemIds ?? [])].sort()).toEqual([sizes[0]!.id, sizes[1]!.id].sort());
  });
});
