import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
      enabledModules: new Set<string>(),
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
