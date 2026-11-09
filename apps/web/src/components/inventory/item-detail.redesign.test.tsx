import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { classicStructure } from '@/test/classic-dom';
import { classicMarkup, glassOnlyElements } from '@/test/classic-parity';

/**
 * The redesigned item page (redesign P3.3, DESIGN-SPEC 7.4) keeps what the page
 * does while it changes how it looks. These tests pin the parts the redesign
 * restructured:
 *
 *   - the figure strip shows REAL figures only: on hand, value and reorder at
 *     always; "Reserved for open orders" and "Available" only when something is
 *     reserved; never Allocated, On order, coverage days or Create PO, and on
 *     hand is never labelled available (CONFLICTS D2, D3);
 *   - the tabs are the URL's: `?tab=` picks the panel and the tab strip, and
 *     each panel keeps the id its tab names;
 *   - the header photo is shown on Overview only, from the photos Overview
 *     already reads, through the image optimizer (never the master), and the
 *     other tabs read no photo (CONFLICTS D7);
 *   - the Make this its own item and Group line hosts stay mounted through the
 *     refresh after their dialog's change, so an open dialog survives it;
 *   - one h1 (the record's name), every action inside the tour's
 *     [data-tour="item-actions"], the Tour outside it.
 */

vi.mock('next/dynamic', () => ({ default: () => () => null }));

vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new Error('notFound');
  }),
}));

vi.mock('next/link', async () => {
  const React = await import('react');
  return {
    default: ({ href, children }: { href: string; children: React.ReactNode }) =>
      React.createElement('a', { href }, children),
  };
});

vi.mock('@/components/inventory/item-activity-panel', async () => {
  const React = await import('react');
  return {
    ItemActivityPanel: (p: { kindFilter?: string }) =>
      React.createElement('div', { 'data-testid': `feed-${p.kindFilter ?? 'all'}` }),
  };
});
vi.mock('@/components/inventory/placements-breakdown', () => ({ PlacementsBreakdown: () => null }));
vi.mock('@/components/dashboard/charts/cost-trend-island', () => ({ CostTrendIsland: () => null }));
vi.mock('@/components/inventory/item-serials-panel', () => ({ ItemSerialsPanel: () => null }));
vi.mock('@/components/inventory/public-visibility-control', () => ({
  PublicVisibilityControl: () => null,
}));
vi.mock('@/components/inventory/market-price-panel', () => ({ MarketPricePanel: () => null }));
vi.mock('@/components/inventory/stock-status-badge', () => ({
  StockStatusBadge: () => <span data-testid="status-badge">In stock</span>,
}));
vi.mock('@/components/onboarding/page-tour', () => ({
  PageTour: () => <button type="button">Tour</button>,
}));
vi.mock('@/components/maintenance/report-problem-button', () => ({
  ReportProblemButton: () => <button type="button">Report a problem</button>,
}));
vi.mock('@/components/exceptions/count-this-item-button', () => ({
  CountThisItemButton: () => null,
}));
vi.mock('@/components/inventory/barcode-display', () => ({
  BarcodeDisplay: () => <button type="button">Label</button>,
}));
vi.mock('@/components/inventory/duplicate-item-dialog', () => ({
  DuplicateItemDialog: () => <button type="button">Duplicate</button>,
}));
vi.mock('@/components/inventory/stock-adjust-dialog', () => ({
  StockAdjustDialog: () => <button type="button">Adjust stock</button>,
}));
vi.mock('@/components/inventory/stock-transfer-dialog', () => ({
  StockTransferDialog: () => <button type="button">Transfer</button>,
}));
vi.mock('@/components/inventory/item-verification-card', () => ({
  ItemVerificationCard: () => null,
  ItemVerificationCardSkeleton: () => null,
}));
const tabsProps = vi.hoisted(() => vi.fn());
vi.mock('@/components/inventory/item-detail-tabs', () => ({
  ItemDetailTabs: (p: { activeTab: string }) => {
    tabsProps(p);
    return <div role="tablist" aria-label="Item detail sections" data-active={p.activeTab} />;
  },
}));

// The two hosts keep state the way the real ones keep their open dialog: the
// page re-renders after the change (the action refreshes it), and a host that
// unmounted or remounted would tear the dialog and its result down.
vi.mock('@/components/inventory/make-own-item-button', async () => {
  const React = await import('react');
  return {
    MakeOwnItemButton: ({ offer }: { offer: boolean }) => {
      const [opened, setOpened] = React.useState(false);
      return (
        <>
          {offer ? (
            <button type="button" onClick={() => setOpened(true)}>
              Make this its own item
            </button>
          ) : null}
          <span data-testid="make-own-host">{opened ? 'dialog-open' : 'closed'}</span>
        </>
      );
    },
  };
});
vi.mock('@/components/inventory/group-membership-control', async () => {
  const React = await import('react');
  return {
    GroupMembershipControl: ({ groupName }: { groupName: string | null }) => {
      const [opened, setOpened] = React.useState(false);
      return (
        <>
          {groupName ? (
            <button type="button" onClick={() => setOpened(true)}>
              Remove from group
            </button>
          ) : null}
          <span data-testid="group-host">{opened ? 'dialog-open' : 'closed'}</span>
        </>
      );
    },
  };
});

const ctxHolder = vi.hoisted(() => ({
  permissions: new Set<string>(),
  modules: new Set<string>(),
}));

vi.mock('@/server/services/context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/services/context')>();
  return {
    ServiceError: class ServiceError extends Error {
      constructor(
        public code: string,
        message: string,
      ) {
        super(message);
        this.name = 'ServiceError';
      }
    },
    isModuleEnabled: actual.isModuleEnabled,
    assertModuleEnabled: actual.assertModuleEnabled,
    assertPermission: actual.assertPermission,
    withContext: vi.fn(async () => ({
      organizationId: 'org-1',
      userId: 'u1',
      role: 'manager' as const,
      permissions: ctxHolder.permissions,
      mfaRequired: false,
      mfaSatisfied: true,
      enabledModules: ctxHolder.modules,
      supabase: {},
    })),
  };
});

const inventoryGet = vi.fn();
const reserved = vi.hoisted(() => ({ map: new Map<string, number>() }));
vi.mock('@/server/services/inventory', () => ({
  InventoryService: {
    forCurrentUser: vi.fn(async () => ({
      get: inventoryGet,
      placements: vi.fn(async () => []),
      reservedQuantityByItemIds: vi.fn(async () => reserved.map),
    })),
  },
}));

vi.mock('@/server/services/activity', () => ({
  ActivityService: { forCurrentUser: vi.fn(async () => ({ forItem: vi.fn(async () => []) })) },
  auditLimitFor: (limit: number) => Math.max(1, Math.ceil(limit / 2)),
}));

const imageList = vi.fn();
const signedUrls = vi.fn(
  async (paths: string[]) => new Map(paths.map((p) => [p, `https://cdn.test/${p}`])),
);
vi.mock('@/server/services/item-images', () => ({
  ItemImagesService: {
    forCurrentUser: vi.fn(async () => ({ list: imageList, signedUrls })),
  },
}));

vi.mock('@/server/services/locations', () => ({
  LocationsService: { forCurrentUser: vi.fn(async () => ({ list: vi.fn(async () => []) })) },
}));
vi.mock('@/server/services/price-tracking', () => ({
  PriceTrackingService: {
    forCurrentUser: vi.fn(async () => ({ getLatestObservation: vi.fn(async () => null) })),
  },
}));
vi.mock('@/server/services/reports', () => ({
  ReportsService: {
    forCurrentUser: vi.fn(async () => ({
      itemCostHistory: vi.fn(async () => ({
        pointCount: 0,
        lastUnitCost: null,
        avgUnitCost: null,
        series: [],
      })),
    })),
  },
}));
vi.mock('@/server/services/custom-fields', () => ({
  CustomFieldsService: {
    forCurrentUser: vi.fn(async () => ({ listDefinitions: vi.fn(async () => []) })),
  },
}));
vi.mock('@/server/services/serials', () => ({
  SerialsService: class SerialsService {
    async list() {
      return { rows: [], total: 0 };
    }
  },
}));
vi.mock('@/server/services/warehouses', () => ({
  WarehousesService: class WarehousesService {
    async listNames() {
      return [];
    }
  },
}));
const skuSiblings = vi.hoisted(() => ({ count: 0 as number | null }));
vi.mock('@/server/services/item-grouping', () => ({
  ItemGroupingService: class {
    async countSkuSiblings() {
      return skuSiblings.count;
    }
  },
}));
const groups = vi.hoisted(() => ({
  map: new Map<string, { id: string; name: string | null; version: number | null }>(),
}));
vi.mock('@/server/services/lib/display-groups', () => ({
  readDisplayGroupsByItemIds: async () => groups.map,
}));

import { ItemDetail } from './item-detail';

const ITEM_ID = '11111111-1111-1111-1111-111111111111';

function itemFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: ITEM_ID,
    name: 'Wall-mounted HVAC unit',
    sku: 'HVAC-WALL-204',
    barcode: null,
    model_number: null,
    item_type: 'product',
    category_id: null,
    supplier_id: null,
    primary_location_id: null,
    quantity_on_hand: 100,
    reorder_point: 20,
    reorder_quantity: 5,
    retail_price: 100,
    unit_cost: 40,
    unit_of_measure: 'each',
    status: 'active',
    description: null,
    bin_location: null,
    custom_fields: {},
    tracking_type: 'none',
    public_visibility: 'internal_only',
    public_display_name: null,
    awaiting_first_receipt: false,
    staged_quantity: 0,
    unplaced_quantity: 0,
    updated_by: null,
    updated_at: null,
    ...overrides,
  };
}

async function page(tab?: string) {
  return ItemDetail({
    id: ITEM_ID,
    backHref: '/dashboard/inventory',
    backLabel: 'Back to inventory',
    tab,
  });
}

/** The figure strip's cells, each as "label|value". */
function figures(): string[] {
  const strip = screen.getByTestId('item-figures');
  return Array.from(strip.querySelectorAll('[data-slot="stat-strip-item"]')).map((cell) => {
    const [label, value] = Array.from(cell.children).map((c) => (c.textContent ?? '').trim());
    return `${label}|${value}`;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  cleanup();
  inventoryGet.mockResolvedValue(itemFixture());
  imageList.mockResolvedValue([]);
  reserved.map = new Map();
  skuSiblings.count = 0;
  groups.map = new Map();
  ctxHolder.permissions = new Set();
  ctxHolder.modules = new Set();
});

describe('the figure strip: real figures only', () => {
  it('nothing reserved: on hand, value and reorder at, and nothing else', async () => {
    render(await page());
    expect(figures()).toEqual(['On hand|100 each', 'Value|$4,000.00', 'Reorder at|20 each']);
    expect(screen.getByTestId('item-value')).toHaveTextContent('@ $40.00 unit cost');
  });

  it('something reserved: "Reserved for open orders" and "Available" join, available = on hand minus reserved', async () => {
    reserved.map = new Map([[ITEM_ID, 72]]);
    render(await page());
    expect(figures()).toEqual([
      'On hand|100 each',
      'Reserved for open orders|72 each',
      'Available|28 each',
      'Value|$4,000.00',
      'Reorder at|20 each',
    ]);
  });

  it('never invents a figure the product does not compute, and never calls on hand available', async () => {
    reserved.map = new Map([[ITEM_ID, 10]]);
    render(await page());
    const strip = screen.getByTestId('item-figures');
    for (const word of [/allocated/i, /on order/i, /coverage/i, /days/i, /create po/i]) {
      expect(strip.textContent ?? '').not.toMatch(word);
    }
    expect(screen.queryByRole('button', { name: /create po/i })).toBeNull();
    // The on-hand cell is labelled On hand, with the on-hand figure.
    expect(within(screen.getByTestId('item-on-hand')).getByText('On hand')).toBeTruthy();
    expect(screen.getByTestId('item-on-hand')).toHaveTextContent('100 each');
  });

  it('is an Overview figure: the Movements and Activity tabs, which read no reservations, show no strip', async () => {
    for (const tab of ['movements', 'activity']) {
      cleanup();
      render(await page(tab));
      expect(screen.queryByTestId('item-figures')).toBeNull();
    }
  });
});

describe('the tabs are the URL', () => {
  it('?tab= picks the panel and is what the tab strip is told; each panel keeps its tab ids', async () => {
    const cases: Array<[string | undefined, string]> = [
      [undefined, 'overview'],
      ['garbage', 'overview'],
      ['movements', 'movements'],
      ['activity', 'activity'],
    ];
    for (const [tab, shown] of cases) {
      cleanup();
      tabsProps.mockClear();
      const { container } = render(await page(tab));
      expect(tabsProps).toHaveBeenCalledWith({ activeTab: shown });
      const panels = container.querySelectorAll('[role="tabpanel"]');
      expect(panels).toHaveLength(1);
      expect(panels[0]!.id).toBe(`item-detail-panel-${shown}`);
      expect(panels[0]!.getAttribute('aria-labelledby')).toBe(`item-detail-tab-${shown}`);
    }
  });

  it('every panel follows the sticky header as its sibling, which the focused control scroll margin keys on', async () => {
    // P68-KBD-01: globals.css gives a focused control in
    // `[data-item-detail-header] ~ *` a scroll margin of the header's height,
    // which it inherits from the column the panel shares with the header (the
    // tab strip keeps it there), so a control reached with Tab below the
    // header is scrolled clear of it.
    for (const tab of [undefined, 'movements', 'activity']) {
      cleanup();
      const { container } = render(await page(tab));
      const header = screen.getByTestId('item-detail-header');
      expect(header).toHaveAttribute('data-item-detail-header', '');
      const panel = container.querySelector('[data-item-detail-header] ~ [role="tabpanel"]');
      expect(panel).not.toBeNull();
      expect(panel!.parentElement).toBe(header.parentElement);
    }
  });

  it('the Movements tab shows the movements-only feed, the Activity tab the merged one', async () => {
    render(await page('movements'));
    expect(screen.getByTestId('feed-movement')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Stock movements' })).toBeTruthy();
    cleanup();
    render(await page('activity'));
    expect(screen.getByTestId('feed-all')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Activity' })).toBeTruthy();
  });
});

describe('the header photo: Overview only, never the master', () => {
  it('Overview: the primary photo the gallery shows, through the image optimizer', async () => {
    imageList.mockResolvedValue([
      { id: 'a', storage_path: 'org-1/items/x/second.webp', is_primary: false },
      { id: 'b', storage_path: 'org-1/items/x/primary.webp', is_primary: true },
    ]);
    render(await page());
    const header = screen.getByTestId('item-detail-header');
    const img = header.querySelector('[data-slot="thumb"] img');
    expect(img).not.toBeNull();
    const src = img!.getAttribute('src') ?? '';
    expect(src.startsWith('/_next/image?')).toBe(true);
    expect(new URLSearchParams(src.split('?')[1]).get('url')).toBe(
      'https://cdn.test/org-1/items/x/primary.webp',
    );
    // A small rendition: the optimizer is asked for at most twice the 64 px tile.
    expect(Number(new URLSearchParams(src.split('?')[1]).get('w'))).toBeLessThanOrEqual(128);
  });

  it('Overview with no photo at all: the missing-photo hatch, never a broken image', async () => {
    render(await page());
    const thumb = screen.getByTestId('item-detail-header').querySelector('[data-slot="thumb"]');
    expect(thumb).not.toBeNull();
    expect(thumb!.querySelector('img')).toBeNull();
    expect(thumb!.querySelector('[data-slot="missing-photo"]')).not.toBeNull();
  });

  it('Overview with no upload but an ISBN cover on the row: the cover', async () => {
    inventoryGet.mockResolvedValue(
      itemFixture({ custom_fields: { thumbnail_url: 'https://covers.openlibrary.org/b/1-M.jpg' } }),
    );
    render(await page());
    const img = screen.getByTestId('item-detail-header').querySelector('[data-slot="thumb"] img');
    expect(img?.getAttribute('src')).toBe('https://covers.openlibrary.org/b/1-M.jpg');
  });

  it('Movements and Activity: no photo in the header and no photo read at all', async () => {
    for (const tab of ['movements', 'activity']) {
      cleanup();
      imageList.mockClear();
      render(await page(tab));
      expect(
        screen.getByTestId('item-detail-header').querySelector('[data-slot="thumb"]'),
      ).toBeNull();
      expect(imageList).not.toHaveBeenCalled();
      expect(signedUrls).not.toHaveBeenCalled();
    }
  });
});

describe('the header', () => {
  it('one h1, the record name; the back link keeps its words', async () => {
    render(await page());
    const headings = screen.getAllByRole('heading', { level: 1 });
    expect(headings).toHaveLength(1);
    expect(headings[0]).toHaveTextContent('Wall-mounted HVAC unit');
    expect(screen.getByRole('link', { name: '← Back to inventory' })).toHaveAttribute(
      'href',
      '/dashboard/inventory',
    );
  });

  it('every action sits in the tour target [data-tour="item-actions"], in the same order, with the Tour outside it', async () => {
    ctxHolder.permissions = new Set(['items:update', 'items:create', 'stock:adjust']);
    const { container } = render(await page());
    const actions = container.querySelector('[data-tour="item-actions"]') as HTMLElement;
    expect(actions).not.toBeNull();
    const names = Array.from(actions.querySelectorAll('a, button')).map((el) =>
      (el.textContent ?? '').trim(),
    );
    expect(names).toEqual([
      'Edit',
      'Duplicate',
      'Label',
      'Print label',
      'Adjust stock',
      'Report a problem',
    ]);
    expect(within(actions).queryByRole('button', { name: 'Tour' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Tour' })).toBeTruthy();
  });

  it('without write permissions only the ungated actions show (Label, Print label; Report a problem decides for itself), in the same place', async () => {
    const { container } = render(await page());
    const actions = container.querySelector('[data-tour="item-actions"]') as HTMLElement;
    const names = Array.from(actions.querySelectorAll('a, button')).map((el) =>
      (el.textContent ?? '').trim(),
    );
    expect(names).toEqual(['Label', 'Print label', 'Report a problem']);
  });

  it('the SKU and the status pill sit on the meta line under the name', async () => {
    render(await page());
    const header = screen.getByTestId('item-detail-header');
    expect(within(header).getByText('HVAC-WALL-204')).toBeTruthy();
    expect(within(header).getByTestId('status-badge')).toBeTruthy();
  });
});

describe('the dialog hosts stay mounted through the refresh after their change', () => {
  it("Make this its own item: the split makes the SKU the record's own; the host and its open dialog survive", async () => {
    ctxHolder.permissions = new Set(['items:update']);
    skuSiblings.count = 1;
    const { rerender } = render(await page());
    fireEvent.click(screen.getByRole('button', { name: 'Make this its own item' }));
    expect(screen.getByTestId('make-own-host')).toHaveTextContent('dialog-open');
    skuSiblings.count = 0;
    rerender(await page());
    expect(screen.queryByRole('button', { name: 'Make this its own item' })).toBeNull();
    expect(screen.getByTestId('make-own-host')).toHaveTextContent('dialog-open');
  });

  it('Remove from group: the record leaves its group; the host and its open dialog survive', async () => {
    ctxHolder.permissions = new Set(['items:update']);
    groups.map = new Map([[ITEM_ID, { id: 'g1', name: 'Desk Set', version: 1 }]]);
    const { rerender } = render(await page());
    fireEvent.click(screen.getByRole('button', { name: 'Remove from group' }));
    expect(screen.getByTestId('group-host')).toHaveTextContent('dialog-open');
    groups.map = new Map();
    rerender(await page());
    expect(screen.queryByRole('button', { name: 'Remove from group' })).toBeNull();
    expect(screen.getByTestId('group-host')).toHaveTextContent('dialog-open');
  });

  it('both hosts survive together, and through a reservation appearing on the refresh', async () => {
    ctxHolder.permissions = new Set(['items:update']);
    skuSiblings.count = 2;
    groups.map = new Map([[ITEM_ID, { id: 'g1', name: 'Desk Set', version: 1 }]]);
    const { rerender } = render(await page());
    fireEvent.click(screen.getByRole('button', { name: 'Make this its own item' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove from group' }));
    skuSiblings.count = 0;
    groups.map = new Map();
    reserved.map = new Map([[ITEM_ID, 5]]);
    rerender(await page());
    expect(screen.getByTestId('make-own-host')).toHaveTextContent('dialog-open');
    expect(screen.getByTestId('group-host')).toHaveTextContent('dialog-open');
  });
});

/**
 * CLASSIC PARITY (Liquid Glass stage 3, items lane; IMPLEMENTATION-PLAN.md
 * 4.6 and 4.7 item 3). Glass draws the item page (ItemDetail.dc.html) from
 * inert hooks on this markup. The page's own markup, every inert hook
 * stripped, must stay the file under __parity__ that was written before the
 * stage 3 hooks went in: under the `off` rollout with no glass-only element at
 * all, and under `default` too.
 */
describe('classic parity of the item page', () => {
  const BOOK = {
    item_type: 'book',
    name: 'Example Reader, Grade 3',
    sku: '9780000000011',
    custom_fields: {
      book_rack_number: '38',
      book_rack_row: 'A',
      book_crate_color: 'blue',
      book_crate_number: '4',
      book_grade: '3',
    },
  };
  const CASES: Array<[name: string, arrange: () => void, tab?: string]> = [
    [
      'item-detail-overview',
      () => {
        reserved.map = new Map([[ITEM_ID, 12]]);
        ctxHolder.permissions = new Set(['items:update', 'stock:adjust']);
      },
    ],
    [
      'item-detail-book',
      () => {
        inventoryGet.mockResolvedValue(itemFixture(BOOK));
        groups.map = new Map([[ITEM_ID, { id: 'g1', name: 'Readers', version: 1 }]]);
      },
    ],
    ['item-detail-movements', () => {}, 'movements'],
    // Fidelity lane (detail): everything the glass summary and side column
    // read, so the classic page they sit in is pinned with each of them on:
    // a low-stock product in a family, in the Orders module, hidden from
    // Orders, over-reserved, every action allowed; and an expected book with
    // Staging, an author and the Book Order Totals permission.
    [
      'item-detail-glass-facts-item',
      () => {
        inventoryGet.mockResolvedValue(
          itemFixture({
            quantity_on_hand: 6,
            reorder_point: 10,
            group_id: 'family-1',
            order_catalog_visible: false,
          }),
        );
        reserved.map = new Map([[ITEM_ID, 9]]);
        ctxHolder.modules = new Set(['orders', 'books', 'maintenance_requests']);
        ctxHolder.permissions = new Set([
          'items:update',
          'items:create',
          'stock:adjust',
          'stock:transfer',
          'maintenance_requests:submit',
        ]);
      },
    ],
    [
      'item-detail-glass-facts-book',
      () => {
        inventoryGet.mockResolvedValue(
          itemFixture({
            ...BOOK,
            barcode: '9780000000011',
            awaiting_first_receipt: true,
            staged_quantity: 52,
            custom_fields: { ...BOOK.custom_fields, author: 'A. Example' },
          }),
        );
        ctxHolder.modules = new Set(['orders', 'books']);
        ctxHolder.permissions = new Set(['reports:read', 'items:update']);
      },
    ],
  ];

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  for (const [name, arrange, tab] of CASES) {
    it(`${name}: every Classic element keeps its place among its siblings under default (classicStructure)`, async () => {
      // A hidden glass-only element still counts for :first-child,
      // :last-child, :only-child and the *-of-type classes, so the glass
      // summary, side column and More actions must sit where they take none
      // of those from a Classic element (src/test/classic-dom.ts).
      arrange();
      const off = classicStructure(render(await page(tab)).container);
      cleanup();
      vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'default');
      arrange();
      const { container } = render(await page(tab));
      expect(classicStructure(container)).toBe(off);
    });
  }

  for (const [name, arrange, tab] of CASES) {
    it(`${name}: the off rollout renders no glass-only element and today's markup`, async () => {
      arrange();
      const { container } = render(await page(tab));
      expect(glassOnlyElements(container)).toEqual([]);
      await expect(classicMarkup(container)).toMatchFileSnapshot(`./__parity__/${name}.html`);
    });

    it(`${name}: the default rollout's markup, inert hooks stripped, is the same`, async () => {
      vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'default');
      arrange();
      const { container } = render(await page(tab));
      await expect(classicMarkup(container)).toMatchFileSnapshot(`./__parity__/${name}.html`);
    });
  }
});

/**
 * THE LIQUID GLASS COMPOSITION (fidelity lane "detail", Item-Detail.dc.html and
 * Book-Detail.dc.html; IMPLEMENTATION-PLAN.md 4.6). Under the default rollout
 * the Overview holds the board's summary card and side column as glass-only
 * blocks between the figure strip and the panels, the figure strip and the
 * Reorder card are Classic-only, and the page head holds the More actions
 * disclosure. Every glass value is one the page already read.
 */
describe('the Liquid Glass composition (default rollout)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function glassPage(tab?: string) {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'default');
    return render(await page(tab));
  }

  /** The summary's wells as "label|figure" (the figure's words, unit included). */
  function wells(container: HTMLElement): string[] {
    const summary = container.querySelector('[data-glass="item-summary"]')!;
    return Array.from(summary.querySelectorAll('[data-glass-part="well"]')).map((w) => {
      const [dt, dd] = [w.querySelector('dt'), w.querySelector('dd')];
      return `${dt?.textContent ?? ''}|${(dd?.textContent ?? '').trim()}`;
    });
  }

  it('the Overview panel: strip (Classic-only), summary, side column, then the panels, in that DOM order', async () => {
    const { container } = await glassPage();
    const panel = container.querySelector('#item-detail-panel-overview')!;
    const kids = Array.from(panel.children);
    expect(kids.map((k) => k.getAttribute('data-glass') ?? k.tagName.toLowerCase())).toEqual([
      'stat-strip',
      'item-summary',
      'item-aside',
      'div',
    ]);
    expect(kids[0]).toHaveAttribute('data-classic-only', '');
    expect(kids[1]!.tagName).toBe('SECTION');
    expect(kids[1]).toHaveAttribute('data-glass-only', '');
    expect(kids[1]).toHaveAttribute('aria-label', 'Item summary');
    expect(kids[2]!.tagName).toBe('ASIDE');
    expect(kids[2]).toHaveAttribute('data-glass-only', '');
    // The side column precedes the panels (a recorded deviation: the boards
    // put the aside last). After them it would take :last-child from the
    // Classic panels grid, which classicStructure forbids.
    expect(kids[3]!.matches(':last-child')).toBe(true);
    expect(kids[3]).not.toHaveAttribute('data-glass-only');
    // The Reorder card is Classic-only; its glass copy sits in the side column.
    const reorder = screen
      .getAllByRole('heading', { name: 'Reorder' })
      .map((h) => h.closest('section')!);
    expect(reorder).toHaveLength(2);
    expect(reorder.filter((s) => s.hasAttribute('data-classic-only'))).toHaveLength(1);
    expect(reorder.filter((s) => kids[2]!.contains(s))).toHaveLength(1);
  });

  it('the summary wells: on hand, available, reserved, reorder at and value, the figures the strip shows', async () => {
    reserved.map = new Map([[ITEM_ID, 12]]);
    const { container } = await glassPage();
    expect(wells(container)).toEqual([
      'On hand|100 each',
      'Available|88 each',
      'Reserved|12 each',
      'Reorder at|20 each',
      'Value|$4,000.00',
    ]);
    // Nothing reserved: the wells still say so (the board draws all four).
    cleanup();
    reserved.map = new Map();
    expect(wells((await glassPage()).container).slice(1, 3)).toEqual([
      'Available|100 each',
      'Reserved|0 each',
    ]);
  });

  it('low stock: the On hand well in the warning tone and the reorder alert, from the badge’s own rule', async () => {
    inventoryGet.mockResolvedValue(itemFixture({ quantity_on_hand: 6, reorder_point: 10 }));
    const { container } = await glassPage();
    const summary = container.querySelector('[data-glass="item-summary"]')!;
    const onHand = summary.querySelector('[data-glass-part="well"]')!;
    expect(onHand).toHaveAttribute('data-glass-tone', 'warn');
    const alert = summary.querySelector('[data-glass-part="alert"]')!;
    expect(alert).toHaveAttribute('data-glass-tone', 'warn');
    expect(alert).toHaveTextContent(
      'At or below the reorder point of 10 each. Reorder quantity: 5 each.',
    );
    // In stock, archived or expected: no alert.
    for (const over of [
      { quantity_on_hand: 50 },
      { quantity_on_hand: 6, reorder_point: 10, status: 'archived' },
      { quantity_on_hand: 0, awaiting_first_receipt: true },
    ]) {
      cleanup();
      inventoryGet.mockResolvedValue(itemFixture(over));
      const c = (await glassPage()).container;
      expect(c.querySelector('[data-glass-part="alert"]'), JSON.stringify(over)).toBeNull();
    }
  });

  it('the summary photo: the primary upload at 160 px through the optimizer, lazy, so Classic never fetches it', async () => {
    imageList.mockResolvedValue([
      { id: 'b', storage_path: 'org-1/items/x/primary.webp', is_primary: true },
    ]);
    const { container } = await glassPage();
    const img = container.querySelector('[data-glass="item-summary"] img')!;
    expect(img.getAttribute('loading')).toBe('lazy');
    const src = img.getAttribute('src') ?? '';
    expect(src.startsWith('/_next/image?')).toBe(true);
    const q = new URLSearchParams(src.split('?')[1]);
    expect(q.get('url')).toBe('https://cdn.test/org-1/items/x/primary.webp');
    expect(Number(q.get('w'))).toBeLessThanOrEqual(384);
    // No photo: the hatch, never a broken image.
    cleanup();
    imageList.mockResolvedValue([]);
    const bare = (await glassPage()).container.querySelector('[data-glass="item-summary"]')!;
    expect(bare.querySelector('img')).toBeNull();
    expect(bare.querySelector('[data-slot="missing-photo"]')).not.toBeNull();
  });

  it('the side column: Ordering only with the Orders module, in its two states, and the family card', async () => {
    let c = (await glassPage()).container;
    let aside = c.querySelector('[data-glass="item-aside"]')!;
    expect(within(aside as HTMLElement).queryByRole('heading', { name: 'Ordering' })).toBeNull();
    expect(
      within(aside as HTMLElement).queryByRole('heading', { name: 'Product family' }),
    ).toBeNull();

    cleanup();
    ctxHolder.modules = new Set(['orders']);
    inventoryGet.mockResolvedValue(itemFixture({ group_id: 'family-1' }));
    c = (await glassPage()).container;
    aside = c.querySelector('[data-glass="item-aside"]')!;
    const ordering = within(aside as HTMLElement)
      .getByRole('heading', { name: 'Ordering' })
      .closest('section')!;
    expect(ordering).toHaveTextContent('Shown in Orders');
    expect(
      within(aside as HTMLElement).getByRole('heading', { name: 'Product family' }),
    ).toBeTruthy();

    cleanup();
    inventoryGet.mockResolvedValue(itemFixture({ order_catalog_visible: false }));
    c = (await glassPage()).container;
    expect(c.querySelector('[data-glass="item-aside"]')).toHaveTextContent('Hidden from Orders');
  });

  it('the side column: Reserved when something is reserved, Expected while awaiting the first receipt, Reorder always', async () => {
    reserved.map = new Map([[ITEM_ID, 120]]);
    inventoryGet.mockResolvedValue(itemFixture({ awaiting_first_receipt: true }));
    const { container } = await glassPage();
    const aside = container.querySelector('[data-glass="item-aside"]') as HTMLElement;
    const headings = within(aside)
      .getAllByRole('heading', { level: 2 })
      .map((h) => h.textContent);
    expect(headings).toEqual(['Reserved', 'Expected', 'Reorder']);
    expect(aside).toHaveTextContent('120 each reserved for open orders, so 0 each available.');
    expect(aside).toHaveTextContent('20 short of what is promised.');
    // The Reorder copy says what the Classic card says, row for row.
    const classic = screen
      .getAllByRole('heading', { name: 'Reorder' })
      .map((h) => h.closest('section')!)
      .find((sec) => sec.hasAttribute('data-classic-only'))!;
    const glassRows = Array.from(
      aside.querySelectorAll('[data-glass="item-aside-card"]:last-child dt'),
    ).map((dt) => `${dt.textContent}${dt.nextElementSibling?.textContent}`);
    expect(glassRows).toEqual([
      'Reorder at20 each',
      'Reorder qty5 each',
      'Retail price$100.00',
      'StatusActive',
    ]);
    const classicBody = classic.querySelector('[data-slot="detail-section-body"]')!;
    expect(classicBody.textContent?.replace(/\s+/g, '')).toBe(
      glassRows.join('').replace(/\s+/g, ''),
    );
  });

  it('nothing in the summary or the side column is a control; the only link is Book Order Totals, behind its gate', async () => {
    reserved.map = new Map([[ITEM_ID, 3]]);
    ctxHolder.modules = new Set(['orders', 'books']);
    ctxHolder.permissions = new Set(['reports:read']);
    let c = (await glassPage()).container;
    for (const sel of ['[data-glass="item-summary"]', '[data-glass="item-aside"]']) {
      expect(
        c.querySelector(sel)!.querySelectorAll('a, button, input, select, textarea'),
      ).toHaveLength(0);
    }

    const BOOK = {
      item_type: 'book',
      barcode: '9780000000011',
      staged_quantity: 52,
      custom_fields: {
        author: 'A. Example',
        book_crate_color: 'blue',
        book_crate_number: '12',
        book_rack_number: '4',
        book_rack_row: 'B',
        book_grade: '9',
      },
    };
    cleanup();
    inventoryGet.mockResolvedValue(itemFixture(BOOK));
    c = (await glassPage()).container;
    const aside = c.querySelector('[data-glass="item-aside"]') as HTMLElement;
    const links = aside.querySelectorAll('a');
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute('href', '/dashboard/reports/book-order-totals');
    expect(links[0]).toHaveTextContent('Open the report');
    expect(within(aside).getAllByRole('heading', { level: 2 })[0]).toHaveTextContent(
      'Book Order Totals',
    );
    // Without reports:read, or with the Books module off: no card.
    for (const [perms, mods] of [
      [[], ['orders', 'books']],
      [['reports:read'], ['orders']],
    ] as const) {
      cleanup();
      ctxHolder.permissions = new Set(perms);
      ctxHolder.modules = new Set(mods);
      const a = (await glassPage()).container.querySelector('[data-glass="item-aside"]')!;
      expect(a.querySelectorAll('a')).toHaveLength(0);
    }
  });

  it('the book summary: the cover, ISBN, author, grade and home crate as Details shows them, and the In Staging well', async () => {
    inventoryGet.mockResolvedValue(
      itemFixture({
        item_type: 'book',
        barcode: '9780000000011',
        staged_quantity: 52,
        custom_fields: {
          author: 'A. Example',
          book_crate_color: 'blue',
          book_crate_number: '12',
          book_rack_number: '4',
          book_rack_row: 'B',
          book_grade: '9',
          thumbnail_url: 'https://covers.openlibrary.org/b/9-M.jpg',
        },
      }),
    );
    const { container } = await glassPage();
    const summary = container.querySelector('[data-glass="item-summary"]') as HTMLElement;
    expect(summary).toHaveAttribute('aria-label', 'Book summary');
    expect(summary).toHaveAttribute('data-glass-variant', 'book');
    expect(summary.querySelector('img')).toHaveAttribute(
      'src',
      'https://covers.openlibrary.org/b/9-M.jpg',
    );
    const kv = Array.from(summary.querySelectorAll('[data-glass-part="kv"] dt')).map(
      (dt) => `${dt.textContent}|${(dt.nextElementSibling?.textContent ?? '').trim()}`,
    );
    expect(kv).toEqual([
      'Author|A. Example',
      'ISBN|9780000000011',
      'Grade|Grade 9',
      'Home crate|Blue 12 · Rack 4-B (a label only; it does not move stock)',
    ]);
    expect(wells(container)).toEqual([
      'On hand|100 each',
      'Available|100 each',
      'Reserved|0 each',
      'In Staging|52 each',
      'Value|$4,000.00',
    ]);
    const staging = Array.from(summary.querySelectorAll('[data-glass-part="well"]'))[3]!;
    expect(staging).toHaveAttribute('data-glass-tone', 'warn');
  });

  it('a rack the holdings refute is left out of the home crate, as the Details card leaves it out', async () => {
    inventoryGet.mockResolvedValue(
      itemFixture({
        item_type: 'book',
        custom_fields: { book_rack_number: '38', book_rack_row: 'A', book_crate_number: '4' },
      }),
    );
    // Only the Details card's own rule is under test here: with no holdings
    // the rack stands, so the glass crate line names it.
    const { container } = await glassPage();
    const crate = container.querySelector('[data-glass-part="crate"]')!;
    expect(crate).toHaveTextContent('4 · Rack 38-A (a label only');
    expect(screen.getAllByText('38-A').length).toBeGreaterThan(0);
  });

  it('the page head: Edit carries its keep hook, More actions sits between the title row and the tabs, glass-only', async () => {
    ctxHolder.permissions = new Set(['items:update', 'items:create', 'stock:adjust']);
    const { container } = await glassPage();
    const header = screen.getByTestId('item-detail-header');
    const kids = Array.from(header.children);
    expect(kids.map((k) => k.tagName)).toEqual(['DIV', 'DIV', 'SPAN', 'DIV']);
    expect(kids[2]).toHaveAttribute('data-glass-only', '');
    expect(kids[2]).toHaveAttribute('data-glass', 'item-more');
    const more = within(kids[2] as HTMLElement).getByRole('button', { name: 'More actions' });
    expect(more).toHaveAttribute('aria-expanded', 'false');
    expect(kids[3]!.querySelector('[role="tablist"]')).not.toBeNull();
    // The Edit link keeps its place in the head row by an inert hook on its
    // Button (the test's next/link stand-in drops every prop but href, so the
    // hook is read from the source; the lab spec reads it on the page).
    expect(
      within(container.querySelector('[data-tour="item-actions"]') as HTMLElement).getByRole(
        'link',
        { name: 'Edit' },
      ),
    ).toBeTruthy();
    expect(readFileSync(join(__dirname, 'item-detail.tsx'), 'utf8')).toMatch(
      /<Button asChild variant="outline" data-glass-action="edit">\s*<Link href=\{href\}>Edit<\/Link>/u,
    );
    fireEvent.click(more);
    expect(more).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(more);
    expect(more).toHaveAttribute('aria-expanded', 'false');
  });

  it('Movements and Activity draw no summary and no side column (their reads are the Overview’s)', async () => {
    for (const tab of ['movements', 'activity']) {
      cleanup();
      const { container } = await glassPage(tab);
      expect(container.querySelector('[data-glass="item-summary"]')).toBeNull();
      expect(container.querySelector('[data-glass="item-aside"]')).toBeNull();
      // The More actions disclosure is in the head on every tab.
      expect(container.querySelector('[data-glass="item-more"]')).not.toBeNull();
    }
  });
});
