import { DatabaseSync } from 'node:sqlite';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { pullSnapshot } from './sync';

// vi.mock / vi.hoisted are hoisted above these imports by vitest's transform,
// so declaring them below keeps the import block lint-clean.

/**
 * The snapshot pull must REMOVE what left the server's scope (SP-081).
 *
 * pullSnapshot only ever upserted. A row that leaves scope — an item archived
 * or deleted, a count posted or cancelled, a bundle deactivated — simply stops
 * appearing in the payload, so it lived on in the phone's SQLite until sign-out
 * (the only local delete is clearOrgScopedTables on org switch / sign-out).
 * Staff kept opening an archived bundle from the cached Bundles list and
 * enqueuing a distribute the server then refuses.
 *
 * These tests run the REAL SQL against a REAL SQLite (node:sqlite) using the
 * db.ts DDL, with expo-sqlite's async surface faked over it — so a broken
 * statement, a wrong parameter or a guard that deletes an operator's unsynced
 * count fails here rather than on a warehouse floor.
 */

const netMock = vi.hoisted(() => ({
  getNetworkStateAsync: vi.fn(async () => ({ isConnected: true, isInternetReachable: true })),
}));
vi.mock('expo-network', () => netMock);

const meta = vi.hoisted(() => ({ store: new Map<string, string>(), db: { current: null as unknown } }));

vi.mock('./db', () => ({
  getDb: async () => meta.db.current,
  getMeta: async (k: string) => meta.store.get(k) ?? null,
  setMeta: async (k: string, v: string) => {
    meta.store.set(k, v);
  },
}));
vi.mock('./queue', () => ({
  listPending: vi.fn(async () => []),
  markSending: vi.fn(),
  markOk: vi.fn(),
  markFailed: vi.fn(),
  markRejected: vi.fn(),
}));
const apiMock = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('./api', () => apiMock);
vi.mock('./account-disabled-state', () => ({ getAccountDisabled: () => false }));
vi.mock('./enabled-modules', () => ({
  ENABLED_MODULES_META_KEY: 'enabled_modules',
  refreshEnabledModules: vi.fn(),
}));
vi.mock('./use-effective-permissions', () => ({
  EFFECTIVE_PERMISSIONS_META_KEY: 'effective_permissions',
  refreshEffectivePermissions: vi.fn(),
}));
vi.mock('./warehouse-scope', () => ({
  WAREHOUSE_SCOPE_META_KEY: 'warehouse_scope',
  refreshWarehouseScope: vi.fn(),
}));

/** Verbatim from db.ts SCHEMA_SQL (the tables the pull writes). */
const DDL = `
  create table warehouses (id text primary key, name text not null);
  create table items (
    id text primary key, sku text not null, name text not null, barcode text,
    quantity_on_hand real not null default 0, unit_cost real not null default 0,
    warehouse_id text, item_type text, last_synced_at integer not null
  );
  create table purchase_orders (
    id text primary key, po_number text, status text, warehouse_id text,
    expected_at text, last_synced_at integer not null
  );
  create table po_lines (
    id text primary key, po_id text not null, item_id text not null,
    qty_ordered real not null, qty_received real not null default 0,
    unit_cost real not null default 0
  );
  create table cycle_counts (
    id text primary key, organization_id text, status text, warehouse_id text,
    warehouse_name text, started_at text, posted_at text, assigned_to text,
    notes text, last_synced_at integer not null, cached_at integer
  );
  create table cycle_count_lines (
    id text primary key, count_id text not null, item_id text not null,
    item_name text, item_sku text, item_barcode text,
    expected real not null default 0, counted real, updated_at text,
    local_dirty integer not null default 0
  );
  create table bundles (
    id text primary key, name text not null, sku text,
    preassembly_enabled integer not null default 0, phantom_item_id text,
    phantom_qty real not null default 0, phantom_warehouse_id text,
    last_synced_at integer not null
  );
  create table bundle_components (
    bundle_id text not null, item_id text not null, quantity real not null,
    is_optional integer not null default 0, primary key (bundle_id, item_id)
  );`;

/** expo-sqlite's async surface over node:sqlite — same methods sync.ts calls. */
function fakeDb(sqlite: DatabaseSync) {
  return {
    runAsync: async (sql: string, params: unknown[] = []) =>
      sqlite.prepare(sql).run(...(params as never[])),
    getAllAsync: async (sql: string, params: unknown[] = []) =>
      sqlite.prepare(sql).all(...(params as never[])),
    getFirstAsync: async (sql: string, params: unknown[] = []) =>
      sqlite.prepare(sql).get(...(params as never[])) ?? null,
    withTransactionAsync: async (fn: () => Promise<void>) => {
      await fn();
    },
  };
}

let sqlite: DatabaseSync;
const ids = (sql: string) => (sqlite.prepare(sql).all() as { id: string }[]).map((r) => r.id);

type Snap = Record<string, unknown>;
const emptySnap = (over: Snap = {}): Snap => ({
  serverTime: '2026-09-05T12:00:00.000Z',
  enabledModules: [],
  warehouses: [],
  items: [],
  openPOs: [],
  openCycleCounts: [],
  bundles: [],
  ...over,
});

const bundle = (id: string, name: string) => ({
  id,
  name,
  sku: null,
  preassemblyEnabled: false,
  phantomItemId: null,
  phantomQty: 0,
  phantomWarehouseId: null,
  components: [{ itemId: 'i-keep', quantity: 1, isOptional: false }],
});

const item = (id: string) => ({
  id,
  sku: `sku-${id}`,
  name: id,
  barcode: null,
  quantityOnHand: 1,
  unitCost: 0,
  warehouseId: 'wh1',
  itemType: 'standard',
});

const count = (id: string) => ({
  id,
  status: 'in_progress',
  warehouseId: 'wh1',
  startedAt: '2026-09-01T00:00:00Z',
  assignedTo: null,
  notes: null,
  lines: [{ id: `${id}-l1`, itemId: 'i-keep', expected: 1, counted: null }],
});

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:');
  sqlite.exec(DDL);
  meta.db.current = fakeDb(sqlite);
  meta.store = new Map();
  apiMock.api.mockReset();
  netMock.getNetworkStateAsync.mockResolvedValue({
    isConnected: true,
    isInternetReachable: true,
  });

  // What the phone cached on an earlier pull: two bundles, two items, two
  // open counts — one of which the operator has edited offline.
  sqlite.exec(`
    insert into bundles (id, name, sku, preassembly_enabled, phantom_item_id, phantom_qty, phantom_warehouse_id, last_synced_at)
      values ('b-live', 'Live kit', null, 0, null, 0, null, 100),
             ('b-archived', 'Archived kit', null, 0, null, 0, null, 100);
    insert into bundle_components (bundle_id, item_id, quantity, is_optional)
      values ('b-live', 'i-keep', 1, 0), ('b-archived', 'i-keep', 1, 0);
    insert into items (id, sku, name, quantity_on_hand, unit_cost, warehouse_id, item_type, last_synced_at)
      values ('i-keep', 'sku-i-keep', 'Keep', 1, 0, 'wh1', 'standard', 100),
             ('i-archived', 'sku-gone', 'Gone', 1, 0, 'wh1', 'standard', 100);
    insert into cycle_counts (id, status, warehouse_id, started_at, last_synced_at)
      values ('cc-open', 'in_progress', 'wh1', '2026-09-01T00:00:00Z', 100),
             ('cc-posted', 'in_progress', 'wh1', '2026-09-01T00:00:00Z', 100),
             ('cc-dirty', 'in_progress', 'wh1', '2026-09-01T00:00:00Z', 100);
    insert into cycle_count_lines (id, count_id, item_id, expected, counted, local_dirty)
      values ('cc-open-l1', 'cc-open', 'i-keep', 1, null, 0),
             ('cc-posted-l1', 'cc-posted', 'i-keep', 1, null, 0),
             ('cc-dirty-l1', 'cc-dirty', 'i-keep', 1, 9, 1),
             ('cc-dirty-l2', 'cc-dirty', 'i-keep', 1, null, 0);
  `);
});

/** Runs a DELTA pull (a `last_synced_at` cursor is already stored). */
async function deltaPull(snap: Snap) {
  meta.store.set('last_synced_at', '2026-09-05T11:00:00.000Z');
  apiMock.api.mockResolvedValue(snap);
  await pullSnapshot();
  return apiMock.api.mock.calls[0][0] as string;
}

/** Runs a FULL pull (forced, as an org switch does). */
async function fullPull(snap: Snap) {
  meta.store.set('last_synced_at', '2026-09-05T11:00:00.000Z');
  apiMock.api.mockResolvedValue(snap);
  await pullSnapshot(true);
}

describe('cycle counts — reconciled on EVERY pull', () => {
  /**
   * The server's cycle-count query carries NO `since` filter (snapshot/route.ts
   * builds it with only status='in_progress' + scope), so every pull returns
   * the caller's COMPLETE open list. Absence is therefore proof of removal.
   */
  it('drops a count the server no longer lists, with its lines', async () => {
    await deltaPull(emptySnap({ openCycleCounts: [count('cc-open'), count('cc-dirty')] }));
    expect(ids('select id from cycle_counts order by id')).toEqual(['cc-dirty', 'cc-open']);
    expect(ids("select id from cycle_count_lines where count_id = 'cc-posted'")).toEqual([]);
  });

  it('NEVER drops a count holding the operator’s unsynced work', async () => {
    // cc-dirty has a local_dirty line: the outbox has not settled it yet.
    // Deleting it here destroys a count somebody physically took.
    await deltaPull(emptySnap({ openCycleCounts: [count('cc-open')] }));
    expect(ids('select id from cycle_counts order by id')).toEqual(['cc-dirty', 'cc-open']);
    // and its CLEAN sibling line survives too — a half-emptied count would
    // read as "already counted" on the detail screen.
    expect(ids("select id from cycle_count_lines where count_id = 'cc-dirty' order by id")).toEqual(
      ['cc-dirty-l1', 'cc-dirty-l2'],
    );
  });

  it('an empty open list clears every clean cached count', async () => {
    await deltaPull(emptySnap({ openCycleCounts: [] }));
    expect(ids('select id from cycle_counts order by id')).toEqual(['cc-dirty']);
  });

  it('does not prune when the server response may be TRUNCATED at its limit', async () => {
    // The route caps cycle counts at 50. On a full page we cannot tell "these
    // are all of them" from "here are the first 50", and pruning on a truncated
    // list would delete live counts on every pull.
    const fifty = Array.from({ length: 50 }, (_, i) => count(`bulk-${i}`));
    await deltaPull(emptySnap({ openCycleCounts: fifty }));
    expect(ids("select id from cycle_counts where id = 'cc-posted'")).toEqual(['cc-posted']);
  });
});

describe('items + bundles — reconciled against a FULL pull', () => {
  /**
   * items/bundles ARE `since`-filtered server-side, so on a delta response
   * absence proves nothing (an untouched row is simply not in the payload).
   * Only a full pull carries the complete active set.
   */
  it('a delta pull must NOT delete rows it simply did not carry', async () => {
    await deltaPull(emptySnap({ items: [item('i-keep')], bundles: [bundle('b-live', 'Live kit')] }));
    expect(ids('select id from items order by id')).toEqual(['i-archived', 'i-keep']);
    expect(ids('select id from bundles order by id')).toEqual(['b-archived', 'b-live']);
  });

  it('a full pull drops the archived bundle (and its components) and the archived item', async () => {
    await fullPull(emptySnap({ items: [item('i-keep')], bundles: [bundle('b-live', 'Live kit')] }));
    expect(ids('select id from bundles order by id')).toEqual(['b-live']);
    expect(
      (sqlite.prepare('select bundle_id from bundle_components').all() as { bundle_id: string }[])
        .map((r) => r.bundle_id),
    ).toEqual(['b-live']);
    expect(ids('select id from items order by id')).toEqual(['i-keep']);
  });

  it('a full pull that returns nothing empties the caches rather than lying', async () => {
    await fullPull(emptySnap());
    expect(ids('select id from bundles')).toEqual([]);
    expect(ids('select id from items')).toEqual([]);
  });
});

describe('explicit server removal lists (forward-compatible)', () => {
  /**
   * The snapshot route does not emit these yet — the fields are optional and a
   * response without them behaves exactly as before. When the route starts
   * sending them, a DELTA pull can finally clean up too. Documented in
   * SnapshotResponse; the route change is tracked separately.
   */
  it('removedItemIds deletes those items on a delta pull', async () => {
    await deltaPull(emptySnap({ items: [item('i-keep')], removedItemIds: ['i-archived'] }));
    expect(ids('select id from items order by id')).toEqual(['i-keep']);
  });

  it('activeBundleIds is treated as the authoritative active set on a delta pull', async () => {
    await deltaPull(emptySnap({ bundles: [], activeBundleIds: ['b-live'] }));
    expect(ids('select id from bundles order by id')).toEqual(['b-live']);
    expect(
      (sqlite.prepare('select bundle_id from bundle_components').all() as { bundle_id: string }[])
        .map((r) => r.bundle_id),
    ).toEqual(['b-live']);
  });

  it('ignores a malformed list instead of wiping the cache', async () => {
    await deltaPull(emptySnap({ removedItemIds: 'i-archived', activeBundleIds: {} }));
    expect(ids('select id from items order by id')).toEqual(['i-archived', 'i-keep']);
    expect(ids('select id from bundles order by id')).toEqual(['b-archived', 'b-live']);
  });
});

describe('the pull still does its original job', () => {
  it('upserts what the server sent and advances the cursor', async () => {
    const res = await deltaPull(
      emptySnap({ items: [item('i-new')], openCycleCounts: [count('cc-open'), count('cc-dirty')] }),
    );
    expect(res).toContain('since=');
    expect(ids("select id from items where id = 'i-new'")).toEqual(['i-new']);
    expect(meta.store.get('last_synced_at')).toBe('2026-09-05T12:00:00.000Z');
  });

  it('a failed pull deletes nothing', async () => {
    meta.store.set('last_synced_at', '2026-09-05T11:00:00.000Z');
    apiMock.api.mockRejectedValue(new Error('offline-ish 500'));
    expect(await pullSnapshot()).toBeNull();
    expect(ids('select id from bundles order by id')).toEqual(['b-archived', 'b-live']);
    expect(ids('select id from cycle_counts order by id')).toEqual([
      'cc-dirty',
      'cc-open',
      'cc-posted',
    ]);
  });
});
