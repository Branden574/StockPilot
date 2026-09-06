import * as SQLite from 'expo-sqlite';

/**
 * Local SQLite layer for offline-first reads + queued writes.
 *
 * Mirrors only what the mobile app needs to read offline (items,
 * warehouses, open POs, open cycle counts, bundles). Snapshots are
 * pulled from the web; mobile is never authoritative.
 *
 * Schema versioning: bumping SCHEMA_VERSION wipes the local DB and
 * re-pulls. Acceptable because the local DB is a cache, not a source
 * of truth.
 *
 * v2 (offline cycle counting): cycle_counts gains organization_id,
 * warehouse_name, posted_at, cached_at. cycle_count_lines gains
 * item_name, item_sku, item_barcode, updated_at, local_dirty.
 * Indexed on count_id and on dirty rows so the sync engine can find
 * pending edits in O(log n) without scanning every line.
 */

const DB_NAME = 'stockpilot.db';
const SCHEMA_VERSION = 2;

let _db: SQLite.SQLiteDatabase | null = null;

export async function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (_db) return _db;
  _db = await SQLite.openDatabaseAsync(DB_NAME);
  await ensureSchema(_db);
  return _db;
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

async function ensureSchema(db: SQLite.SQLiteDatabase): Promise<void> {
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
  const current = row?.value ? Number(row.value) : 0;

  if (current !== SCHEMA_VERSION) {
    // Drop everything except meta and rebuild — local DB is a cache.
    await db.execAsync(`
      drop table if exists pending_actions;
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

      create table pending_actions (
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
      create index pending_actions_status_idx on pending_actions(status);
      create index pending_actions_kind_idx on pending_actions(kind);
    `);

    await db.runAsync(
      'insert or replace into meta (key, value) values (?, ?)',
      ['schema_version', String(SCHEMA_VERSION)],
    );
  }

  await addColumnIfMissing(
    db,
    'cycle_count_lines',
    'item_variant_label',
    'text',
  );
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
 */
export async function addColumnIfMissing(
  db: SQLite.SQLiteDatabase,
  table: string,
  column: string,
  type: string,
): Promise<void> {
  try {
    const cols = await db.getAllAsync<{ name: string }>(
      `pragma table_info(${table})`,
    );
    if (cols.some((c) => c.name === column)) return;
    await db.execAsync(`alter table ${table} add column ${column} ${type}`);
  } catch {
    // A racing open (two callers hitting getDb at once) can lose the add and
    // raise "duplicate column name". The column exists either way, which is
    // the only thing callers need — and a failed DISPLAY column must never
    // stop the app from opening its database.
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
 * `deleteOrgData` for the org-keying limitation. Callers that truly want a
 * full reset (sign-out) drop pending separately.
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
 * KNOWN LIMITATION — pending_actions are NOT org-keyed: the table has no
 * organization_id column, so we cannot reliably know which org a queued
 * offline write (receive_po_line / record_count / distribute_bundle / …)
 * belongs to. Rather than SILENTLY DROP a pending write on switch — which
 * could lose a user's queued PO receipt or count — we PRESERVE the queue as-is.
 * Each drain endpoint is independently server-side gated (assertModuleEnabled
 * + per-warehouse access + RLS), so a stale cross-org row 4xxs and lands in the
 * queue UI as "failed" rather than mutating the wrong org's data. Properly
 * scoping the outbox per org (add organization_id + flush-on-switch) is a
 * follow-up.
 */
export async function deleteOrgData(): Promise<void> {
  const db = await getDb();
  await clearOrgScopedTables(db);
}

export async function wipeForSignOut(): Promise<void> {
  const db = await getDb();
  await clearOrgScopedTables(db);
  // Sign-out is a full reset: the user (and any queued writes) are leaving the
  // device session entirely, so the pending outbox is dropped here too.
  //
  // EXCEPT rows already marked 'rejected'. Those are terminal — no drain reads
  // them, so keeping them cannot replay anything — and they are the only record
  // that queued work existed at all. This path also runs during the disabled-
  // account eviction, which rejects the outbox immediately beforehand
  // (use-account-gate.ts); deleting them here would mean the operator is shown
  // the disabled screen while the work they thought they had saved disappears
  // silently, and listRejected() could never return a row.
  await db.execAsync("delete from pending_actions where status <> 'rejected';");
}
