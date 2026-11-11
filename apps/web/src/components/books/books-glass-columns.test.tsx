import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { glassOnlyElements } from '@/test/classic-parity';

/**
 * THE BOOKS TABLE UNDER LIQUID GLASS: the board's columns, and classic's
 * others one tick away (stage 3 fidelity check, small lane, finding 4;
 * Books.dc.html 36-52).
 *
 * The glass CSS (styles/liquid-glass/pages/items.css) leaves out classic's
 * Category, Charter, Location, Coverage, 14-day and Updated columns BY
 * POSITION, unless the table's inert data-glass-cols hook names them. So
 * this pins: every Books row kind (record, a named group's header and its
 * members) draws its cells in TABLE_COLUMNS' order, with the select box
 * first; the CSS's positions are those columns' positions in the rendered
 * header; and the chooser writes the hook (and keeps the choice in this
 * browser) only in a build that offers glass. Classic markup is pinned by
 * components/inventory/items.classic-parity.test.tsx.
 */

const { routerMock } = vi.hoisted(() => ({
  routerMock: { replace: vi.fn(), push: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() },
}));
vi.mock('next/navigation', () => ({
  useRouter: () => routerMock,
  useSearchParams: () => new URLSearchParams(''),
  usePathname: () => '/dashboard/books',
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
  useLinkStatus: () => ({ pending: false }),
}));
vi.mock('next/image', () => ({
  // eslint-disable-next-line @next/next/no-img-element
  default: (props: { src: string; alt?: string }) => <img src={props.src} alt={props.alt ?? ''} />,
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
vi.mock('@/server/actions/saved-views', () => ({
  createSavedViewAction: vi.fn(),
  deleteSavedViewAction: vi.fn(),
  setActiveWarehouseAction: vi.fn(),
  toggleSavedViewShareAction: vi.fn(),
}));
vi.mock('@/server/actions/inventory', () => ({ bulkUpdateInventoryAction: vi.fn() }));
vi.mock('@/server/actions/purchase-orders', () => ({ createDraftPosFromItemsAction: vi.fn() }));
vi.mock('@/lib/download-export', () => ({ downloadInventoryExport: vi.fn() }));
vi.mock('@/components/ui/image-hover-preview', () => ({
  ImageHoverPreview: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  prewarmPreviewImages: vi.fn(),
}));
vi.mock('@/lib/cycle-counts/use-count-selection', () => ({
  useCountSelection: (selector: (s: { add: () => void }) => unknown) => selector({ add: vi.fn() }),
}));

import { InventoryTable, type InventoryTableProps } from '@/components/inventory/inventory-table';

import {
  BOOKS_GLASS_COLUMNS,
  BOOKS_GLASS_COLUMNS_STORAGE_KEY,
  parseBooksGlassColumns,
} from './books-glass-columns';

function book(id: string, sku: string, over: Record<string, unknown> = {}) {
  return {
    id,
    name: `Example Book ${id}`,
    sku,
    status: 'active' as const,
    quantity_on_hand: 14,
    reorder_point: 4,
    unit_cost: 2,
    retail_price: 5,
    category_id: 'c1',
    charter_id: null,
    primary_location_id: 'l1',
    barcode: null,
    model_number: null,
    custom_fields: {
      book_rack_number: '38',
      book_rack_row: 'A',
      book_crate_color: 'blue',
      book_crate_number: '4',
      book_grade: '3',
    },
    item_type: 'book',
    display_group_id: null,
    display_group_name: null,
    display_group_version: null,
    created_at: '2026-10-01T00:00:00+00:00',
    updated_at: '2026-10-30T09:00:00+00:00',
    ...over,
  };
}

const family = {
  display_group_id: 'g1',
  display_group_name: 'Example Anthology',
  display_group_version: 1,
};

const BOOKS = [
  book('k1', '9780000000011'),
  book('k2', '9780000000028', { quantity_on_hand: 0 }),
  book('k3', '9780000000035', { name: 'Example Anthology, first edition', ...family }),
  book('k4', '9780000000042', { name: 'Example Anthology, second edition', ...family }),
];

const PROPS = {
  lookups: {
    categories: new Map([['c1', { name: 'Books', color: '#2f7d6d' }]]),
    locations: new Map([['l1', { name: 'North Building' }]]),
    charters: new Map<string, { name: string; code: string | null }>(),
  },
  categories: [{ id: 'c1', name: 'Books' }],
  locations: [{ id: 'l1', name: 'North Building' }],
  charters: [],
  suppliers: [],
  tags: [],
  initialQuery: '',
  page: 1,
  pageSize: 30,
  canCreate: true,
  canExport: true,
  currentUserId: 'u1',
  items: BOOKS,
  total: BOOKS.length,
  savedViewScope: 'books',
  rowLinkPrefix: '/dashboard/books',
  basePath: '/dashboard/books',
  showBookFields: true,
  onScanRequest: () => {},
} as unknown as InventoryTableProps;

const table = () => document.querySelector('table[data-glass="items-table"]')!;
const headerLabels = () =>
  [...table().querySelectorAll('thead > tr > th')].map((th) => th.textContent?.trim() ?? '');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-01T12:00:00Z') });
  window.history.replaceState(null, '', '/dashboard/books');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  try {
    localStorage.clear();
  } catch {
    // jsdom always has storage; nothing to clear otherwise.
  }
});

/** The positions the glass CSS hides each optional column at, read from pages/items.css. */
function cssPositions(): Map<string, number> {
  const css = readFileSync(
    join(__dirname, '..', '..', 'styles', 'liquid-glass', 'pages', 'items.css'),
    'utf8',
  );
  const out = new Map<string, number>();
  for (const m of css.matchAll(
    /\[data-glass-cols~='(\w+)'\]\)\s*>\s*\*\s*>\s*tr\s*>\s*:nth-child\((\d+)\)/gu,
  )) {
    out.set(m[1]!, Number(m[2]));
  }
  return out;
}

describe('the Books table’s columns, as the glass CSS reads them', () => {
  it('the header is the select box, then classic’s 12 columns in TABLE_COLUMNS’ order', () => {
    render(<InventoryTable {...PROPS} />);
    const labels = headerLabels();
    expect(labels).toHaveLength(13);
    expect(labels[0]).toBe('');
    expect(labels.slice(1, 10)).toEqual([
      'Item',
      'Category',
      'Charter',
      'Location',
      'Grade',
      'Rack',
      'Crate',
      'On hand',
      'Coverage',
    ]);
    expect(labels[10]).toMatch(/^14-day/u);
    expect(labels.slice(11)).toEqual(['Status', 'Updated']);
  });

  it('every body row, a named group’s header and its members included, has the same 13 cells', async () => {
    render(<InventoryTable {...PROPS} />);
    const user = userEvent.setup({ advanceTimers: () => {} });
    await act(async () => {
      await user.click(screen.getByRole('button', { name: /^Expand group Example Anthology/u }));
    });
    const rows = [...table().querySelectorAll('tbody > tr')];
    // Two records, the group's header and its two members.
    expect(rows).toHaveLength(5);
    for (const tr of rows) expect(tr.children.length).toBe(13);
  });

  it('the CSS hides each optional column at the position the header gives it, and only those six', () => {
    render(<InventoryTable {...PROPS} />);
    const labels = headerLabels();
    const positions = cssPositions();
    expect([...positions.keys()]).toEqual(BOOKS_GLASS_COLUMNS.map((c) => c.key));
    const expected: Record<string, RegExp> = {
      category: /^Category$/u,
      charter: /^Charter$/u,
      location: /^Location$/u,
      coverage: /^Coverage$/u,
      trend: /^14-day/u,
      updated: /^Updated$/u,
    };
    for (const [key, position] of positions) {
      expect(labels[position - 1], key).toMatch(expected[key]!);
    }
  });
});

describe('the glass-only Columns chooser', () => {
  it('under off: not rendered, and the table carries no column hook', () => {
    const { container } = render(<InventoryTable {...PROPS} />);
    expect(glassOnlyElements(container)).toEqual([]);
    expect(table().hasAttribute('data-glass-cols')).toBe(false);
  });

  it('under default: rendered as a glass-only element; no column is ticked at first', () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'default');
    const { container } = render(<InventoryTable {...PROPS} />);
    const chooser = container.querySelector('[data-glass="books-columns"]');
    expect(chooser?.hasAttribute('data-glass-only')).toBe(true);
    expect(table().getAttribute('data-glass-cols')).toBe('');
  });

  it('ticking a column writes it into the table hook and keeps it in this browser; a new table reads it back', async () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'default');
    const first = render(<InventoryTable {...PROPS} />);
    const user = userEvent.setup({ advanceTimers: () => {} });
    await act(async () => {
      await user.click(screen.getByRole('button', { name: 'Choose more columns' }));
    });
    await act(async () => {
      await user.click(screen.getByRole('checkbox', { name: 'Updated' }));
    });
    await act(async () => {
      await user.click(screen.getByRole('checkbox', { name: 'Charter' }));
    });
    expect(table().getAttribute('data-glass-cols')).toBe('charter updated');
    expect(localStorage.getItem(BOOKS_GLASS_COLUMNS_STORAGE_KEY)).toBe('["charter","updated"]');
    expect(screen.getByRole('checkbox', { name: 'Charter' }).getAttribute('aria-checked')).toBe(
      'true',
    );
    first.unmount();
    render(<InventoryTable {...PROPS} />);
    expect(table().getAttribute('data-glass-cols')).toBe('charter updated');
  });

  it('is not offered in the cover (Grid) view, nor on the Items table', () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'default');
    const grid = render(<InventoryTable {...PROPS} initialView="grid" />);
    expect(grid.container.querySelector('[data-glass="books-columns"]')).toBeNull();
    grid.unmount();
    const items = render(
      <InventoryTable
        {...PROPS}
        showBookFields={false}
        savedViewScope="inventory"
        basePath="/dashboard/inventory"
      />,
    );
    expect(items.container.querySelector('[data-glass="books-columns"]')).toBeNull();
    expect(table().hasAttribute('data-glass-cols')).toBe(false);
  });

  it('reads a stored choice leniently: unknown keys and unreadable text are ignored', () => {
    expect([...parseBooksGlassColumns('["trend","nope",3,"category"]')]).toEqual([
      'trend',
      'category',
    ]);
    expect(parseBooksGlassColumns('{oops').size).toBe(0);
    expect(parseBooksGlassColumns('{"a":1}').size).toBe(0);
    expect(parseBooksGlassColumns('').size).toBe(0);
  });
});
