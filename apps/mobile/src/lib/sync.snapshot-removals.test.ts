import { DatabaseSync } from 'node:sqlite';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  UNCONFIRMED_LINES_RELEASE_ONE_COUNT_SQL,
  UNCONFIRMED_LINES_RELEASE_SQL,
} from './cycle-count-snapshot-sql';
import {
  pullSnapshot,
  syncNow,
  UNCONFIRMED_COUNT_LINES_DELETE_SQL,
  UNCONFIRMED_COUNTS_DELETE_SQL,
} from './sync';

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

const meta = vi.hoisted(() => ({
  store: new Map<string, string>(),
  db: { current: null as unknown },
  // db.ts's cache-wipe generation (deleteOrgData / wipeForSignOut bump it).
  generation: 0,
  // Called before every runAsync, so a test can act mid-write.
  onRun: null as null | ((sql: string) => void),
  // What db.ts deleteOrgData clears (set per test; see beforeEach).
  wipe: null as null | (() => void),
  // What db.ts markCacheUnconfirmed does at an adopt (see beforeEach).
  markUnconfirmed: null as null | (() => void),
  // The account signed in on the device (session-scope.ts).
  liveUserId: 'u1' as string | null,
}));

vi.mock('./db', () => ({
  getDb: async () => meta.db.current,
  currentCacheGeneration: () => meta.generation,
  // The queue itself is tested in db.transaction-queue.test.ts; here a
  // transaction is just the fake db's own.
  withDbTransaction: (db: { withTransactionAsync: (t: () => Promise<void>) => Promise<void> }, task: () => Promise<void>) =>
    db.withTransactionAsync(task),
  getMeta: async (k: string) => meta.store.get(k) ?? null,
  setMeta: async (k: string, v: string) => {
    meta.store.set(k, v);
  },
  // db.ts deleteOrgData: bump the generation, then clear the org-scoped cache.
  deleteOrgData: vi.fn(async () => {
    meta.generation += 1;
    meta.wipe?.();
  }),
  // db.ts setCacheOwner: the reset and the adopt record the account once the
  // photo clear has answered, with the clear owed when it failed
  // (cache-owner.ts).
  setCacheOwner: vi.fn(async (userId: string, photosCleared: boolean) => {
    meta.store.set('cache_user_id', userId);
    if (photosCleared) meta.store.delete('cache_photos_pending');
    else meta.store.set('cache_photos_pending', userId);
  }),
  // db.ts markPhotosCleared: a clear owed has now worked.
  markPhotosCleared: vi.fn(async () => {
    meta.store.delete('cache_photos_pending');
  }),
  // db.ts markCacheUnconfirmed: the adopt forgets the cursor and the persisted
  // values and marks every cached row unconfirmed.
  markCacheUnconfirmed: vi.fn(async () => {
    meta.markUnconfirmed?.();
  }),
}));
vi.mock('./queue', () => ({
  listPending: vi.fn(async () => []),
  markSending: vi.fn(),
  markOk: vi.fn(),
  markFailed: vi.fn(),
  markRejected: vi.fn(),
  markHeld: vi.fn(),
}));
vi.mock('./session-scope', () => ({
  liveOutboxScope: vi.fn(async () => ({ orgId: 'org-1', userId: meta.liveUserId })),
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
// The photo caches a reset clears: photo-cache-wipe.ts runs for real, over
// expo-image's two caches and the in-memory photo links.
const photos = vi.hoisted(() => ({
  clearMemoryCache: vi.fn(async () => true),
  clearDiskCache: vi.fn(async () => true),
  forgetSignedImageUrls: vi.fn(),
}));
vi.mock('expo-image', () => ({
  Image: { clearMemoryCache: photos.clearMemoryCache, clearDiskCache: photos.clearDiskCache },
}));
vi.mock('./image-cache', () => ({ forgetSignedImageUrls: photos.forgetSignedImageUrls }));

/** Verbatim from db.ts SCHEMA_SQL (the tables the pull writes, and the outbox,
 *  which a full pull reads to keep a count this account has not sent yet). */
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
    notes text, last_synced_at integer not null, cached_at integer,
    -- added in place at startup by addColumnIfMissing (db.ts), not in SCHEMA_SQL
    count_number integer
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
  );
  create table pending_actions (
    id integer primary key autoincrement, kind text not null,
    idempotency_key text not null unique, payload_json text not null,
    created_at integer not null, attempts integer not null default 0,
    last_attempt_at integer, last_error text, status text not null default 'pending',
    -- added in place at startup by addColumnIfMissing (db.ts)
    organization_id text, user_id text
  );`;

/** expo-sqlite's async surface over node:sqlite — same methods sync.ts calls. */
function fakeDb(sqlite: DatabaseSync) {
  return {
    runAsync: async (sql: string, params: unknown[] = []) => {
      meta.onRun?.(sql);
      return sqlite.prepare(sql).run(...(params as never[]));
    },
    getAllAsync: async (sql: string, params: unknown[] = []) =>
      sqlite.prepare(sql).all(...(params as never[])),
    getFirstAsync: async (sql: string, params: unknown[] = []) =>
      sqlite.prepare(sql).get(...(params as never[])) ?? null,
    // expo-sqlite's own shape: BEGIN, task, COMMIT, ROLLBACK on a throw.
    withTransactionAsync: async (fn: () => Promise<void>) => {
      sqlite.exec('BEGIN');
      try {
        await fn();
        sqlite.exec('COMMIT');
      } catch (e) {
        sqlite.exec('ROLLBACK');
        throw e;
      }
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
  // The cache is the live account's own (cache-owner.ts), as on any phone it
  // has pulled for before. The tests of a cache with no owner recorded take
  // the record away first (noOwnerRecorded): with none, every pull adopts,
  // and an adopt is a full pull.
  meta.store = new Map([['cache_user_id', 'u1']]);
  meta.generation = 0;
  meta.onRun = null;
  meta.liveUserId = 'u1';
  meta.wipe = () => {
    sqlite.exec(`delete from items; delete from warehouses; delete from purchase_orders;
      delete from po_lines; delete from cycle_counts; delete from cycle_count_lines;
      delete from bundles; delete from bundle_components;`);
    // Not cache_user_id: deleteOrgData keeps whose cache it is (cache-owner.ts).
    for (const k of [
      'last_synced_at',
      'enabled_modules',
      'effective_permissions',
      'warehouse_scope',
    ]) {
      meta.store.delete(k);
    }
  };
  meta.markUnconfirmed = () => {
    for (const k of [
      'last_synced_at',
      'enabled_modules',
      'effective_permissions',
      'warehouse_scope',
    ]) {
      meta.store.delete(k);
    }
    sqlite.exec(`update items set last_synced_at = 0; update purchase_orders set last_synced_at = 0;
      update cycle_counts set last_synced_at = 0; update bundles set last_synced_at = 0;`);
  };
  apiMock.api.mockReset();
  netMock.getNetworkStateAsync.mockResolvedValue({
    isConnected: true,
    isInternetReachable: true,
  });
  photos.clearMemoryCache.mockClear();
  photos.clearDiskCache.mockClear();
  photos.forgetSignedImageUrls.mockClear();

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

/** A cache with no record of whose it is (cache-owner.ts adopt). */
const noOwnerRecorded = () => meta.store.delete('cache_user_id');

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

describe('a cache wipe while a snapshot is loading (workspace switch, repair or sign-out)', () => {
  const answerForA = () =>
    emptySnap({
      enabledModules: ['cycle_counts'],
      warehouses: [{ id: 'wh-a', name: 'A Warehouse' }],
      openCycleCounts: [{ ...count('cc-a'), warehouseId: 'wh-a' }],
    });
  /** What deleteOrgData and wipeForSignOut do first, before the wipe queues. */
  const askForWipe = () => {
    meta.generation += 1;
  };
  /** The queued wipe itself (clearOrgScopedTables). */
  const runWipe = () => {
    sqlite.exec(`
      delete from warehouses; delete from items; delete from bundles; delete from bundle_components;
      delete from cycle_counts; delete from cycle_count_lines;
    `);
    for (const k of ['last_synced_at', 'enabled_modules', 'effective_permissions', 'warehouse_scope']) meta.store.delete(k);
  };

  it("discards an answer that lands after the wipe: no rows, no cursor, no modules", async () => {
    apiMock.api.mockImplementation(async () => {
      askForWipe();
      runWipe();
      return answerForA();
    });
    await expect(pullSnapshot(true)).resolves.toBeNull();
    expect(ids('select id from warehouses')).toEqual([]);
    expect(ids('select id from cycle_counts')).toEqual([]);
    expect(meta.store.has('last_synced_at')).toBe(false);
    expect(meta.store.has('enabled_modules')).toBe(false);
  });

  it('keeps the answer when nothing was wiped (the first pull after sign-in included)', async () => {
    apiMock.api.mockResolvedValue(answerForA());
    await expect(pullSnapshot(true)).resolves.not.toBeNull();
    expect(ids('select id from warehouses')).toEqual(['wh-a']);
    expect(ids('select id from cycle_counts order by id')).toContain('cc-a');
    expect(meta.store.get('last_synced_at')).toBe('2026-09-05T12:00:00.000Z');
  });

  it('discards a delta whose cursor was cleared under it (the wipe was asked for just before the pull)', async () => {
    meta.store.set('last_synced_at', '2026-09-01T00:00:00.000Z');
    askForWipe();
    apiMock.api.mockImplementation(async () => {
      runWipe(); // the queued wipe runs while the request is out
      return answerForA();
    });
    await expect(pullSnapshot()).resolves.toBeNull();
    expect(apiMock.api.mock.calls[0]?.[0]).toContain('?since=');
    expect(meta.store.has('last_synced_at')).toBe(false);
    expect(ids('select id from warehouses')).toEqual([]);
  });

  const fourItems = () =>
    ['i-1', 'i-2', 'i-3', 'i-4'].map((id) => ({
      id, sku: id, name: id, barcode: null, quantityOnHand: 1, unitCost: 0, warehouseId: 'wh1', itemType: 'standard',
    }));

  it('a wipe asked for mid-write stops the pull at the next row; the queued wipe clears what it wrote', async () => {
    apiMock.api.mockResolvedValue(emptySnap({ items: fourItems() }));
    let itemWrites = 0;
    meta.onRun = (sql) => {
      if (/into items/.test(sql) && ++itemWrites === 2) askForWipe();
    };
    await expect(pullSnapshot(true)).resolves.toBeNull();
    expect(itemWrites).toBe(2);
    // Committed up to the stop, never the cursor or modules.
    expect(ids("select id from items where id like 'i-_' order by id")).toEqual(['i-1', 'i-2']);
    expect(meta.store.has('last_synced_at')).toBe(false);
    expect(meta.store.has('enabled_modules')).toBe(false);
    runWipe(); // queued right behind the pull's transaction
    expect(ids('select id from items')).toEqual([]);
  });

  it('a stop never rolls back what other flows wrote meanwhile (the outbox rejection at eviction)', async () => {
    sqlite.exec(`
      insert into pending_actions (id, kind, idempotency_key, payload_json, created_at, status)
        values (1, 'receive_po_line', 'k1', '{}', 1, 'pending'), (2, 'receive_po_line', 'k2', '{}', 2, 'failed');
    `);
    apiMock.api.mockResolvedValue(emptySnap({ items: fourItems() }));
    let itemWrites = 0;
    meta.onRun = (sql) => {
      if (/into items/.test(sql) && ++itemWrites === 2) {
        // Account eviction: rejectAllPending (a plain write on the shared
        // connection, so inside the pull's open transaction), then
        // wipeForSignOut asks for the wipe.
        sqlite.exec("update pending_actions set status = 'rejected' where status <> 'rejected'");
        askForWipe();
      }
    };
    await expect(pullSnapshot(true)).resolves.toBeNull();
    const statuses = sqlite.prepare('select status from pending_actions order by id').all() as { status: string }[];
    expect(statuses.map((r) => r.status)).toEqual(['rejected', 'rejected']);
  });

  it('the first sync after a sign-out does not join the pull started before it', async () => {
    let releaseOld!: () => void;
    const oldLoaded = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    apiMock.api
      .mockImplementationOnce(async () => {
        await oldLoaded;
        return answerForA();
      })
      .mockImplementationOnce(async () => emptySnap({ warehouses: [{ id: 'wh-next', name: 'Next user' }] }));

    const timerSync = syncNow();
    await vi.waitFor(() => expect(apiMock.api).toHaveBeenCalledTimes(1));
    // Sign-out: wipeForSignOut asks for and runs the wipe. Then the next
    // sign-in's first sync (useSync on mount, not forced).
    askForWipe();
    runWipe();
    const firstSyncAfterSignIn = syncNow();
    releaseOld();
    await Promise.all([timerSync, firstSyncAfterSignIn]);

    expect(apiMock.api).toHaveBeenCalledTimes(2);
    expect(apiMock.api.mock.calls[1]?.[0]).toBe('/api/v1/mobile/snapshot');
    expect(ids('select id from warehouses')).toEqual(['wh-next']);
  });

  it('a forced sync asked for mid-pull still runs afterwards, as a full pull', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let releaseA!: () => void;
    const aLoaded = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    meta.store.set('last_synced_at', '2026-09-01T00:00:00.000Z');
    apiMock.api
      .mockImplementationOnce(async () => {
        await aLoaded;
        return answerForA();
      })
      .mockImplementationOnce(async () => emptySnap({ warehouses: [{ id: 'wh-b', name: 'B Warehouse' }] }));

    const timerSync = syncNow();
    await vi.waitFor(() => expect(apiMock.api).toHaveBeenCalledTimes(1)); // A's request is out
    // setActiveOrg: the wipe is asked for and a forced pull requested.
    askForWipe();
    runWipe();
    const forced = syncNow(true);
    releaseA();
    await Promise.all([timerSync, forced]);

    expect(apiMock.api).toHaveBeenCalledTimes(2);
    expect(apiMock.api.mock.calls[0]?.[0]).toContain('?since=');
    expect(apiMock.api.mock.calls[1]?.[0]).toBe('/api/v1/mobile/snapshot');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('discarded'));
    expect(ids('select id from warehouses')).toEqual(['wh-b']);
    expect(ids('select id from cycle_counts')).toEqual([]);
    warn.mockRestore();
  });
});

describe('whose cache: a pull for another account resets it first (#242 follow-up)', () => {
  /**
   * "Use password instead", "Use a different account", a revoked session and
   * refresh-token expiry end a session WITHOUT wiping the cache. A next user
   * in the same workspace then delta-pulled from the previous user's cursor,
   * and rows outside their own warehouse scope stayed on the device.
   */
  it("another account's cache is cleared and pulled again in FULL, then recorded as this account's", async () => {
    meta.store.set('cache_user_id', 'u0');
    const path = await deltaPull(emptySnap({ items: [item('i-mine')] }));

    expect(path).toBe('/api/v1/mobile/snapshot'); // no ?since: the old cursor was u0's
    // The previous account's rows are gone, the new one's are in.
    expect(ids('select id from items order by id')).toEqual(['i-mine']);
    expect(ids('select id from bundles')).toEqual([]);
    expect(meta.store.get('cache_user_id')).toBe('u1');
    // The request itself may only be answered for the account recorded above.
    expect(apiMock.api.mock.calls[0]?.[1]).toEqual({ asUserId: 'u1' });
  });

  it("the live readers drop the previous account's modules, permissions and banner at the reset", async () => {
    const { refreshEnabledModules } = await import('./enabled-modules');
    const { refreshEffectivePermissions } = await import('./use-effective-permissions');
    const { refreshWarehouseScope } = await import('./warehouse-scope');
    vi.mocked(refreshEnabledModules).mockClear();
    vi.mocked(refreshEffectivePermissions).mockClear();
    vi.mocked(refreshWarehouseScope).mockClear();
    meta.store.set('cache_user_id', 'u0');
    meta.store.set('effective_permissions', '["items:read"]');
    apiMock.api.mockRejectedValue(new Error('offline mid-request')); // the pull itself never lands

    await pullSnapshot();

    expect(meta.store.has('effective_permissions')).toBe(false);
    // Recorded at the reset, not by the pull that never landed (cache-owner.ts).
    expect(meta.store.get('cache_user_id')).toBe('u1');
    expect(refreshEnabledModules).toHaveBeenCalled();
    expect(refreshEffectivePermissions).toHaveBeenCalled();
    expect(refreshWarehouseScope).toHaveBeenCalled();
  });

  it("this account's own cache keeps its delta cursor and its rows", async () => {
    meta.store.set('cache_user_id', 'u1');
    const path = await deltaPull(emptySnap());
    expect(path).toContain('?since=');
    expect(ids('select id from items order by id')).toEqual(['i-archived', 'i-keep']);
  });

  // Changed by the B18 review of 43256f0da: an adopt no longer delta-pulls
  // from the cursor it found and keeps the rows, which can be another
  // account's. It is still no reset (nothing is wiped before the request).
  it('a cache with no recorded owner is adopted, not reset, and recorded as this account before the request is sent', async () => {
    noOwnerRecorded();
    const { deleteOrgData } = await import('./db');
    vi.mocked(deleteOrgData).mockClear();
    let recordedAtRequest: string | null | undefined;
    apiMock.api.mockImplementation(async () => {
      recordedAtRequest = meta.store.get('cache_user_id') ?? null;
      return emptySnap({ items: [item('i-keep')] });
    });
    meta.store.set('last_synced_at', '2026-09-05T11:00:00.000Z');
    await pullSnapshot();

    expect(deleteOrgData).not.toHaveBeenCalled();
    expect(recordedAtRequest).toBe('u1');
    expect(meta.store.get('cache_user_id')).toBe('u1');
    // Pulled in FULL: the cursor it found is not this account's to trust.
    expect(apiMock.api.mock.calls[0]?.[0]).toBe('/api/v1/mobile/snapshot');
    expect(ids('select id from items order by id')).toEqual(['i-keep']);
  });

  // Mutation caught: the adopt keeping the cursor or the persisted values, or
  // leaving the live readers on them.
  it('an adopt forgets the cursor and the persisted values before the request, and the live readers re-read', async () => {
    noOwnerRecorded();
    const { refreshEnabledModules } = await import('./enabled-modules');
    const { refreshEffectivePermissions } = await import('./use-effective-permissions');
    const { refreshWarehouseScope } = await import('./warehouse-scope');
    vi.mocked(refreshEnabledModules).mockClear();
    vi.mocked(refreshEffectivePermissions).mockClear();
    vi.mocked(refreshWarehouseScope).mockClear();
    meta.store.set('last_synced_at', '2026-09-05T11:00:00.000Z');
    meta.store.set('effective_permissions', '["someone:else"]');
    meta.store.set('warehouse_scope', '{"hasAllAccess":true,"warehouseNames":[]}');
    meta.store.set('enabled_modules', '["someone-else"]');
    apiMock.api.mockRejectedValue(new Error('offline mid-request')); // the pull never lands

    await pullSnapshot();

    for (const k of [
      'last_synced_at',
      'effective_permissions',
      'warehouse_scope',
      'enabled_modules',
    ]) {
      expect(meta.store.has(k), k).toBe(false);
    }
    expect(meta.store.get('cache_user_id')).toBe('u1');
    expect(refreshEnabledModules).toHaveBeenCalled();
    expect(refreshEffectivePermissions).toHaveBeenCalled();
    expect(refreshWarehouseScope).toHaveBeenCalled();
    // The rows are only marked: what the next full pull does not return goes.
    expect(ids('select id from items order by id')).toEqual(['i-archived', 'i-keep']);
  });

  /** The db.ts writers and the live readers, their calls cleared. */
  const calls = async () => {
    const db = await import('./db');
    const { refreshEnabledModules } = await import('./enabled-modules');
    const { refreshEffectivePermissions } = await import('./use-effective-permissions');
    const { refreshWarehouseScope } = await import('./warehouse-scope');
    const spies = {
      deleteOrgData: vi.mocked(db.deleteOrgData),
      markCacheUnconfirmed: vi.mocked(db.markCacheUnconfirmed),
      setCacheOwner: vi.mocked(db.setCacheOwner),
      markPhotosCleared: vi.mocked(db.markPhotosCleared),
      refreshEnabledModules: vi.mocked(refreshEnabledModules),
      refreshEffectivePermissions: vi.mocked(refreshEffectivePermissions),
      refreshWarehouseScope: vi.mocked(refreshWarehouseScope),
    };
    for (const spy of Object.values(spies)) spy.mockClear();
    return spies;
  };

  // Mutation caught: the adopt recording nobody after a clear that failed
  // (254fb9c72: the next account's pull then adopted this one's rows instead
  // of resetting them), or recording it with no clear owed (43256f0da).
  it('an adopt whose photo clear fails records the account with the clear owed, before the request, and still pulls', async () => {
    noOwnerRecorded();
    photos.clearDiskCache.mockResolvedValueOnce(false);
    let atRequest: [string | undefined, string | undefined] | undefined;
    apiMock.api.mockImplementation(async () => {
      atRequest = [meta.store.get('cache_user_id'), meta.store.get('cache_photos_pending')];
      return emptySnap({ items: [item('i-keep')] });
    });

    await expect(pullSnapshot()).resolves.not.toBeNull();

    expect(atRequest).toEqual(['u1', 'u1']);
    expect(meta.store.get('cache_user_id')).toBe('u1');
    expect(meta.store.get('cache_photos_pending')).toBe('u1');
    expect(ids('select id from items order by id')).toEqual(['i-keep']);
  });

  // Mutation caught: the reset forgetting the record after a clear that
  // failed (254fb9c72), recording the new account with no clear owed
  // (43256f0da), or keeping the previous account's record.
  it('a reset whose photo clear fails records the new account with the clear owed, and its next pull clears again without wiping', async () => {
    meta.store.set('cache_user_id', 'u0');
    photos.clearMemoryCache.mockRejectedValueOnce(new Error('memory busy'));
    apiMock.api.mockResolvedValue(emptySnap({ items: [item('i-mine')] }));

    await pullSnapshot();

    expect(meta.store.get('cache_user_id')).toBe('u1');
    expect(meta.store.get('cache_photos_pending')).toBe('u1');
    expect(ids('select id from items order by id')).toEqual(['i-mine']);

    const spies = await calls();
    await pullSnapshot(); // the clear owed: tried again, nothing wiped
    expect(spies.deleteOrgData).not.toHaveBeenCalled();
    expect(spies.markCacheUnconfirmed).not.toHaveBeenCalled();
    expect(photos.clearMemoryCache).toHaveBeenCalledTimes(2);
    expect(meta.store.get('cache_user_id')).toBe('u1');
    expect(meta.store.has('cache_photos_pending')).toBe(false);
    expect(ids('select id from items order by id')).toEqual(['i-mine']);
  });

  // Mutation caught: a pull that owes a clear adopting again (254fb9c72:
  // every tick while the clear kept failing marked this account's rows,
  // forgot its cursor and persisted values, refreshed the readers and pulled
  // in full), a retry that does more than the clear, or none at all.
  it("this account's own cache with a clear owed: each pull, offline too, clears the photos again and does nothing else, until a clear works", async () => {
    meta.store.set('cache_photos_pending', 'u1');
    meta.store.set('effective_permissions', '["items:read"]');
    meta.store.set('last_synced_at', '2026-09-05T11:00:00.000Z');
    netMock.getNetworkStateAsync.mockResolvedValue({
      isConnected: false,
      isInternetReachable: false,
    });
    const spies = await calls();
    photos.clearDiskCache.mockResolvedValueOnce(false);

    expect(await pullSnapshot()).toBeNull(); // offline; the clear fails again
    expect(photos.clearDiskCache).toHaveBeenCalledTimes(1);
    expect(meta.store.get('cache_photos_pending')).toBe('u1');

    expect(await pullSnapshot()).toBeNull(); // offline; the clear works
    expect(photos.clearDiskCache).toHaveBeenCalledTimes(2);
    expect(photos.forgetSignedImageUrls).toHaveBeenCalledTimes(2);
    expect(meta.store.has('cache_photos_pending')).toBe(false);
    expect(spies.markPhotosCleared).toHaveBeenCalledTimes(1);

    for (const spy of [
      spies.deleteOrgData,
      spies.markCacheUnconfirmed,
      spies.setCacheOwner,
      spies.refreshEnabledModules,
      spies.refreshEffectivePermissions,
      spies.refreshWarehouseScope,
    ]) {
      expect(spy).not.toHaveBeenCalled();
    }
    expect(meta.store.get('cache_user_id')).toBe('u1');
    expect(meta.store.get('effective_permissions')).toBe('["items:read"]');
    expect(ids('select id from items order by id')).toEqual(['i-archived', 'i-keep']);

    netMock.getNetworkStateAsync.mockResolvedValue({
      isConnected: true,
      isInternetReachable: true,
    });
    apiMock.api.mockResolvedValue(emptySnap());
    await pullSnapshot(); // nothing owed: no clear, and a delta from this account's cursor
    expect(photos.clearDiskCache).toHaveBeenCalledTimes(2);
    expect(apiMock.api.mock.calls[0]?.[0]).toContain('?since=');
  });

  // The record decides: a clear owed by the account recorded is no reason
  // for another account to keep, and no reason for nobody's pull to clear.
  it('a clear owed never stands in for the reset of another account, and nobody signed in clears nothing', async () => {
    meta.store.set('cache_user_id', 'u0');
    meta.store.set('cache_photos_pending', 'u0');
    meta.store.set('last_synced_at', '2026-09-05T11:00:00.000Z');
    const spies = await calls();
    apiMock.api.mockResolvedValue(emptySnap({ items: [item('i-mine')] }));

    meta.liveUserId = null;
    await pullSnapshot();
    expect(photos.clearDiskCache).not.toHaveBeenCalled();
    expect(spies.deleteOrgData).not.toHaveBeenCalled();

    meta.liveUserId = 'u1';
    apiMock.api.mockClear();
    await pullSnapshot();
    expect(spies.deleteOrgData).toHaveBeenCalledTimes(1);
    expect(apiMock.api.mock.calls[0]?.[0]).toBe('/api/v1/mobile/snapshot');
    expect(ids('select id from items order by id')).toEqual(['i-mine']);
    expect(meta.store.get('cache_user_id')).toBe('u1');
    expect(meta.store.has('cache_photos_pending')).toBe(false);
  });

  it("offline, another account's cache is still cleared: it must not be readable offline either", async () => {
    meta.store.set('cache_user_id', 'u0');
    meta.store.set('last_synced_at', '2026-09-05T11:00:00.000Z');
    netMock.getNetworkStateAsync.mockResolvedValue({ isConnected: false, isInternetReachable: false });

    expect(await pullSnapshot()).toBeNull();
    expect(ids('select id from items')).toEqual([]);
    expect(apiMock.api).not.toHaveBeenCalled();
    // Its photos too.
    expect(photos.clearDiskCache).toHaveBeenCalledTimes(1);
  });

  /**
   * The photos follow the rows. The four ways a session ends without a wipe
   * also left the previous account's item and delivery photos in the image
   * cache on disk and its signed photo links in memory; the deliberate
   * sign-out and the eviction were the only paths that cleared them.
   */
  // Mutation caught: a reset that clears the rows and leaves the photos.
  it("another account's cache takes the previous account's photos with it", async () => {
    meta.store.set('cache_user_id', 'u0');
    await deltaPull(emptySnap({ items: [item('i-mine')] }));

    expect(photos.clearMemoryCache).toHaveBeenCalledTimes(1);
    expect(photos.clearDiskCache).toHaveBeenCalledTimes(1);
    expect(photos.forgetSignedImageUrls).toHaveBeenCalledTimes(1);
  });

  it("this account's own cache keeps its photos", async () => {
    meta.store.set('cache_user_id', 'u1');
    await deltaPull(emptySnap());
    await deltaPull(emptySnap());

    expect(apiMock.api).toHaveBeenCalledTimes(2);
    expect(photos.clearMemoryCache).not.toHaveBeenCalled();
    expect(photos.clearDiskCache).not.toHaveBeenCalled();
    expect(photos.forgetSignedImageUrls).not.toHaveBeenCalled();
  });

  // Mutation caught: an adopt that keeps the photos. A cache with no recorded
  // owner may hold anyone's: the release before this one forgot the record at
  // every wipe and cleared the photos at none (cache-owner.ts).
  it('a cache with no recorded owner has its photos and links cleared, once, offline too, and keeps its rows until a pull lands', async () => {
    noOwnerRecorded();
    netMock.getNetworkStateAsync.mockResolvedValue({
      isConnected: false,
      isInternetReachable: false,
    });
    expect(await pullSnapshot()).toBeNull();
    expect(apiMock.api).not.toHaveBeenCalled();
    expect(meta.store.get('cache_user_id')).toBe('u1');
    // Not reset: offline, the rows are still there to work with. They are
    // only marked, and the next pull to land sorts them (below).
    expect(ids('select id from items order by id')).toEqual(['i-archived', 'i-keep']);
    expect(ids('select id from cycle_counts order by id')).toEqual([
      'cc-dirty',
      'cc-open',
      'cc-posted',
    ]);
    netMock.getNetworkStateAsync.mockResolvedValue({
      isConnected: true,
      isInternetReachable: true,
    });
    apiMock.api.mockResolvedValue(emptySnap({ items: [item('i-keep')] }));
    await pullSnapshot(); // the next tick: the cache is recorded now

    // Cleared once, at the adopt, not again.
    expect(photos.clearMemoryCache).toHaveBeenCalledTimes(1);
    expect(photos.clearDiskCache).toHaveBeenCalledTimes(1);
    expect(photos.forgetSignedImageUrls).toHaveBeenCalledTimes(1);
    // In full (the adopt forgot the cursor): of the marked rows, what the
    // server returned stays.
    expect(apiMock.api.mock.calls[0]?.[0]).toBe('/api/v1/mobile/snapshot');
    expect(ids('select id from items order by id')).toEqual(['i-keep']);
  });

  // Mutation caught: the photo wipe run only when the SQLite wipe succeeds.
  it('a SQLite wipe that fails still clears the photos, and the pull fails as before', async () => {
    const { deleteOrgData } = await import('./db');
    vi.mocked(deleteOrgData).mockRejectedValueOnce(new Error('database is locked'));
    meta.store.set('cache_user_id', 'u0');

    await expect(pullSnapshot()).rejects.toThrow('database is locked');

    expect(photos.clearMemoryCache).toHaveBeenCalledTimes(1);
    expect(photos.clearDiskCache).toHaveBeenCalledTimes(1);
    expect(photos.forgetSignedImageUrls).toHaveBeenCalledTimes(1);
    expect(apiMock.api).not.toHaveBeenCalled();
    // The previous account stays recorded, so the next pull resets again.
    expect(meta.store.get('cache_user_id')).toBe('u0');
  });
});

/**
 * A cache adopted with no owner recorded (cache-owner.ts) has its rows marked
 * unconfirmed (db.ts markCacheUnconfirmed: last_synced_at 0). The full pull
 * that follows keeps what it returns, which it stamps again, and a count only
 * while this account still has a count to send for it. The statements, run on
 * a real SQLite here; the pull that runs them is executed end to end in
 * cache-owner.sqlite.test.ts.
 */
describe('unconfirmed rows: what a full pull keeps of a cache it adopted', () => {
  /** A record_count row as the outbox stores it (queue.ts, cycle-count-cache.ts). */
  const queue = (
    owner: string | null,
    countId: string | null,
    lineId: string | null,
    status = 'pending',
  ) =>
    sqlite
      .prepare(
        `insert into pending_actions (kind, idempotency_key, payload_json, created_at, status, user_id)
         values ('record_count', ?, ?, 1, ?, ?)`,
      )
      .run(
        `k-${countId}-${lineId}-${status}-${owner}`,
        JSON.stringify({
          ...(countId ? { cycleCountId: countId } : {}),
          ...(lineId ? { lineId } : {}),
          countedQuantity: 9,
        }),
        status,
        owner,
      );
  const sweep = (liveUserId: string | null) => {
    sqlite.prepare(UNCONFIRMED_COUNT_LINES_DELETE_SQL).run(liveUserId);
    sqlite.prepare(UNCONFIRMED_COUNTS_DELETE_SQL).run(liveUserId);
  };

  beforeEach(() => {
    sqlite.exec('update cycle_counts set last_synced_at = 0');
  });

  // Mutation caught: a count kept for any account's entry (the every-pull
  // rule keeps any count with a dirty line), or for none.
  it('keeps an unconfirmed count only while this account, or a legacy row, has an entry to send for it', () => {
    queue('u1', 'cc-dirty', 'cc-dirty-l1'); // this account's
    queue('u0', 'cc-open', 'cc-open-l1'); // another account's, held for it
    queue(null, 'cc-posted', 'cc-posted-l1'); // legacy: whoever drains it first (outbox-scope.ts)
    sweep('u1');
    expect(ids('select id from cycle_counts order by id')).toEqual(['cc-dirty', 'cc-posted']);
    expect(ids('select id from cycle_count_lines order by id')).toEqual([
      'cc-dirty-l1',
      'cc-dirty-l2',
      'cc-posted-l1',
    ]);
    // The outbox itself is never touched.
    expect(sqlite.prepare('select count(*) as n from pending_actions').get()).toEqual({ n: 3 });
  });

  it('an entry still in flight keeps its count; one already refused does not', () => {
    queue('u1', 'cc-dirty', 'cc-dirty-l1', 'sending');
    queue('u1', 'cc-open', 'cc-open-l1', 'failed');
    queue('u1', 'cc-posted', 'cc-posted-l1', 'rejected');
    sweep('u1');
    expect(ids('select id from cycle_counts order by id')).toEqual(['cc-dirty', 'cc-open']);
  });

  // NOT EXISTS, never NOT IN: one row whose payload names no count would make
  // `id not in (...)` NULL for every count and quietly keep them all.
  it('an outbox row that names no count never stops the sweep', () => {
    queue('u1', null, null);
    queue('u1', null, 'cc-open-l1');
    sweep('u1');
    expect(ids('select id from cycle_counts')).toEqual([]);
    expect(ids('select id from cycle_count_lines')).toEqual([]);
  });

  it('a count this pull confirmed is never swept here, entry or not', () => {
    sqlite.exec("update cycle_counts set last_synced_at = 100 where id = 'cc-open'");
    sweep('u1');
    expect(ids('select id from cycle_counts')).toEqual(['cc-open']);
    expect(ids('select id from cycle_count_lines')).toEqual(['cc-open-l1']);
  });

  /** One cached line's count and dirty flag. */
  const lineState = (id: string) =>
    sqlite.prepare('select counted, local_dirty from cycle_count_lines where id = ?').get(id) as {
      counted: number | null;
      local_dirty: number;
    };

  // Mutation caught: no release, or one that also releases this account's
  // own edit, or edits on counts this account's pulls confirmed; and a
  // release that keeps the other account's number (REVIEW-P2 of 254fb9c72):
  // on a count kept but not returned, no server value replaces it, so it
  // showed as the count recorded on the server.
  it("releases another account's local edit on an unconfirmed count, its number with it, and keeps this account's", () => {
    sqlite.exec(`
      update cycle_count_lines set local_dirty = 1, counted = 4 where id = 'cc-open-l1';
      update cycle_count_lines set local_dirty = 1, counted = 6 where id = 'cc-posted-l1';
      update cycle_counts set last_synced_at = 100 where id = 'cc-posted';
    `);
    queue('u1', 'cc-dirty', 'cc-dirty-l1');
    queue('u0', 'cc-open', 'cc-open-l1');
    queue('u0', 'cc-posted', 'cc-posted-l1');
    sqlite.prepare(UNCONFIRMED_LINES_RELEASE_SQL).run('u1');
    expect(lineState('cc-dirty-l1')).toEqual({ counted: 9, local_dirty: 1 }); // this account's: kept
    expect(lineState('cc-open-l1')).toEqual({ counted: null, local_dirty: 0 }); // another's: released
    expect(lineState('cc-posted-l1')).toEqual({ counted: 6, local_dirty: 1 }); // confirmed count: not this rule's
    // A clean line keeps whatever the server last said.
    sqlite.exec("update cycle_count_lines set counted = 3 where id = 'cc-dirty-l2'");
    sqlite.prepare(UNCONFIRMED_LINES_RELEASE_SQL).run('u1');
    expect(lineState('cc-dirty-l2')).toEqual({ counted: 3, local_dirty: 0 });
  });

  // Mutation caught: the release matching an entry to a count instead of a
  // line (REVIEW-P3 of 254fb9c72). On a count both accounts counted, the
  // other account's edit would then stay as this account's own.
  it.each([
    ['the full pull', () => sqlite.prepare(UNCONFIRMED_LINES_RELEASE_SQL).run('u1')],
    [
      "the count screen's write of that count",
      () => sqlite.prepare(UNCONFIRMED_LINES_RELEASE_ONE_COUNT_SQL).run('cc-dirty', 'u1'),
    ],
  ] as const)(
    "%s: on a count both accounts counted, only the other account's line is released",
    (_writer, release) => {
      sqlite.exec(
        `update cycle_count_lines set local_dirty = 1, counted = 5 where id = 'cc-dirty-l2'`,
      );
      queue('u0', 'cc-dirty', 'cc-dirty-l1'); // another account's edit
      queue('u1', 'cc-dirty', 'cc-dirty-l2'); // this account's, on the same count
      release();
      expect(lineState('cc-dirty-l1')).toEqual({ counted: null, local_dirty: 0 });
      expect(lineState('cc-dirty-l2')).toEqual({ counted: 5, local_dirty: 1 });
    },
  );

  it("the count screen's release touches only the count it is writing", () => {
    sqlite.exec(
      `update cycle_count_lines set local_dirty = 1, counted = 4 where id = 'cc-open-l1'`,
    );
    queue('u0', 'cc-open', 'cc-open-l1');
    queue('u0', 'cc-dirty', 'cc-dirty-l1');
    sqlite.prepare(UNCONFIRMED_LINES_RELEASE_ONE_COUNT_SQL).run('cc-open', 'u1');
    expect(lineState('cc-open-l1')).toEqual({ counted: null, local_dirty: 0 });
    expect(lineState('cc-dirty-l1')).toEqual({ counted: 9, local_dirty: 1 });
  });

  // Mutation caught: an entry that has settled still keeping the edit. The
  // outbox's own bookkeeping keeps a line dirty only while a live entry for it
  // is queued (cycle-count-cache.ts clearLineDirtyUnlessStillQueued).
  it('releases an edit whose only entry was refused, and keeps one with an entry still to send', () => {
    sqlite.exec(`
      update cycle_count_lines set local_dirty = 1, counted = 4 where id in ('cc-open-l1', 'cc-dirty-l1');
    `);
    queue('u1', 'cc-open', 'cc-open-l1', 'rejected');
    queue('u1', 'cc-dirty', 'cc-dirty-l1', 'failed');
    sqlite.prepare(UNCONFIRMED_LINES_RELEASE_SQL).run('u1');
    expect(lineState('cc-open-l1')).toEqual({ counted: null, local_dirty: 0 });
    expect(lineState('cc-dirty-l1')).toEqual({ counted: 4, local_dirty: 1 });
  });
});
