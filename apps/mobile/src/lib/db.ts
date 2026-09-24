import * as SQLite from 'expo-sqlite';

/**
 * Local SQLite layer for offline-first reads + queued writes.
 *
 * Mirrors only what the mobile app needs to read offline (items,
 * warehouses, open POs, open cycle counts, bundles). Snapshots are
 * pulled from the web; mobile is never authoritative.
 *
 * Schema versioning: bumping SCHEMA_VERSION drops and rebuilds the CACHE
 * tables and re-pulls. Acceptable because they are a cache, not a source of
 * truth. The outbox (pending_actions) is NOT a cache: it is created outside
 * that branch and never dropped (see ensureSchema).
 *
 * v2 (offline cycle counting): cycle_counts gains organization_id,
 * warehouse_name, posted_at, cached_at. cycle_count_lines gains
 * item_name, item_sku, item_barcode, updated_at, local_dirty.
 * Indexed on count_id and on dirty rows so the sync engine can find
 * pending edits in O(log n) without scanning every line.
 */

const DB_NAME = 'stockpilot.db';
/**
 * DO NOT BUMP this until a store binary carrying the `current < SCHEMA_VERSION`
 * rule below is the MINIMUM installed version. Every binary and bundle shipped
 * before it compares with `!==` and drops pending_actions on ANY difference, and
 * an emergency launch of a binary's embedded bundle, or a republished older OTA,
 * would run exactly that code against a bumped database and wipe the outbox.
 * Add columns in place with addColumnIfMissing instead.
 */
const SCHEMA_VERSION = 2;

/**
 * The ONE open of the app's database, shared by every caller.
 *
 * It used to be `if (_db) return _db; _db = await open(); await ensureSchema(_db)`,
 * which handed the connection out BEFORE its schema was ready: a second caller
 * arriving while ensureSchema ran (the root layout's initDb, useSync and
 * useEnabledModules all call getDb on their own at launch) got the database
 * mid-migration ("no such column: count_number" after a column-adding OTA),
 * and two callers arriving before the open resolved both opened it and both
 * ran ensureSchema ("table warehouses already exists" on a fresh install).
 *
 * Now every caller awaits the same promise, which resolves only once the
 * schema is complete. A rejected open or migration is forgotten, so the next
 * caller tries again instead of inheriting the failure for the life of the
 * process (a full disk that clears, a transient native error).
 */
let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

export function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) {
    const opening = openAndMigrate();
    dbPromise = opening;
    opening.catch(() => {
      if (dbPromise === opening) dbPromise = null;
    });
  }
  return dbPromise;
}

async function openAndMigrate(): Promise<SQLite.SQLiteDatabase> {
  const db = await SQLite.openDatabaseAsync(DB_NAME);
  await ensureSchema(db);
  return db;
}

/**
 * Transactions run one at a time. expo-sqlite's withTransactionAsync is
 * BEGIN / task / COMMIT on the app's ONE connection, so a second caller that
 * starts while the first is still awaiting fails its BEGIN ("cannot start a
 * transaction within a transaction") and its catch then runs ROLLBACK, which
 * rolls back the FIRST caller's open transaction. The first caller's
 * remaining statements then autocommit one by one and its COMMIT and ROLLBACK
 * both fail ("no transaction is active"). A snapshot pull and a screen caching
 * what it just fetched (the cycle-count detail opened from a notification at
 * cold start) collided exactly like that. Every transaction in the app goes
 * through this queue instead of calling withTransactionAsync directly.
 *
 * A task must not call withDbTransaction itself: it would wait on its own
 * turn forever. Tasks run plain statements only.
 */
type TransactionDb = Pick<SQLite.SQLiteDatabase, 'withTransactionAsync'>;
let transactionQueue: Promise<void> = Promise.resolve();

export function withDbTransaction(db: TransactionDb, task: () => Promise<void>): Promise<void> {
  const run = transactionQueue.then(() => db.withTransactionAsync(task));
  // The next transaction waits for this one to finish, not to succeed.
  transactionQueue = run.catch(() => undefined);
  return run;
}

/**
 * Idempotent app-startup hook — wires DB open + migrations into the
 * root layout effect so any screen that runs `getDb()` after this
 * resolves can assume the schema exists.
 */
export async function initDb(): Promise<void> {
  const db = await getDb();
  // Reclaim orphaned in-flight outbox rows. A row is flipped to 'sending' only
  // transiently inside a live drain, immediately before the network request; if
  // the JS runtime dies in that window (OS memory-kill of a backgrounded app,
  // crash, force-quit — routine on flaky warehouse wifi) the row is stranded at
  // 'sending' forever, because BOTH drain queries only look at 'pending'/'failed'
  // — so the offline write is silently lost and the unsynced badge sticks. Any
  // 'sending' row present at startup is definitionally orphaned (no drain is in
  // flight yet), so reset it to 'pending' to be re-drained.
  try {
    await db.runAsync(
      "update pending_actions set status = 'pending' where status = 'sending'",
    );
  } catch {
    /* best-effort reclaim — never block app startup */
  }
}

/** The statements ensureSchema needs; expo-sqlite's database satisfies it. */
export type SchemaDb = Pick<SQLite.SQLiteDatabase, 'execAsync' | 'getFirstAsync' | 'getAllAsync' | 'runAsync'>;

/**
 * Brings the phone's database up to this bundle's shape. Exported so the
 * version rules can be executed against a real SQLite (db.ensure-schema.test.ts).
 *
 * TWO kinds of table live here, with opposite rules:
 *
 *   - the CACHE (items, POs, counts, bundles, warehouses): pulled from the
 *     server, safe to drop and rebuild, and rebuilt only when the stored
 *     version is OLDER than this bundle's;
 *   - the OUTBOX (pending_actions): the operator's unsent work, the one thing
 *     on the phone that exists nowhere else. It is created unconditionally with
 *     `if not exists`, outside the destructive branch, and only ever widened in
 *     place. It used to be the first table dropped whenever the stored version
 *     differed at all, in either direction.
 *
 * `current < SCHEMA_VERSION`, not `!==`: an OLDER bundle running on a database
 * a newer one already migrated (an expo-updates rollback, an emergency launch
 * of the embedded bundle, a republished older OTA) must not rebuild the newer
 * schema. That protects bumps made AFTER this ships; see SCHEMA_VERSION.
 */
export async function ensureSchema(db: SchemaDb): Promise<void> {
  await db.execAsync(`
    create table if not exists meta (
      key text primary key,
      value text
    );
  `);

  const row = await db.getFirstAsync<{ value: string }>(
    'select value from meta where key = ?',
    ['schema_version'],
  );
  // An unreadable value is treated as a fresh install: rebuild the cache.
  const stored = row?.value ? Number(row.value) : 0;
  const current = Number.isFinite(stored) ? stored : 0;

  if (current < SCHEMA_VERSION) {
    // Drop and rebuild the CACHE tables only. pending_actions is deliberately
    // absent from this list: see the outbox block below.
    await db.execAsync(`
      drop table if exists bundle_components;
      drop table if exists bundles;
      drop table if exists cycle_count_lines;
      drop table if exists cycle_counts;
      drop table if exists po_lines;
      drop table if exists purchase_orders;
      drop table if exists items;
      drop table if exists warehouses;
    `);

    await db.execAsync(`
      create table warehouses (
        id text primary key,
        name text not null
      );

      create table items (
        id text primary key,
        sku text not null,
        name text not null,
        barcode text,
        quantity_on_hand real not null default 0,
        unit_cost real not null default 0,
        warehouse_id text,
        item_type text,
        last_synced_at integer not null
      );
      create index items_barcode_idx on items(barcode);
      create index items_sku_idx on items(sku);

      create table purchase_orders (
        id text primary key,
        po_number text,
        status text,
        warehouse_id text,
        expected_at text,
        last_synced_at integer not null
      );

      create table po_lines (
        id text primary key,
        po_id text not null,
        item_id text not null,
        qty_ordered real not null,
        qty_received real not null default 0,
        unit_cost real not null default 0
      );
      create index po_lines_po_idx on po_lines(po_id);
      create index po_lines_item_idx on po_lines(item_id);

      create table cycle_counts (
        id text primary key,
        organization_id text,
        status text,
        warehouse_id text,
        warehouse_name text,
        started_at text,
        posted_at text,
        assigned_to text,
        notes text,
        last_synced_at integer not null,
        cached_at integer
      );

      create table cycle_count_lines (
        id text primary key,
        count_id text not null,
        item_id text not null,
        item_name text,
        item_sku text,
        item_barcode text,
        expected real not null default 0,
        counted real,
        updated_at text,
        local_dirty integer not null default 0
      );
      create index cycle_count_lines_count_idx on cycle_count_lines(count_id);
      create index cycle_count_lines_item_idx on cycle_count_lines(item_id);
      create index cycle_count_lines_dirty_idx on cycle_count_lines(local_dirty);

      create table bundles (
        id text primary key,
        name text not null,
        sku text,
        preassembly_enabled integer not null default 0,
        phantom_item_id text,
        phantom_qty real not null default 0,
        phantom_warehouse_id text,
        last_synced_at integer not null
      );

      create table bundle_components (
        bundle_id text not null,
        item_id text not null,
        quantity real not null,
        is_optional integer not null default 0,
        primary key (bundle_id, item_id)
      );
    `);

    await db.runAsync(
      'insert or replace into meta (key, value) values (?, ?)',
      ['schema_version', String(SCHEMA_VERSION)],
    );
  }

  // ═══ THE OUTBOX — never dropped, only widened ═══
  //
  // Unconditional and idempotent: a fresh install creates it, every other
  // launch finds it and keeps every queued row, whatever version the cache
  // tables are at. Columns a later bundle needs are added in place below.
  await db.execAsync(`
    create table if not exists pending_actions (
      id integer primary key autoincrement,
      kind text not null,
      idempotency_key text not null unique,
      payload_json text not null,
      created_at integer not null,
      attempts integer not null default 0,
      last_attempt_at integer,
      last_error text,
      status text not null default 'pending'
    );
    create index if not exists pending_actions_status_idx on pending_actions(status);
    create index if not exists pending_actions_kind_idx on pending_actions(kind);
  `);
  // A v1 outbox (before 2026-05-10) predates last_attempt_at. No shipped
  // binary is still on v1, but the rebuild that used to supply the column no
  // longer touches this table, so it is added here instead.
  await addColumnIfMissing(db, 'pending_actions', 'last_attempt_at', 'integer');
  // WHOSE work each row is (outbox-scope.ts): the organization and the user it
  // was queued under. REQUIRED, so a failure here fails the open loudly (and
  // the next getDb retries) rather than leaving every enqueue naming a column
  // that is not there. Rows an older binary queued read NULL: legacy rows,
  // sent once under whoever drains them first, as they always were. An older
  // bundle running on this table ignores both columns and keeps working: it
  // names its columns explicitly on insert.
  await addColumnIfMissing(db, 'pending_actions', 'organization_id', 'text');
  await addColumnIfMissing(db, 'pending_actions', 'user_id', 'text');

  await addDisplayColumn(db, 'cycle_count_lines', 'item_variant_label', 'text');
  // The count's permanent reference, CC-000042 (server migration 0358). A
  // display column, so it is added in place (never a SCHEMA_VERSION bump: older
  // bundles drop the outbox on one): existing rows read NULL, shown as "Reference
  // unavailable" until the next snapshot pull or online open fills them.
  await addDisplayColumn(db, 'cycle_counts', 'count_number', 'integer');
}

/**
 * A DISPLAY column stays best-effort: failing to add one must not stop the app
 * opening its database (the scan, items and outbox paths never name it). The
 * failure is logged now instead of vanishing; the next launch tries again.
 */
async function addDisplayColumn(
  db: SchemaDb,
  table: string,
  column: string,
  type: string,
): Promise<void> {
  try {
    await addColumnIfMissing(db, table, column, type);
  } catch (e) {
    console.warn(`[db] could not add display column ${table}.${column}`, e);
  }
}

/**
 * Additive, NON-DESTRUCTIVE column migration.
 *
 * Bumping SCHEMA_VERSION drops every cached table — including
 * `pending_actions`, the offline OUTBOX. A counter who has recorded counts on
 * a plane would silently lose them on the next app launch. Adding a purely
 * display-only column is not worth that, so this widens the table in place and
 * treats an already-present column as success.
 *
 * SQLite's `alter table add column` is O(1) (it only rewrites the schema, not
 * the rows) and existing rows read the new column as NULL — which for a
 * variant label is exactly right: they re-cache on the next open of the count.
 *
 * Exported for the pure-module test in db.addColumnIfMissing.test.ts — this
 * one function is what keeps a future display-only column from being "solved"
 * by bumping SCHEMA_VERSION instead, which is the outbox-wiping path.
 *
 * FAILS LOUDLY. It used to swallow every error, so an ALTER that failed for a
 * real reason (a full disk) left the column absent while the app carried on as
 * if it existed, and every later statement naming it failed instead: for the
 * outbox's organization_id / user_id that would be every enqueue, so an operator
 * could not queue work at all. Only "duplicate column name" is success (a
 * racing add got there first; the error itself proves the column exists), and
 * a completed ALTER is confirmed by reading table_info back. Callers that can
 * live without a column (display-only ones) catch; the outbox's do not.
 */
export async function addColumnIfMissing(
  db: Pick<SQLite.SQLiteDatabase, 'getAllAsync' | 'execAsync'>,
  table: string,
  column: string,
  type: string,
): Promise<void> {
  const hasColumn = async () =>
    (await db.getAllAsync<{ name: string }>(`pragma table_info(${table})`)).some(
      (c) => c.name === column,
    );
  if (await hasColumn()) return;
  try {
    await db.execAsync(`alter table ${table} add column ${column} ${type}`);
  } catch (e) {
    if (/duplicate column name/i.test(e instanceof Error ? e.message : String(e))) return;
    throw e;
  }
  if (!(await hasColumn())) {
    throw new Error(`addColumnIfMissing: ${table}.${column} is still missing after the ALTER`);
  }
}

export async function getMeta(key: string): Promise<string | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ value: string }>(
    'select value from meta where key = ?',
    [key],
  );
  return row?.value ?? null;
}

export async function setMeta(key: string, value: string): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    'insert or replace into meta (key, value) values (?, ?)',
    [key, value],
  );
}

/**
 * Clears every per-org cached data table (items, warehouses, POs + lines,
 * cycle counts + lines, bundles + components) and every org-scoped `meta`
 * key sync.ts persists on a pull: the sync cursor (`last_synced_at`), the
 * `enabled_modules` set, the `effective_permissions` set and the
 * `warehouse_scope`. Shared by `deleteOrgData` (org switch) and
 * `wipeForSignOut` (sign-out).
 *
 * WHY the last two are here: they were omitted, so an org switch left Org A's
 * permission set and warehouse scope persisted under Org B. The post-switch
 * pull that would overwrite them is fire-and-forget (use-workspace.ts
 * `void syncNow(true)`), so with no network the stale values simply stood —
 * the Items screen banner read "You're viewing <Org A's warehouse> only" for
 * Org B, and the drawer was gated by Org A's permissions. Cosmetic (the API
 * and RLS enforce both server-side — see the notes in use-effective-
 * permissions.ts and warehouse-scope.ts) but false, and it survived relaunches
 * because these are persisted, not in-memory, values. Cleared here rather than
 * at the call site so the sign-out path gets it too: on a shared device the
 * next user would otherwise inherit the previous user's persisted scope until
 * their first pull. Both readers treat "absent" as not-loaded-yet and fall
 * back to their documented defaults (static role permissions; no banner).
 *
 * The keys are pinned against sync.ts's writers by
 * db-clear-keys.wiring.test.ts — add a key there, clear it here.
 *
 * Deliberately does NOT touch `pending_actions` — see the note on
 * `deleteOrgData`: queued rows carry their own organization and account.
 */
async function clearOrgScopedTables(db: SQLite.SQLiteDatabase): Promise<void> {
  await db.execAsync(`
    delete from items;
    delete from warehouses;
    delete from purchase_orders;
    delete from po_lines;
    delete from cycle_counts;
    delete from cycle_count_lines;
    delete from bundles;
    delete from bundle_components;
    delete from meta where key = 'last_synced_at';
    delete from meta where key = 'enabled_modules';
    delete from meta where key = 'effective_permissions';
    delete from meta where key = 'warehouse_scope';
  `);
}

/**
 * Bumped the moment a wipe of the org-scoped cache is REQUESTED (workspace
 * switch, workspace repair, sign-out), before the wipe waits its turn in the
 * transaction queue. A snapshot pull notes the value before it reads its
 * cursor and sends its request, and discards its answer if the value has moved
 * (sync.ts): that answer belongs to a cache that has been, or is about to be,
 * wiped. Keyed on wipes, not on the workspace id, so the first pull after
 * sign-in (sent before the workspace was saved, answered for the same default
 * workspace) is kept.
 */
let cacheGeneration = 0;

export function currentCacheGeneration(): number {
  return cacheGeneration;
}

/**
 * Wipe the local SQLite cache for an ORG SWITCH (multi-org device isolation).
 *
 * Clears all per-org cached data tables and resets the delta cursor
 * (`last_synced_at`) so the next snapshot pull MUST be unconditional (no
 * `?since`) and therefore scoped entirely to the newly-active org. Without
 * this, a multi-org user transiently sees the previous org's
 * items/POs/counts/bundles, and the `?since` cursor is wrong (it belongs to
 * the prior org's timeline).
 *
 * Also clears the persisted `enabled_modules`, `effective_permissions` and
 * `warehouse_scope` so the drawer/tab gating and the Items scoped-view banner
 * re-derive from the new org's snapshot rather than the prior org's values.
 *
 * NOTE for callers: clearing the persisted values is only half of an
 * in-session switch. `useEffectivePermissions()` / `useWarehouseScope()` hold
 * the last value in React state and re-read only when notified, so a caller
 * switching orgs should call `refreshEffectivePermissions()` and
 * `refreshWarehouseScope()` after this returns; otherwise the stale banner
 * lingers on screen (though no longer on disk) until the forced pull lands or
 * the app is relaunched.
 *
 * The outbox (pending_actions) is deliberately NOT touched. Every row carries
 * the organization it was queued in (outbox-scope.ts), and the drains send it
 * under that organization whatever workspace is active, so a switch neither
 * loses queued work nor replays it into the new workspace. (Before the rows
 * were org-keyed, a row queued in org A was sent with org B's header after a
 * switch, refused 404/403, and terminally rejected: the work was lost.)
 */
export async function deleteOrgData(): Promise<void> {
  cacheGeneration += 1;
  const db = await getDb();
  // Queued like every transaction, so the wipe never interleaves with a
  // snapshot pull that is mid-write.
  await withDbTransaction(db, () => clearOrgScopedTables(db));
}

/**
 * SIGN-OUT: clear the cache, KEEP the outbox (owner decision D5).
 *
 * This used to delete every pending, failed and sending row, so signing out
 * with queued counts lost them silently, most often exactly when the queue held
 * work (offline, weak warehouse Wi-Fi). Every row now carries its account
 * (outbox-scope.ts), so it can simply stay: held for that account, never sent
 * as anyone else, and sent when it signs in here again. The one explicit way to
 * drop it is "Sign out and discard" (sign-out-flow.ts, queue.ts
 * discardUnsyncedFor), or Discard in Unsent work.
 */
export async function wipeForSignOut(): Promise<void> {
  cacheGeneration += 1;
  const db = await getDb();
  await withDbTransaction(db, () => clearOrgScopedTables(db));
}

/**
 * ACCOUNT EVICTION (a confirmed disable): the cache, and every unsent row that
 * is not already rejected. Exactly what wipeForSignOut did before sign-out
 * stopped deleting queued work, kept for this one path.
 *
 * The eviction rejects the outbox immediately beforehand (use-account-gate.ts),
 * so normally nothing is left to delete. The delete is the fallback for when
 * that rejection failed: losing the record is bad, but a row left 'pending'
 * would replay the moment the account is re-enabled, which is worse.
 *
 * Rows already 'rejected' are spared: terminal (no drain reads them) and the
 * only record that the queued work existed, so the operator shown the disabled
 * screen can still be told what was never sent (listRejected).
 */
export async function wipeForEviction(): Promise<void> {
  cacheGeneration += 1;
  const db = await getDb();
  await withDbTransaction(db, async () => {
    await clearOrgScopedTables(db);
    await db.execAsync("delete from pending_actions where status <> 'rejected';");
  });
}
