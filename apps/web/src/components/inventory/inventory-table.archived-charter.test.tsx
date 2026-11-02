import { render, within } from '@testing-library/react';
import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * B97 part 1. Items, Books and Rentals > Items called a record tagged to an
 * archived (or inactive) charter "Generic", with the tooltip "Generic stock —
 * any charter serviced by this warehouse can use it", in the table row, on its
 * grid card and in its group header: the lists' charter lookup held active
 * charters only, and the Charter cell read "tagged to a charter it does not
 * know" as "no charter". It is still that charter's stock (archiving only sets
 * the charter's status). The lookup now also carries the archived and inactive
 * charters' names for the label (core of it: lib/charter-display
 * charterCellFor), so the cell names the charter, marked (archived) or
 * (inactive); a charter it still does not know shows nothing, never Generic.
 * The Charter filter keeps offering active charters only.
 */

const { routerMock, urlState } = vi.hoisted(() => ({
  routerMock: { replace: vi.fn(), push: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() },
  urlState: { params: new URLSearchParams('') },
}));
vi.mock('next/navigation', () => ({
  useRouter: () => routerMock,
  useSearchParams: () => urlState.params,
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
  default: (props: {
    src: string;
    alt?: string;
    priority?: boolean;
    unoptimized?: boolean;
    onError?: React.ReactEventHandler<HTMLImageElement>;
  }) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={props.src}
      alt={props.alt ?? ''}
      data-priority={props.priority ? 'true' : 'false'}
      data-unoptimized={props.unoptimized ? 'true' : 'false'}
      onError={props.onError}
    />
  ),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), message: vi.fn() } }));
vi.mock('@/server/actions/saved-views', () => ({
  createSavedViewAction: vi.fn(),
  deleteSavedViewAction: vi.fn(),
  setActiveWarehouseAction: vi.fn(),
  toggleSavedViewShareAction: vi.fn(),
}));
vi.mock('@/lib/download-export', () => ({ downloadInventoryExport: vi.fn() }));
const { previews } = vi.hoisted(() => ({
  previews: [] as Array<{ title?: string; src: string | null; srcLoader?: unknown }>,
}));
vi.mock('@/components/ui/image-hover-preview', () => ({
  ImageHoverPreview: ({
    children,
    title,
    src,
    srcLoader,
  }: {
    children: React.ReactNode;
    title?: string;
    src: string | null;
    srcLoader?: unknown;
  }) => {
    previews.push({ title, src, srcLoader });
    return <span data-testid="hover-preview">{children}</span>;
  },
  prewarmPreviewImages: vi.fn(),
}));
vi.mock('@/lib/cycle-counts/use-count-selection', () => ({
  useCountSelection: (selector: (s: { add: () => void }) => unknown) => selector({ add: vi.fn() }),
}));
vi.mock('@/components/inventory/display-group-dialogs', () => ({
  GroupSelectedDialog: () => <div data-testid="group-dialog" />,
  RemoveFromGroupDialog: (p: { itemIds: readonly string[] }) => (
    <div data-testid="remove-dialog">remove {p.itemIds.join(',')}</div>
  ),
  RenameGroupDialog: (p: { groupId: string }) => (
    <div data-testid="rename-dialog">rename {p.groupId}</div>
  ),
}));

const { spy } = vi.hoisted(() => ({ spy: { selectedIds: [] as string[] } }));
vi.mock('@/components/inventory/bulk-actions', () => ({
  BulkActions: (props: { selectedIds: string[] }) => {
    spy.selectedIds = props.selectedIds;
    return <div data-testid="bulk-actions" data-count={props.selectedIds.length} />;
  },
}));

import { InventoryTable } from './inventory-table';

const ACTIVE = 'ch-active';
const ARCHIVED = 'ch-archived';
const INACTIVE = 'ch-inactive';
const UNKNOWN = 'ch-unknown';

const LOOKUPS = {
  categories: new Map<string, { name: string; color: string | null }>([
    ['cat-swag', { name: 'Swag', color: null }],
  ]),
  locations: new Map<string, { name: string }>([['loc-north', { name: 'North DC' }]]),
  charters: new Map<
    string,
    { name: string; code: string | null; status?: 'active' | 'inactive' | 'archived' }
  >([
    [ACTIVE, { name: 'North Campus', code: 'NC' }],
    [ARCHIVED, { name: 'Old Campus', code: 'OC', status: 'archived' }],
    [INACTIVE, { name: 'Summer Site', code: null, status: 'inactive' }],
  ]),
};

function row(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    name: `Item ${id}`,
    sku: `SKU-${id}`,
    status: 'active' as const,
    quantity_on_hand: 10,
    reorder_point: 0,
    unit_cost: 2,
    retail_price: 5,
    category_id: 'cat-swag',
    charter_id: null,
    primary_location_id: 'loc-north',
    barcode: null,
    model_number: null,
    custom_fields: null,
    item_type: 'product',
    display_group_id: null,
    display_group_name: null,
    display_group_version: null,
    created_at: '2026-01-01T00:00:00+00:00',
    updated_at: '2026-01-02T00:00:00+00:00',
    ...over,
  };
}

const PAGE = [
  row('generic', { name: 'Desk Lamp' }),
  row('active', { name: 'Desk Tray', charter_id: ACTIVE }),
  row('archived', { name: 'Stapler', charter_id: ARCHIVED }),
  row('inactive', { name: 'Ruler', charter_id: INACTIVE }),
  row('unknown', { name: 'Eraser', charter_id: UNKNOWN }),
  // A size run whose sizes all carry the archived charter: one group header.
  row('tee-s', { name: 'Tee - S', sku: 'TEE-S', charter_id: ARCHIVED }),
  row('tee-m', { name: 'Tee - M', sku: 'TEE-M', charter_id: ARCHIVED }),
];

type Props = React.ComponentProps<typeof InventoryTable>;

function renderTable(over: Partial<Props> = {}) {
  return render(
    <InventoryTable
      items={PAGE as never}
      lookups={LOOKUPS}
      total={PAGE.length}
      initialQuery=""
      pageSize={30}
      charters={[{ id: ACTIVE, name: 'North Campus', code: 'NC' }]}
      {...over}
    />,
  );
}

/** The Charter column's cell of a table row (by its row key) or group header. */
function charterCell(container: HTMLElement, key: string): HTMLElement {
  const tr = container.querySelector(`tr[data-row-key="${key}"], tr[data-group-key="${key}"]`);
  expect(tr, key).not.toBeNull();
  const headers = [...container.querySelectorAll('thead th')].map((th) =>
    (th.textContent ?? '').trim(),
  );
  const col = headers.indexOf('Charter');
  expect(col).toBeGreaterThan(-1);
  return tr!.querySelectorAll('td')[col] as HTMLElement;
}

/** A grid card's meta line (by its row key or group key). */
function cardMeta(container: HTMLElement, key: string): string {
  const card = container.querySelector(
    `[data-slot="grid-card"][data-row-key="${key}"], [data-slot="grid-card"][data-group-key="${key}"]`,
  );
  expect(card, key).not.toBeNull();
  return (card!.querySelector('[data-slot="meta-line"]')?.textContent ?? '').replace(/\s+/g, ' ');
}

beforeEach(() => {
  vi.clearAllMocks();
  urlState.params = new URLSearchParams('');
  previews.length = 0;
  window.history.replaceState(null, '', '/dashboard/inventory');
});

describe('the Charter cell names an archived charter (B97)', () => {
  it('table rows: the archived and inactive charters by code or name, marked; never Generic', () => {
    const { container } = renderTable();
    expect(charterCell(container, 'archived')).toHaveTextContent(/^OC \(archived\)$/);
    expect(
      within(charterCell(container, 'archived')).getByTitle('Old Campus (archived)'),
    ).toBeTruthy();
    expect(charterCell(container, 'inactive')).toHaveTextContent(/^Summer Site \(inactive\)$/);
    expect(charterCell(container, 'archived').textContent).not.toMatch(/Generic/);
    expect(charterCell(container, 'archived').querySelector('[title^="Generic stock"]')).toBeNull();
  });

  it('a charter the lookup does not know shows nothing, never Generic', () => {
    const { container } = renderTable();
    expect(charterCell(container, 'unknown').textContent).toBe('');
  });

  it('no charter is still Generic, and an active charter still its code', () => {
    const { container } = renderTable();
    expect(charterCell(container, 'generic')).toHaveTextContent(/^Generic$/);
    expect(within(charterCell(container, 'generic')).getByTitle(/Generic stock/)).toBeTruthy();
    expect(charterCell(container, 'active')).toHaveTextContent(/^NC$/);
  });

  it('the group header of a size run tagged to the archived charter names it', () => {
    const { container } = renderTable();
    const header = container.querySelector('tr[data-group-key^="style-group:"]')!;
    expect(header).not.toBeNull();
    const key = header.getAttribute('data-group-key')!;
    expect(charterCell(container, key)).toHaveTextContent(/^OC \(archived\)$/);
  });

  it('grid cards: the archived charter by name, nothing (and no stray dot) for an unknown one', () => {
    const { container } = renderTable({ initialView: 'grid' });
    expect(cardMeta(container, 'archived')).toBe('Swag·OC (archived)');
    expect(cardMeta(container, 'unknown')).toBe('Swag');
    expect(cardMeta(container, 'generic')).toBe('Swag·Generic');
    const group = container.querySelector(
      '[data-slot="grid-card"][data-group-key^="style-group:"]',
    )!;
    expect(group).not.toBeNull();
    expect(cardMeta(container, group.getAttribute('data-group-key')!)).toMatch(/OC \(archived\)$/);
  });
});
