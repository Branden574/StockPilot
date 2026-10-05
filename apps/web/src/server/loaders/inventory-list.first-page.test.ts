import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The cached default Items view PLANS its page 1 with the instant-mode
 * derivation (owner bug 2026-10-05: the old fixed 30-row slice re-shuffled
 * into a different page half a second after every refresh, once the streamed
 * dataset arrived). These tests run the REAL loaders against an in-memory
 * PostgREST that evaluates their own queries (src/test/inventory-first-page-
 * fixture.ts) and pin:
 *   • parity: the cached page 1, its rows and its numbers equal what instant
 *     mode derives from the dataset loader's rows;
 *   • cost: a cold fill is still two waves of requests, the same four
 *     requests as before for every view under 1,000 rows;
 *   • the exceptions keep today's fixed slice (Books, views over the cap);
 *   • the edges: 1,001-2,000 rows, a write between reads, a family larger
 *     than one id batch.
 */

const h = vi.hoisted(() => ({
  admin: null as unknown,
}));

vi.mock('next/cache', () => ({
  revalidateTag: vi.fn(),
  unstable_cache: vi.fn((fn: unknown) => fn),
}));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => h.admin }));
vi.mock('@/server/services/context', () => ({
  withContext: vi.fn(),
  assertPermission: vi.fn(),
  ServiceError: class ServiceError extends Error {
    constructor(
      public code: string,
      public internalDetail?: string,
    ) {
      super(internalDetail ?? code);
    }
  },
}));
vi.mock('@/server/services/item-images', () => ({
  ItemImagesService: class {
    async signedUrls(paths: string[]) {
      return new Map(paths.map((p) => [p, `https://signed.test/${p}`]));
    }
  },
}));

import {
  countDistinctSkuLines,
  countItemRowsBySku,
  countPlacementRows,
  deriveInstantView,
  instantStateFromPageParams,
} from '@/lib/inventory/instant-mode';
import {
  buildFirstPageFixture,
  DEFAULT_VIEW_ROWS,
  EXPECTED_PAGE_ONE_RANKS,
  FIXTURE_ORG,
  itemIdForRank,
  makeFakeAdmin,
  makeWaveGate,
  type ExecutedQuery,
  type FakeRow,
  type FixtureDb,
} from '@/test/inventory-first-page-fixture';

import { loadInventoryDataset, loadInventoryList } from './inventory-list';

const DEFAULT_STATE = instantStateFromPageParams({});

function serveDb(db: FixtureDb, hooks: Parameters<typeof makeFakeAdmin>[1] = {}) {
  h.admin = makeFakeAdmin(db, hooks);
}

/** What instant mode derives from the dataset loader's rows. */
async function instantPageOne(db: FixtureDb, warehouseKey = 'all') {
  serveDb(db);
  const dataset = await loadInventoryDataset(FIXTURE_ORG, warehouseKey, 'items');
  expect(dataset).not.toBeNull();
  const derived = deriveInstantView(dataset!.items, DEFAULT_STATE, 'items', 30);
  const bySku = countItemRowsBySku(derived.filteredRows);
  return {
    dataset: dataset!,
    derived,
    firstPage: {
      pageCount: derived.pageCount,
      pageItemCount: derived.pageItems.length,
      distinctSkus: countDistinctSkuLines(derived.filteredRows),
      placementRows: countPlacementRows(
        derived.filteredRows,
        (id) => dataset!.placement[id]?.length ?? 0,
      ),
      skuItemRowCounts: [...new Set(derived.pageItems.map((r) => r.sku))]
        .filter((sku) => bySku.has(sku))
        .map((sku) => [sku, bySku.get(sku)!] as [string, number]),
    },
  };
}

/** Runs `fn` with every query held until released wave by wave. */
async function inWaves<T>(
  db: FixtureDb,
  fn: () => Promise<T>,
  extra: Parameters<typeof makeFakeAdmin>[1] = {},
) {
  const gate = makeWaveGate();
  const log: ExecutedQuery[] = [];
  serveDb(db, {
    log,
    beforeAnswer: async (q) => {
      await extra.beforeAnswer?.(q);
      await gate.beforeAnswer(q);
    },
  });
  let settled = false;
  const p = fn().finally(() => {
    settled = true;
  });
  p.catch(() => {});
  const waves: ExecutedQuery[][] = [];
  for (let i = 0; i < 40 && !settled; i++) {
    await new Promise((r) => setTimeout(r, 0));
    if (gate.waitingCount > 0) waves.push(gate.release());
  }
  return { result: p, waves, log };
}

/** Only the row-loader's own queries (the sibling loaders run beside it). */
function rowWaves(waves: ExecutedQuery[][]) {
  return waves
    .map((w) =>
      w
        .filter((q) => ['inventory_items', 'item_stock_levels', 'item_images'].includes(q.table))
        .map((q) => `${q.table}${q.head ? ' (count)' : ''}`)
        .sort(),
    )
    .filter((w) => w.length > 0);
}

/** A plain synthetic view of `n` active product rows (single items, one
 *  holding each), newest first, for the size-dependent paths. */
function bigView(
  n: number,
  opts: { archivedNewest?: number; family?: { sku: string; size: number } } = {},
): FixtureDb {
  const db = buildFirstPageFixture();
  const base = Date.UTC(2026, 6, 1, 0, 0, 0);
  const items: FakeRow[] = [];
  const levels: FakeRow[] = [];
  for (let i = 0; i < n; i++) {
    const id = `${(Math.imul(i + 3, 2654435761) >>> 0).toString(16).padStart(8, '0')}-0009-4000-8000-${String(i).padStart(12, '0')}`;
    const inFamily = opts.family && i < opts.family.size;
    items.push({
      ...(db.tables.inventory_items![0] as FakeRow),
      id,
      sku: inFamily ? opts.family!.sku : `BIG-${i}`,
      name: inFamily ? 'Family Member' : `Big Item ${i}`,
      status: i < (opts.archivedNewest ?? 0) ? 'archived' : 'active',
      group_id: null,
      quantity_on_hand: 3,
      updated_at: new Date(base - i * 1000).toISOString(),
    });
    levels.push({
      id: `lv-${i}`,
      organization_id: FIXTURE_ORG,
      item_id: id,
      location_id: 'loc-R-1',
      quantity: 3,
    });
  }
  db.tables.inventory_items = items;
  db.tables.item_stock_levels = levels;
  db.tables.item_images = [];
  return db;
}

describe('cached default Items view: page 1 is planned with the instant derivation', () => {
  let db: FixtureDb;
  beforeEach(() => {
    vi.clearAllMocks();
    db = buildFirstPageFixture();
  });

  it('page 1, its rows and its numbers equal what instant mode derives from the dataset', async () => {
    const instant = await instantPageOne(db);
    serveDb(db);
    const payload = await loadInventoryList(FIXTURE_ORG, 'all', 'items');

    // Same rows, same order: the families whole (members pulled up from
    // ranks 60, 67, 71, 74, 90, 95, 100, 110, 115), the 9-member run that
    // does not fit left for page 2.
    expect(payload.items.map((r) => r.id)).toEqual(instant.derived.pageItems.map((r) => r.id));
    expect(payload.items.map((r) => r.id)).toEqual(EXPECTED_PAGE_ONE_RANKS.map(itemIdForRank));
    // Same row DATA (columns, placement summary, photo paths) as the dataset
    // hands instant mode, so adoption re-renders nothing.
    const datasetById = new Map(instant.dataset.items.map((r) => [r.id, r]));
    for (const row of payload.items) expect(row).toEqual(datasetById.get(row.id));
    for (const row of payload.items) {
      expect(payload.placement[row.id] ?? []).toEqual(instant.dataset.placement[row.id] ?? []);
    }
    // Same numbers the table prints.
    expect(payload.firstPage).toEqual(instant.firstPage);
    expect(payload.total).toBe(instant.derived.total);
    expect(payload.total).toBe(DEFAULT_VIEW_ROWS);
    expect(payload.expectedCount).toBe(
      instant.dataset.items.filter((r) => r.awaiting_first_receipt).length,
    );
    expect(payload.expectedCount).toBe(2);
    // The scenario is real: page 1 closes early and the pager gains a page.
    expect(payload.firstPage!.pageItemCount).toBe(27);
    expect(payload.firstPage!.pageCount).toBeGreaterThan(Math.ceil(DEFAULT_VIEW_ROWS / 30));
    expect(payload.firstPage!.distinctSkus).toBe(DEFAULT_VIEW_ROWS - 1);
    expect(payload.firstPage!.placementRows).toBe(DEFAULT_VIEW_ROWS + 1);
  });

  it('with a warehouse filter the plan and the dataset agree on that warehouse', async () => {
    const wh = '0e000000-0000-4000-8000-000000000001';
    const instant = await instantPageOne(db, wh);
    serveDb(db);
    const payload = await loadInventoryList(FIXTURE_ORG, wh, 'items');
    expect(payload.items.map((r) => r.id)).toEqual(instant.derived.pageItems.map((r) => r.id));
    expect(payload.firstPage).toEqual(instant.firstPage);
    expect(payload.total).toBeLessThan(DEFAULT_VIEW_ROWS);
  });

  it('page 1 does not depend on any column the narrow read leaves out', async () => {
    serveDb(db);
    const before = await loadInventoryList(FIXTURE_ORG, 'all', 'items');
    // Scramble every column the narrow read does not carry. The default URL
    // state must not read them, or the plan would disagree with instant mode.
    let seed = 1;
    const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
    for (const r of db.tables.inventory_items!) {
      r.quantity_on_hand = Math.floor(rnd() * 500);
      r.unit_cost = Math.floor(rnd() * 100);
      r.reorder_point = Math.floor(rnd() * 50);
      r.category_id = rnd() < 0.5 ? 'cat-x' : null;
      r.charter_id = rnd() < 0.5 ? 'charter-x' : null;
      r.primary_location_id = rnd() < 0.5 ? 'loc-R-1' : null;
      r.custom_fields = { rack_number: String(Math.floor(rnd() * 9)), rack_row: 'A' };
      r.barcode = String(Math.floor(rnd() * 1e9));
      r.created_at = new Date(Date.UTC(2025, 0, 1) + Math.floor(rnd() * 1e10)).toISOString();
      r.auto_archived = rnd() < 0.5;
    }
    const instant = await instantPageOne(db);
    serveDb(db);
    const after = await loadInventoryList(FIXTURE_ORG, 'all', 'items');
    expect(after.items.map((r) => r.id)).toEqual(before.items.map((r) => r.id));
    expect(after.items.map((r) => r.id)).toEqual(instant.derived.pageItems.map((r) => r.id));
    expect(after.firstPage).toEqual(instant.firstPage);
  });

  it('a cold fill is still two waves: one narrow read of the view, then the page by id (four requests, as before)', async () => {
    const { result, waves } = await inWaves(db, () =>
      loadInventoryList(FIXTURE_ORG, 'all', 'items'),
    );
    await result;
    expect(rowWaves(waves)).toEqual([
      ['inventory_items'],
      ['inventory_items', 'item_images', 'item_stock_levels'],
    ]);
  });

  it('the narrow read asks for the whole view (every lifecycle) in the default order, with only the holdings that have stock in this org', async () => {
    const log: ExecutedQuery[] = [];
    serveDb(db, { log });
    await loadInventoryList(FIXTURE_ORG, 'all', 'items');
    const first = log.find((q) => q.table === 'inventory_items')!;
    expect(first.select).toBe(
      'id, sku, name, group_id, status, awaiting_first_receipt, updated_at, item_stock_levels(quantity)',
    );
    expect(first.count).toBe('exact');
    expect(first.head).toBe(false);
    expect(first.range).toEqual([0, 999]);
    expect(first.orders).toEqual([
      { col: 'updated_at', ascending: false },
      { col: 'id', ascending: true },
    ]);
    const filters = first.filters.map((f) => `${f.path.join('.')} ${f.op} ${String(f.value)}`);
    expect(filters).toEqual(
      expect.arrayContaining([
        `organization_id eq ${FIXTURE_ORG}`,
        'deleted_at is null',
        'item_type eq product',
        'is_rental eq false',
        'item_stock_levels.quantity gt 0',
        `item_stock_levels.organization_id eq ${FIXTURE_ORG}`,
      ]),
    );
    expect(filters.some((f) => f.startsWith('status '))).toBe(false);
    expect(filters.some((f) => f.startsWith('awaiting_first_receipt '))).toBe(false);
    // No head counts: the totals come from the same rows.
    expect(log.filter((q) => q.head)).toEqual([]);
  });

  it('Books keep the fixed 30-row slice (first 30 default rows, default order) and carry no plan', async () => {
    for (const r of db.tables.inventory_items!) if (r.item_type === 'product') r.item_type = 'book';
    serveDb(db);
    const payload = await loadInventoryList(FIXTURE_ORG, 'all', 'books');
    // Today's query, by hand: active, not awaiting, not deleted, non-rental
    // books of this org, newest first with the id tiebreak, first 30.
    const defaults = db.tables
      .inventory_items!.filter(
        (r) =>
          r.organization_id === FIXTURE_ORG &&
          r.item_type === 'book' &&
          r.deleted_at === null &&
          r.is_rental === false &&
          r.status === 'active' &&
          r.awaiting_first_receipt === false,
      )
      .sort((a, b) =>
        a.updated_at === b.updated_at
          ? (a.id as string) < (b.id as string)
            ? -1
            : 1
          : (a.updated_at as string) < (b.updated_at as string)
            ? 1
            : -1,
      );
    expect(payload.items.map((r) => r.id)).toEqual(defaults.slice(0, 30).map((r) => r.id));
    // A family the Items plan would pull up is NOT pulled up here: CB-14's
    // second row (rank 60) stays off page 1.
    expect(payload.items.map((r) => r.id)).not.toContain(itemIdForRank(60));
    expect(payload.firstPage).toBeNull();
    expect(payload.total).toBe(defaults.length);
    expect(payload.expectedCount).toBe(2);
  });
});

describe('cached default Items view: size edges', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("over the instant cap: today's fixed slice, totals counted in wave 2, still two waves, no plan", async () => {
    const db = bigView(2050);
    const { result, waves } = await inWaves(db, () =>
      loadInventoryList(FIXTURE_ORG, 'all', 'items'),
    );
    const payload = await result;
    const ordered = [...db.tables.inventory_items!].sort((a, b) =>
      a.updated_at === b.updated_at
        ? 0
        : (a.updated_at as string) < (b.updated_at as string)
          ? 1
          : -1,
    );
    expect(payload.items.map((r) => r.id)).toEqual(ordered.slice(0, 30).map((r) => r.id));
    expect(payload.firstPage).toBeNull();
    expect(payload.total).toBe(2050);
    expect(rowWaves(waves)).toEqual([
      ['inventory_items'],
      [
        'inventory_items',
        'inventory_items (count)',
        'inventory_items (count)',
        'item_images',
        'item_stock_levels',
      ],
    ]);
  });

  it('over the cap with fewer than 30 default rows among the newest 1,000: re-reads the fixed slice (the only extra round trip)', async () => {
    const db = bigView(2050, { archivedNewest: 1000 });
    const { result, waves } = await inWaves(db, () =>
      loadInventoryList(FIXTURE_ORG, 'all', 'items'),
    );
    const payload = await result;
    const expected = db.tables
      .inventory_items!.filter((r) => r.status === 'active')
      .sort((a, b) => ((a.updated_at as string) < (b.updated_at as string) ? 1 : -1))
      .slice(0, 30)
      .map((r) => r.id);
    expect(payload.items.map((r) => r.id)).toEqual(expected);
    expect(payload.total).toBe(1050);
    expect(rowWaves(waves)).toHaveLength(3);
  });

  it('1,001-2,000 rows: a second read, then the same plan as instant mode', async () => {
    const db = bigView(1500, { family: { sku: 'FAM-1', size: 2 } });
    // Put the family's second member deep in the list.
    db.tables.inventory_items![1]!.sku = 'BIG-1';
    db.tables.inventory_items![1400]!.sku = 'FAM-1';
    const instant = await instantPageOne(db);
    const { result, waves } = await inWaves(db, () =>
      loadInventoryList(FIXTURE_ORG, 'all', 'items'),
    );
    const payload = await result;
    expect(payload.items.map((r) => r.id)).toEqual(instant.derived.pageItems.map((r) => r.id));
    expect(payload.items[1]!.id).toBe(db.tables.inventory_items![1400]!.id);
    expect(payload.firstPage).toEqual(instant.firstPage);
    expect(rowWaves(waves)).toEqual([
      ['inventory_items'],
      ['inventory_items'],
      ['inventory_items', 'item_images', 'item_stock_levels'],
    ]);
  });

  it('a write between the two key reads throws, so nothing half-read is cached', async () => {
    const db = bigView(1500);
    let keyReads = 0;
    const { result } = await inWaves(db, () => loadInventoryList(FIXTURE_ORG, 'all', 'items'), {
      beforeAnswer: (q) => {
        if (q.table !== 'inventory_items' || !q.select.includes('item_stock_levels(')) return;
        keyReads += 1;
        // An item is edited while the second read is in flight: it jumps to
        // the top, and the second window repeats one row and misses it.
        if (keyReads === 2)
          db.tables.inventory_items![1200]!.updated_at = '2027-01-01T00:00:00.000Z';
      },
    });
    await expect(result).rejects.toThrow(/view changed between key reads/);
  });

  it('a family bigger than one id batch: page 1 holds all of it, and every .in() list stays at 100 values or fewer', async () => {
    const db = bigView(400, { family: { sku: 'HUGE', size: 120 } });
    const log: ExecutedQuery[] = [];
    serveDb(db, { log });
    const payload = await loadInventoryList(FIXTURE_ORG, 'all', 'items');
    expect(payload.items).toHaveLength(120);
    expect(payload.items.every((r) => r.sku === 'HUGE')).toBe(true);
    expect(payload.firstPage!.pageItemCount).toBe(120);
    const inLists = log.flatMap((q) => q.filters.filter((f) => f.op === 'in'));
    expect(inLists.length).toBeGreaterThan(0);
    for (const f of inLists) expect((f.value as unknown[]).length).toBeLessThanOrEqual(100);
  });
});
