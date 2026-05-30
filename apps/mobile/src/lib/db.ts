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
  await getDb();
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

export async function wipeForSignOut(): Promise<void> {
  const db = await getDb();
  await db.execAsync(`
    delete from items;
    delete from warehouses;
    delete from purchase_orders;
    delete from po_lines;
    delete from cycle_counts;
    delete from cycle_count_lines;
    delete from bundles;
    delete from bundle_components;
    delete from pending_actions;
    delete from meta where key = 'last_synced_at';
    delete from meta where key = 'enabled_modules';
  `);
}
