import { act, render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PageHeader } from '@/components/patterns/page-header';
import { cssRules, declaredFor } from '@/styles/liquid-glass/glass-css';
import { classicMarkup, glassOnlyElements } from '@/test/classic-parity';

/**
 * CLASSIC PARITY OF THE ITEMS AND BOOKS LISTS (Liquid Glass stage 3, items
 * lane; IMPLEMENTATION-PLAN.md 4.6, 4.7 item 3 and section 6 stage 3). Glass
 * draws the Items board (Items.dc.html: toolbar, table card, floating
 * selection bar, pager) from inert hooks on today's markup. This renders the
 * real table, the real grid and the real bulk bar with fixed data, in the
 * Items and the Books layouts, and compares their markup, every inert hook
 * stripped, to the files under __parity__ that were written from the markup
 * before the stage 3 hooks went in. Any change to classic output fails here.
 *
 * Under the `off` rollout no glass-only element is rendered; under `default`
 * the stripped markup is still the same file.
 */

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

import { InventoryTable, type InventoryTableProps } from './inventory-table';

const LOOKUPS = {
  categories: new Map<string, { name: string; color: string | null }>([
    ['c1', { name: 'Uniforms', color: '#2f7d6d' }],
  ]),
  locations: new Map<string, { name: string }>([['l1', { name: 'Rack 12-B' }]]),
  charters: new Map<string, { name: string; code: string | null }>([
    ['ch1', { name: 'Example Charter', code: 'EXC' }],
  ]),
};

function row(id: string, sku: string, over: Record<string, unknown> = {}) {
  return {
    id,
    name: `Item ${id}`,
    sku,
    status: 'active' as const,
    quantity_on_hand: 14,
    reorder_point: 4,
    unit_cost: 2,
    retail_price: 5,
    category_id: null,
    charter_id: null,
    primary_location_id: null,
    barcode: null,
    model_number: null,
    custom_fields: null,
    item_type: 'product',
    display_group_id: null,
    display_group_name: null,
    display_group_version: null,
    created_at: '2026-10-01T00:00:00+00:00',
    updated_at: '2026-10-30T09:00:00+00:00',
    ...over,
  };
}

const group = { display_group_id: 'g1', display_group_name: 'Polo XL', display_group_version: 1 };

const ITEMS = [
  row('a', 'TEE-RED', {
    name: 'Red tee',
    category_id: 'c1',
    primary_location_id: 'l1',
    charter_id: 'ch1',
    quantity_on_hand: 3,
    reorder_point: 6,
  }),
  row('b', 'POLO-XL-A', { name: 'Polo XL', ...group }),
  row('c', 'POLO-XL-B', { name: 'Polo XL', quantity_on_hand: 0, ...group }),
  row('d', 'CAP-01', { name: 'Cap', status: 'archived' as const }),
];

const BOOKS = [
  row('k1', '9780000000011', {
    name: 'Example Reader, Grade 3',
    item_type: 'book',
    custom_fields: {
      book_rack_number: '38',
      book_rack_row: 'A',
      book_crate_color: 'blue',
      book_crate_number: '4',
      book_grade: '3',
    },
  }),
  row('k2', '9780000000028', { name: 'Example Atlas', item_type: 'book', quantity_on_hand: 0 }),
];

const SHARED: Partial<InventoryTableProps> = {
  lookups: LOOKUPS,
  categories: [{ id: 'c1', name: 'Uniforms' }],
  locations: [{ id: 'l1', name: 'Rack 12-B' }],
  charters: [{ id: 'ch1', name: 'Example Charter', code: 'EXC' }],
  suppliers: [{ id: 's1', name: 'Example Supply' }],
  tags: [{ id: 't1', name: 'Fragile', color: '#f97316' }],
  initialQuery: '',
  page: 1,
  pageSize: 30,
  canCreate: true,
  canExport: true,
  canStartOrder: true,
  canStartCount: true,
  canUngroup: true,
  canRenameGroups: true,
  canSetPublicVisibility: true,
  currentUserId: 'u1',
  expectedCount: 2,
  savedViews: [
    {
      id: 'v1',
      name: 'Low uniforms',
      state: { stock: 'low', cat: ['c1'] },
      isShared: false,
      ownerId: 'u1',
    } as never,
  ],
};

function itemsTable(over: Partial<InventoryTableProps> = {}) {
  return (
    <InventoryTable
      {...(SHARED as InventoryTableProps)}
      items={ITEMS as never}
      total={45}
      valueOnHand={1234.5}
      savedViewScope="inventory"
      {...over}
    />
  );
}

function booksTable(over: Partial<InventoryTableProps> = {}) {
  return (
    <InventoryTable
      {...(SHARED as InventoryTableProps)}
      items={BOOKS as never}
      total={2}
      savedViewScope="books"
      rowLinkPrefix="/dashboard/books"
      basePath="/dashboard/books"
      showBookFields
      onScanRequest={() => {}}
      {...over}
    />
  );
}

async function selectRow(name: string) {
  const user = userEvent.setup();
  await act(async () => {
    await user.click(document.querySelector(`[aria-label="Select ${name}"]`)!);
  });
}

type Case = [name: string, draw: () => Promise<Element>];

const CASES: Case[] = [
  ['items-table', async () => render(itemsTable()).container],
  [
    'items-table-selected',
    async () => {
      const { container } = render(itemsTable());
      await selectRow('Red tee');
      return container;
    },
  ],
  ['items-grid', async () => render(itemsTable({ initialView: 'grid' })).container],
  ['books-table', async () => render(booksTable()).container],
  // Stage 3 fidelity, small lane: the cover view's inert grid-card hooks.
  ['books-grid', async () => render(booksTable({ initialView: 'grid' })).container],
  [
    'books-table-selected',
    async () => {
      const { container } = render(booksTable());
      await selectRow('Example Atlas');
      return container;
    },
  ],
];

beforeEach(() => {
  // The Updated column is relative to now: a fixed clock keeps the files stable.
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-01T12:00:00Z') });
  window.history.replaceState(null, '', '/dashboard/inventory');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('the rack cell’s inert tone hook', () => {
  const PLACED = [
    row('s', 'STG-1', {
      name: 'Staged tee',
      placement_label: 'Staging',
      placement_kind: 'staging',
    }),
    row('u', 'UNP-1', {
      name: 'Loose cap',
      placement_label: 'Unplaced',
      placement_kind: 'unplaced',
    }),
    row('r', 'RCK-1', { name: 'Shelved polo', placement_label: '12-B', placement_kind: 'rack' }),
  ];

  it('names Staging and Unplaced apart, so glass draws them on the warn and the info wash; classic markup is unchanged', () => {
    const { container } = render(itemsTable({ items: PLACED as never, total: 3 }));
    const label = (text: string) =>
      [...container.querySelectorAll('td[data-glass="rack"] > span')].find(
        (s) => s.textContent === text,
      )!;
    expect(label('Staging').getAttribute('data-glass-tone')).toBe('staging');
    expect(label('Unplaced').getAttribute('data-glass-tone')).toBe('unplaced');
    expect(label('12-B').hasAttribute('data-glass-tone')).toBe(false);
    // With the hook stripped, each is the span classic has always drawn.
    expect(classicMarkup(label('Staging'))).toBe(
      '<span class="text-warning font-mono tabular-nums">Staging</span>',
    );
    expect(classicMarkup(label('Unplaced'))).toBe(
      '<span class="text-warning font-mono tabular-nums">Unplaced</span>',
    );
    expect(classicMarkup(label('12-B'))).toBe('<span class="font-mono tabular-nums">12-B</span>');
  });
});

describe('classic parity of the Items and Books lists', () => {
  for (const [name, draw] of CASES) {
    it(`${name}: the off rollout renders no glass-only element and today's markup`, async () => {
      const root = await draw();
      expect(glassOnlyElements(root)).toEqual([]);
      await expect(classicMarkup(root)).toMatchFileSnapshot(`./__parity__/${name}.html`);
    });

    it(`${name}: the default rollout's markup, inert hooks and glass-only elements stripped, is the same`, async () => {
      vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'default');
      const root = await draw();
      await expect(classicMarkup(root)).toMatchFileSnapshot(`./__parity__/${name}.html`);
    });
  }
});

/**
 * THE PHONE CARDS (Liquid Glass, fidelity lane phone; Items-Mobile.dc.html).
 * At 760 px and under, pages/items.css lays the SAME table out as the board's
 * card list: no glass-only copy, so every row checkbox, disclosure, group
 * action and the 14-day mode menu stay the one node they are in Classic. Its
 * rules find the columns by position (the checkbox first, Item second, On
 * hand fifth from the end); this renders the real table in the Items and the
 * Books layouts, record rows and a group header among them, and checks each
 * phone rule lands on the column it names, and that the only headings shown
 * are the two that hold a control. Fails on a stylesheet without the phone
 * rules (each value below is undefined there).
 */
describe('Liquid Glass phone cards: each phone rule lands on its column', () => {
  const rules = cssRules('pages/items.css');
  const phone = (media: string[]) => media.includes('(max-width: 760px)');
  const declared = (el: Element, prop: string, pseudo?: '::before') =>
    declaredFor(el, rules, prop, phone, pseudo);
  // A cell's display without the td:empty rule: happy-dom matches :empty on
  // a cell that holds only text, which a browser does not.
  const notEmptyRules = rules.filter((r) => !r.selectors.some((sel) => sel.includes(':empty')));
  const shown = (el: Element) => declaredFor(el, notEmptyRules, 'display', phone);

  const LAYOUTS = [
    ['items', () => itemsTable()],
    ['books', () => booksTable()],
  ] as const;

  for (const page of ['items', 'books'] as const) {
    it(`${page}: the page head's actions scroll as one row`, () => {
      document.documentElement.setAttribute('data-appearance', 'liquid-glass');
      try {
        const { container } = render(
          <div data-glass-page={page}>
            <PageHeader
              title="Items"
              actions={
                <>
                  <button type="button">Active</button>
                  <button type="button">Rack: Any</button>
                  <button type="button">Import CSV</button>
                </>
              }
              primaryAction={<button type="button">+ New item</button>}
            />
          </div>,
        );
        const row = container.querySelector('[data-slot="page-header-actions"]')!;
        expect(declared(row, 'flex-wrap')).toBe('nowrap');
        expect(declared(row, 'overflow-x')).toBe('auto');
        expect(declared(row, 'width')).toBe('calc(100% + 32px)');
        expect([...row.children].map((c) => c.textContent)).toEqual([
          'Active',
          'Rack: Any',
          'Import CSV',
          '+ New item',
        ]);
        for (const child of row.children) expect(declared(child, 'flex')).toBe('none');
      } finally {
        document.documentElement.removeAttribute('data-appearance');
      }
    });
  }

  for (const [page, draw] of LAYOUTS) {
    it(`${page}: the cards' lines and the shown headings`, () => {
      document.documentElement.setAttribute('data-appearance', 'liquid-glass');
      try {
        const { container } = render(<div data-glass-page={page}>{draw()}</div>);
        const table = container.querySelector('[data-glass="items-table"]')!;
        const heads = [...table.querySelectorAll(':scope > thead th')];
        const label = (i: number) => (i === 0 ? 'select' : heads[i]!.textContent!.trim());
        expect(label(1)).toBe('Item');
        expect(heads.length - 5).toBe(heads.findIndex((th) => th.textContent === 'On hand'));

        // The table and its body are blocks; every row is a card.
        expect(declared(table, 'display')).toBe('block');
        expect(declared(table, 'min-width')).toBe('0');
        const rows = [...table.querySelectorAll(':scope > tbody > tr')];
        const kinds = new Set(rows.map((tr) => tr.getAttribute('data-row-kind')));
        expect(kinds.has('record')).toBe(true);
        if (page === 'items') expect(kinds.has('header')).toBe(true);
        for (const tr of rows) {
          expect(declared(tr, 'display')).toBe('flex');
          expect(declared(tr, 'border-radius')).toBe('16px');
          const cells = [...tr.children];
          expect(cells.length).toBe(heads.length);
          const isHeader = tr.getAttribute('data-row-kind') === 'header';
          cells.forEach((td, i) => {
            const col = label(i);
            const where = `${page} ${tr.getAttribute('data-row-kind')} ${col}`;
            const isRack = td.getAttribute('data-glass') === 'rack';
            const want =
              col === 'select' || col === 'Item'
                ? '1'
                : col === 'On hand'
                  ? '2'
                  : isRack || col === 'Status'
                    ? '3'
                    : '4';
            expect(declared(td, 'order'), where).toBe(want);
            // Every fact of words is named by its column's label; the status
            // badge names itself; the coverage bar and the 14-day line are
            // not drawn on the card; a group's Updated (always the dash) is
            // not drawn either.
            const fact = !['select', 'Item', 'On hand', 'Status'].includes(col) && !isRack;
            const hidden =
              col === 'Coverage' || col.startsWith('14-day') || (isHeader && col === 'Updated');
            if (hidden) expect(shown(td), where).toBe('none');
            else if (col !== 'select') expect(shown(td), where).toBe('block');
            if (!hidden) {
              expect(declared(td, 'content', '::before'), where).toBe(
                fact || isRack ? `'${col} '` : undefined,
              );
            }
          });
          if (isHeader) {
            // A group: no gutter, the figure at the top right, the name over
            // its line, Rename and Remove across the room under them.
            expect(declared(tr, 'padding-left')).toBe('12px');
            expect(declared(cells[1]!, 'flex')).toBe('1 1 100%');
            expect(
              declared(cells[1]!.querySelector('[data-slot="item-cell"]')!, 'align-items'),
            ).toBe('flex-start');
            expect(declared(cells[heads.length - 5]!, 'position')).toBe('absolute');
            const name = cells[1]!.querySelector('[data-slot="item-cell-name"]')!.parentElement!;
            expect(declared(name, 'padding-right')).toBe('94px');
            const actions = cells[1]!.querySelector('[data-slot="item-cell-actions"]');
            if (actions) expect(declared(actions, 'padding-right')).toBeUndefined();
          } else {
            expect(declared(cells[0]!, 'position')).toBe('absolute');
            expect(declared(cells[1]!, 'flex')).toBe('1 1 calc(100% - 96px)');
            expect(declared(cells[heads.length - 5]!, 'position')).toBeUndefined();
          }
          expect(declared(cells[heads.length - 5]!, 'flex')).toBe('0 0 86px');
        }
        // The labels in use: on Books also Grade and Crate.
        const labelled = new Set(
          rows.flatMap((tr) =>
            [...tr.children]
              .filter((td) => shown(td) !== 'none')
              .map((td) => declared(td, 'content', '::before'))
              .filter(Boolean),
          ),
        );
        expect([...labelled].sort()).toEqual(
          page === 'books'
            ? [
                "'Category '",
                "'Charter '",
                "'Crate '",
                "'Grade '",
                "'Location '",
                "'Rack '",
                "'Updated '",
              ]
            : ["'Category '", "'Charter '", "'Location '", "'Rack '", "'Updated '"],
        );

        // The top pager is not drawn on a phone; the one under the list is
        // the same pager (every page control stays).
        const top = container.querySelector('[data-glass="items-count"] > div');
        if (top) {
          expect(declared(top, 'display')).toBe('none');
          const bottom = container.querySelector('[data-glass="items-pager"]')!;
          expect(bottom.textContent).toContain(top.textContent!);
          expect(declared(bottom, 'display')).toBeUndefined();
        }
        if (page === 'items') expect(top).not.toBeNull();
        // Rack has its own line on a record.
        for (const rack of table.querySelectorAll('tbody td[data-glass="rack"]')) {
          expect(declared(rack, 'flex')).toBe('1 1 100%');
        }

        // Only the headings that hold a control are drawn.
        for (const th of heads) {
          const control = th.querySelector('button, [role="checkbox"], input, a');
          expect(declared(th, 'display'), th.textContent ?? '').toBe(control ? 'block' : 'none');
        }
        expect(heads.filter((th) => th.querySelector('button, [role="checkbox"]')).length).toBe(2);

        // The selection bar floats at the foot; the search sits over the filters.
        const layer = container.querySelector('[data-glass="selbar-layer"]')!;
        expect(declared(layer, 'position')).toBe('fixed');
        const toolbar = container.querySelector('[data-glass="items-toolbar"]')!;
        expect(declared(toolbar, 'overflow-x')).toBe('auto');
        expect(declared(toolbar.firstElementChild!, 'position')).toBe('sticky');
        expect(declared(container.querySelector('[data-glass="items-views"]')!, 'flex-wrap')).toBe(
          'nowrap',
        );
      } finally {
        document.documentElement.removeAttribute('data-appearance');
      }
    });
  }
});
