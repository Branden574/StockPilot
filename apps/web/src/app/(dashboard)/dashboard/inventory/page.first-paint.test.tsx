import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * OWNER BUG 2026-10-05: on a refresh of Items, the first paint showed one page
 * ("Showing 1–30 of 455", "Page 1 of 16", "455 items", families cut at row 30)
 * and about half a second later the table re-drew a different one ("Showing
 * 1–24 of 455", "Page 1 of 17", "441 SKUs · 455 rows", families whole, rows
 * 18-30 moved to page 2). The owner read it as items disappearing.
 *
 * The first paint comes from the cached default-view loader; the second from
 * the full dataset the page streams behind it (instant mode). This suite runs
 * BOTH real loaders, the real page and the real table over one synthetic,
 * L4L-shaped view (src/test/inventory-first-page-fixture.ts) and asserts the
 * page the server paints is the page the table settles on: the same rows in
 * the same order, the same groups and group sizes, the same "Showing a–b of
 * N", the same page count and the same footer. Only the data layer is faked
 * (an in-memory PostgREST that evaluates the loaders' own queries); signing,
 * auth and the services the default view never calls are stubbed.
 */

const h = vi.hoisted(() => ({
  db: null as null | import('@/test/inventory-first-page-fixture').FixtureDb,
  log: [] as import('@/test/inventory-first-page-fixture').ExecutedQuery[],
  /** Holds the instant dataset's first query until the test lets it go. */
  holdDataset: null as null | Promise<void>,
  filter: null as string | null,
  tableProps: [] as Array<Record<string, unknown>>,
}));

// useSearchParams follows the URL the way Next's router does: setting it
// re-renders whoever reads it (a shallow history push in production).
const { routerMock, nav } = vi.hoisted(() => {
  const routerMock = { replace: vi.fn(), push: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() };
  let instance = new URLSearchParams('');
  const listeners = new Set<() => void>();
  const nav = {
    get: () => instance,
    set(next: string) {
      if (next === instance.toString()) return;
      instance = new URLSearchParams(next);
      for (const l of listeners) l();
    },
    subscribe(l: () => void) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
  return { routerMock, nav };
});

vi.mock('next/navigation', async () => {
  const React = await import('react');
  return {
    useRouter: () => routerMock,
    useSearchParams: () => React.useSyncExternalStore(nav.subscribe, nav.get, nav.get),
    usePathname: () => '/dashboard/inventory',
  };
});

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

vi.mock('next/cache', () => ({
  revalidateTag: vi.fn(),
  unstable_cache: vi.fn((fn: unknown) => fn),
}));

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), message: vi.fn() } }));

vi.mock('@/server/actions/saved-views', () => ({
  createSavedViewAction: vi.fn(),
  deleteSavedViewAction: vi.fn(),
  setActiveWarehouseAction: vi.fn(),
  toggleSavedViewShareAction: vi.fn(),
}));
vi.mock('@/lib/download-export', () => ({ downloadInventoryExport: vi.fn() }));
vi.mock('@/components/inventory/bulk-actions', () => ({ BulkActions: () => null }));
vi.mock('@/components/ui/image-hover-preview', () => ({
  ImageHoverPreview: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  prewarmPreviewImages: vi.fn(),
}));
vi.mock('@/lib/cycle-counts/use-count-selection', () => ({
  useCountSelection: (selector: (s: { add: () => void }) => unknown) => selector({ add: vi.fn() }),
}));

// Page chrome that reads request state of its own. (The Active / Archived
// toggle is the real one: the URL probe below follows its Active link.)
vi.mock('@/components/inventory/rack-filter-dropdown', () => ({ RackFilterDropdown: () => null }));
vi.mock('@/components/dashboard/scoped-warehouse-notice', () => ({
  ScopedWarehouseNotice: () => null,
}));
vi.mock('@/components/inventory/clear-warehouse-filter-button', () => ({
  ClearWarehouseFilterButton: () => null,
}));
vi.mock('@/components/onboarding/page-tour', () => ({ PageTour: () => null }));
vi.mock('@/components/onboarding/tour-sample-item', () => ({ TourSampleItem: () => null }));

// The REAL table, wrapped only to see the props the page hands it.
vi.mock('@/components/inventory/inventory-table', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/components/inventory/inventory-table')>();
  const Wrapped = (props: React.ComponentProps<typeof mod.InventoryTable>) => {
    h.tableProps.push(props as unknown as Record<string, unknown>);
    return <mod.InventoryTable {...props} />;
  };
  return { ...mod, InventoryTable: Wrapped };
});

vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => {
    const { FIXTURE_ORG } = await import('@/test/inventory-first-page-fixture');
    return { organizationId: FIXTURE_ORG, userId: 'u-1', role: 'manager' };
  }),
}));
vi.mock('@/lib/nav-labels', () => ({ effectiveNavLabel: vi.fn(async () => 'Inventory') }));
vi.mock('@/lib/warehouse-filter', () => ({
  getActiveWarehouseFilter: vi.fn(async () => h.filter),
}));
vi.mock('@/lib/auth/warehouse', () => ({ getWarehouseAccess: vi.fn() }));
vi.mock('@/lib/dashboard/request-cache', () => ({
  getWarehousesForRequest: vi.fn(async () => {
    const { WH_NORTH, WH_SOUTH } = await import('@/test/inventory-first-page-fixture');
    return [
      { id: WH_NORTH, name: 'North' },
      { id: WH_SOUTH, name: 'South' },
    ];
  }),
  readWarehousesForRequest: vi.fn(async () => ({ rows: [], failed: false })),
  getModulesForRequest: vi.fn(async () => new Set(['orders'])),
}));
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }));

// The data layer: every loader query goes to the in-memory PostgREST.
vi.mock('@/lib/supabase/admin', async () => {
  const { makeFakeAdmin } = await import('@/test/inventory-first-page-fixture');
  return {
    createAdminClient: vi.fn(() =>
      makeFakeAdmin(h.db!, {
        log: h.log,
        beforeAnswer: (q) => {
          // The instant dataset's first query: its head count (the default
          // view's own Expected count filters on the flag).
          const datasetHead =
            q.table === 'inventory_items' &&
            q.head &&
            !q.filters.some((f) => f.path[0] === 'awaiting_first_receipt');
          // Held only when the page STREAMS the dataset behind its first
          // paint: the cached default view reads its page-1 plan first (the
          // one read that embeds the holdings). A URL that awaits the dataset
          // never makes that read, and holding it there would hold the page.
          const planned = h.log.some(
            (e) =>
              e.table === 'inventory_items' && e.select.includes('item_stock_levels(quantity)'),
          );
          if (datasetHead && h.holdDataset && planned) return h.holdDataset;
        },
      }),
    ),
  };
});

vi.mock('@/server/services/context', () => ({
  withContext: vi.fn(),
  assertPermission: vi.fn(),
  ServiceError: class ServiceError extends Error {
    constructor(
      public code: string,
      public internalDetail?: string,
    ) {
      super(code);
    }
  },
}));

// Signing is deterministic, so a photo only "changes" if the row does.
vi.mock('@/server/services/item-images', () => ({
  ItemImagesService: class {
    static async forCurrentUser() {
      throw new Error('the live image path must not run for a manager here');
    }
    async signedUrls(paths: string[]) {
      return new Map(paths.map((p) => [p, `https://signed.test/${p}`]));
    }
  },
}));

// Services the manager default view and its deep links never read.
const { liveOnly } = vi.hoisted(() => ({
  liveOnly: (what: string) => async () => {
    throw new Error(`${what} must not run on the manager cached path`);
  },
}));
vi.mock('@/server/services/inventory', () => ({
  InventoryService: {
    forCurrentUser: vi.fn(async () => ({
      listDistinctRacks: vi.fn(async () => []),
      list: liveOnly('InventoryService.list'),
      countExpected: liveOnly('InventoryService.countExpected'),
      placementBreakdown: liveOnly('InventoryService.placementBreakdown'),
    })),
  },
}));
vi.mock('@/server/services/movements', () => ({ getItemTrends: liveOnly('getItemTrends') }));
vi.mock('@/server/services/saved-views', () => ({
  SavedViewsService: { forCurrentUser: vi.fn(async () => ({ list: vi.fn(async () => []) })) },
}));
vi.mock('@/server/services/size-run-display', () => ({
  loadCountingUnits: vi.fn(async () => ({})),
  loadCountingUnitsForOrg: vi.fn(async () => ({})),
}));
vi.mock('@/server/services/categories', () => ({
  CategoriesService: { forCurrentUser: liveOnly('categories') },
}));
vi.mock('@/server/services/locations', () => ({
  LocationsService: { forCurrentUser: liveOnly('locations') },
}));
vi.mock('@/server/services/suppliers', () => ({
  SuppliersService: { forCurrentUser: liveOnly('suppliers') },
}));
vi.mock('@/server/services/tags', () => ({ TagsService: { forCurrentUser: liveOnly('tags') } }));
vi.mock('@/server/services/charters', () => ({
  ChartersService: { forCurrentUser: liveOnly('charters') },
}));

import * as fixture from '@/test/inventory-first-page-fixture';
import {
  deriveInstantView,
  instantStateFromPageParams,
  type InstantModeRow,
} from '@/lib/inventory/instant-mode';

import InventoryPage from './page';

/* ---- reading what the person sees ----------------------------------------- */

const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

/** Everything on the list that the two paints must agree on. */
function snapshot(container: HTMLElement) {
  const rows = [...container.querySelectorAll('tbody tr')].map((tr) => ({
    text: norm(tr.textContent),
    links: [...tr.querySelectorAll('a')].map((a) => a.getAttribute('href')),
    photos: [...tr.querySelectorAll('img')].map((img) => img.getAttribute('src')),
  }));
  const spans = [...container.querySelectorAll('span')].map((s) => norm(s.textContent));
  return {
    rows,
    showing: spans.filter((t) => /^Showing \d+–\d+ of \d+$/.test(t)),
    pager: screen
      .queryAllByRole('button', { name: /jump to page/i })
      .map((b) => norm(b.textContent)),
    footer: [...container.querySelectorAll('p')]
      .map((p) => norm(p.textContent))
      .filter((t) => t.endsWith('on hand')),
    expectedChip: [...container.querySelectorAll('a[aria-pressed]')].map((a) =>
      norm(a.textContent),
    ),
    /** An empty state's title ("No items yet"), when the page shows one. */
    headings: [...container.querySelectorAll('h3')].map((n) => norm(n.textContent)),
  };
}

function latestTableProps() {
  return h.tableProps[h.tableProps.length - 1]! as {
    instantPromise?: Promise<unknown>;
  };
}

/** The default view's rows, straight from the fixture tables (for sanity checks). */
function defaultViewRows(warehouse: string | null): InstantModeRow[] {
  return (
    h.db!.tables.inventory_items as unknown as Array<InstantModeRow & Record<string, unknown>>
  ).filter(
    (r) =>
      r.organization_id === fixture.FIXTURE_ORG &&
      r.deleted_at === null &&
      r.item_type === 'product' &&
      r.is_rental === false &&
      (!warehouse || r.warehouse_id === warehouse),
  );
}

let warn: ReturnType<typeof vi.spyOn>;
let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  h.db = fixture.buildFirstPageFixture();
  h.log.length = 0;
  h.holdDataset = null;
  h.filter = null;
  h.tableProps.length = 0;
  nav.set('');
  window.history.replaceState(null, '', '/dashboard/inventory');
  fetchSpy = vi.fn();
  vi.stubGlobal('fetch', fetchSpy);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  // Neither loader may have failed over to another path: a warning here means
  // the test watched a fallback, not the cached first paint.
  expect(warn).not.toHaveBeenCalled();
  warn.mockRestore();
  vi.unstubAllGlobals();
});

/**
 * Render the default view the way a refresh does: the server paints, then the
 * streamed dataset lands and the SAME table instance adopts it. Returns both
 * snapshots and the mounted view (now in instant mode).
 */
async function refreshDefaultView() {
  let releaseDataset!: () => void;
  h.holdDataset = new Promise<void>((resolve) => {
    releaseDataset = resolve;
  });
  const page = await InventoryPage({ searchParams: Promise.resolve({}) });
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(page);
  });
  const firstPaint = snapshot(view.container);

  releaseDataset();
  await act(async () => {
    await latestTableProps().instantPromise;
  });
  // A promise resolved outside a render pass does not ping the suspended
  // boundary in this DOM environment (see inventory-table.instant.test.tsx);
  // re-render the identical tree to give use() its pass. Production needs no
  // nudge.
  view.rerender(page);
  await act(async () => {});
  const settled = snapshot(view.container);
  return { view, page, firstPaint, settled };
}

/** Proves the table really adopted the dataset: in instant mode Next is a
 *  shallow history push instead of a server navigation. */
async function expectInstantMode() {
  const pushState = vi.spyOn(window.history, 'pushState');
  await userEvent.setup().click(screen.getAllByRole('link', { name: /next/i })[0]!);
  expect(pushState).toHaveBeenCalledWith(null, '', '/dashboard/inventory?page=2');
  pushState.mockRestore();
}

describe('Items first paint = settled instant view (owner bug 2026-10-05)', () => {
  it('paints page 1 exactly as the full dataset settles it: same rows in order, same groups, same pager and footer', async () => {
    const { firstPaint, settled } = await refreshDefaultView();

    expect(firstPaint).toEqual(settled);
    await expectInstantMode();

    // The fixture really exercises the bug (a vacuous pass is impossible):
    // group-aware page 1 closes early at 27 rows, families are whole.
    const derived = deriveInstantView(
      defaultViewRows(null),
      instantStateFromPageParams({}),
      'items',
      30,
    );
    expect(derived.total).toBe(fixture.DEFAULT_VIEW_ROWS);
    expect(derived.pageItems.map((r) => r.id)).toEqual(
      fixture.EXPECTED_PAGE_ONE_RANKS.map(fixture.itemIdForRank),
    );
    expect(settled.showing).toEqual(['Showing 1–27 of 150', 'Showing 1–27 of 150']);
    expect(settled.pager).toEqual([
      `Page 1 of ${derived.pageCount}`,
      `Page 1 of ${derived.pageCount}`,
    ]);
    expect(derived.pageCount).toBeGreaterThan(Math.ceil(fixture.DEFAULT_VIEW_ROWS / 30));
    // 150 rows, one SKU shared by two rows (Model B) → 149 SKU lines; the
    // stapler is split across two racks → 151 rendered rows.
    expect(settled.footer).toHaveLength(1);
    expect(settled.footer[0]).toMatch(/^149 SKUs · 151 rows · \$[\d,.]+ on hand$/);
    const text = settled.rows.map((r) => r.text).join('\n');
    expect(text).toMatch(/Learning Tee \(2026\)\s*8 sizes/);
    expect(text).toMatch(/PD Shirt\s*6 sizes/);
    expect(text).toMatch(/Women's Polo\s*5 sizes/);
    expect(text).toContain('1 rack +1 unset');
    expect(text).toMatch(/Nike Pegasus 41\s*2 variants/);
    expect(text).not.toContain("Men's Polo");
    expect(text).not.toContain('Widget 20');
    // Rows the default view excludes never reach either paint.
    for (const hidden of ['Projector', 'Old Stapler', '9 sizes'])
      expect(text).not.toContain(hidden);
  });

  it('makes no client request while it paints and adopts (no fetch, no router call)', async () => {
    await refreshDefaultView();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(routerMock.push).not.toHaveBeenCalled();
    expect(routerMock.replace).not.toHaveBeenCalled();
    expect(routerMock.prefetch).not.toHaveBeenCalled();
    expect(routerMock.refresh).not.toHaveBeenCalled();
  });

  it('page 2 and a deep page land on the same rows whether reached in the browser or opened as a link', async () => {
    const { view, settled } = await refreshDefaultView();
    await expectInstantMode();

    const instantPages: Array<ReturnType<typeof snapshot>> = [];
    for (const n of [2, 4]) {
      await act(async () => nav.set(`page=${n}`));
      instantPages.push(snapshot(view.container));
    }
    view.unmount();

    for (const [i, n] of [2, 4].entries()) {
      nav.set(`page=${n}`);
      window.history.replaceState(null, '', `/dashboard/inventory?page=${n}`);
      const linked = render(
        await InventoryPage({ searchParams: Promise.resolve({ page: String(n) }) }),
      );
      expect(snapshot(linked.container)).toEqual(instantPages[i]);
      linked.unmount();
    }
    // Page 2 starts on the row after page 1's last one: nothing skipped.
    expect(settled.showing[0]).toBe('Showing 1–27 of 150');
    expect(instantPages[0]!.showing[0]).toMatch(/^Showing 28–\d+ of 150$/);
  });

  it('with a warehouse filter (the cache key carries it), the two paints still agree', async () => {
    h.filter = fixture.WH_NORTH;
    const { firstPaint, settled } = await refreshDefaultView();
    expect(firstPaint).toEqual(settled);
    await expectInstantMode();
    // South rows (rank 60 among them) are out of this view.
    const north = deriveInstantView(
      defaultViewRows(fixture.WH_NORTH),
      instantStateFromPageParams({}),
      'items',
      30,
    );
    expect(north.total).toBeLessThan(fixture.DEFAULT_VIEW_ROWS);
    expect(settled.showing[0]).toBe(`Showing 1–${north.pageItems.length} of ${north.total}`);
  });
});

/* ---- URL probe (review 2026-10-05, finding 1) ------------------------------ */

/** The page's searchParams for a query string (a repeated key is an array). */
function pageParams(qs: string) {
  const sp = new URLSearchParams(qs);
  const out: Record<string, string | string[]> = {};
  for (const key of new Set(sp.keys())) {
    const all = sp.getAll(key);
    out[key] = all.length > 1 ? all : all[0]!;
  }
  return out as Awaited<Parameters<typeof InventoryPage>[0]['searchParams']>;
}

/**
 * Open a URL the way a refresh does: the server paints, and when the page
 * streams the dataset behind that paint, it lands and the SAME table adopts it.
 * `streamed` says whether it did (only the cached default view streams).
 */
async function openUrl(qs: string) {
  nav.set(qs);
  window.history.replaceState(null, '', qs ? `/dashboard/inventory?${qs}` : '/dashboard/inventory');
  h.log.length = 0;
  h.tableProps.length = 0;
  let releaseDataset!: () => void;
  h.holdDataset = new Promise<void>((resolve) => {
    releaseDataset = resolve;
  });
  const page = await InventoryPage({ searchParams: Promise.resolve(pageParams(qs)) });
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(page);
  });
  const firstPaint = snapshot(view.container);
  releaseDataset();
  const table = h.tableProps[h.tableProps.length - 1] as
    { instantPromise?: Promise<unknown> } | undefined;
  const streamed = table?.instantPromise;
  if (streamed) {
    await act(async () => {
      await streamed;
    });
    view.rerender(page);
    await act(async () => {});
  }
  return { view, firstPaint, settled: snapshot(view.container), streamed: streamed !== undefined };
}

/** The cached default view's page-1 plan (the one read that embeds holdings). */
const planReads = () =>
  h.log.filter(
    (e) => e.table === 'inventory_items' && e.select.includes('item_stock_levels(quantity)'),
  );

/**
 * isDefaultInventoryView decides which URLs get the cached default page (the
 * planned page 1, re-derived over the streamed dataset once it lands). Every
 * URL it calls default must mean the default view to the table's derivation
 * too. ?auto=1 did not: the Archived view's "Auto-archived only" chip narrows
 * the list to rows the zero-stock job archived, no active row is one, and the
 * Active toggle kept the parameter, so Active painted its first page and then
 * emptied. Each URL here must paint what it settles on.
 */
describe('URL probe: an Items URL paints what it settles on (review 2026-10-05)', () => {
  it.each([
    '',
    'status=active',
    'page=1',
    'sort=updated_desc',
    'type=product',
    'stock=',
    'q=%20%20',
    'rack=%20',
    'ref=mail',
    'auto=0',
    'auto=1',
    'status=active&auto=1',
    'status=archived',
    'status=archived&auto=1',
    'expected=1',
  ])('?%s', async (qs) => {
    const { firstPaint, settled } = await openUrl(qs);
    expect(firstPaint).toEqual(settled);
  });

  it('?auto=1 is not the cached default page: no plan is read and nothing streams', async () => {
    const { streamed } = await openUrl('auto=1');
    expect(streamed).toBe(false);
    expect(planReads()).toEqual([]);
    // The default view itself still plans and streams.
    expect((await openUrl('')).streamed).toBe(true);
    expect(planReads()).toHaveLength(1);
  });

  // A zero result under Auto-archived only is the table's own "No items match
  // your filters." row, as when the chip is switched on in the app (the page's
  // empty-state comment always meant this); a refresh used to say "No items
  // yet" and offer to add a first item.
  it.each([
    ['auto=1', ''],
    ['status=archived&auto=1', 'status=archived'],
  ])(
    '?%s opened as a link shows what the app shows on reaching it from ?%s',
    async (target, from) => {
      const start = await openUrl(from);
      await act(async () => nav.set(target));
      const inApp = snapshot(start.view.container);
      start.view.unmount();

      const { firstPaint } = await openUrl(target);
      expect(firstPaint).toEqual(inApp);
      expect(firstPaint.rows.map((r) => r.text)).toEqual(['No items match your filters.']);
      expect(firstPaint.headings).not.toContain('No items yet');
    },
  );

  it('Active, from the Auto-archived only view, opens the plain list: the toggle drops auto', async () => {
    const { view } = await openUrl('status=archived&auto=1');
    const toggle = within(view.container);
    expect(toggle.getByRole('tab', { name: 'Active' })).toHaveAttribute(
      'href',
      '/dashboard/inventory',
    );
    expect(toggle.getByRole('tab', { name: 'Archived' })).toHaveAttribute(
      'href',
      '/dashboard/inventory?auto=1&status=archived',
    );
  });
});
