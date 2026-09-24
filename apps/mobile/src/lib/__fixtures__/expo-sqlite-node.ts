import { DatabaseSync } from 'node:sqlite';

import type { SQLiteDatabase } from 'expo-sqlite';

/**
 * expo-sqlite 57's async database surface over a REAL SQLite (node:sqlite), for
 * tests that must exercise the SQL rather than a mock of it.
 *
 * Only the methods the app calls are implemented: execAsync, runAsync,
 * getFirstAsync, getAllAsync and withTransactionAsync (expo-sqlite's own
 * implementation, line for line: BEGIN, task, COMMIT, and ROLLBACK on any
 * throw). Every call yields one macrotask first, as the native bridge does, so
 * interleavings between concurrent callers are as real as they are on a phone.
 *
 * `beforeCall` runs before each statement and may be async: a test uses it to
 * hold the database at an exact statement (a caller arriving mid-schema) or to
 * make one statement fail (a full disk on an ALTER).
 */
export interface NodeExpoDb {
  raw: DatabaseSync;
  execAsync(sql: string): Promise<void>;
  runAsync(sql: string, params?: unknown[]): Promise<{ lastInsertRowId: number; changes: number }>;
  getFirstAsync<T>(sql: string, params?: unknown[]): Promise<T | null>;
  getAllAsync<T>(sql: string, params?: unknown[]): Promise<T[]>;
  withTransactionAsync(task: () => Promise<void>): Promise<void>;
}

export interface NodeExpoDbHooks {
  beforeCall?: (sql: string) => void | Promise<void>;
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

type SqlValue = null | number | bigint | string | Uint8Array;

/** Typed as expo-sqlite's database too, so it can be handed to app code as-is
 *  (only the methods above exist; anything else is a test bug and throws). */
export type ExpoDbStandIn = NodeExpoDb & SQLiteDatabase;

export function nodeExpoDb(raw: DatabaseSync = new DatabaseSync(':memory:'), hooks: NodeExpoDbHooks = {}): ExpoDbStandIn {
  const before = async (sql: string) => {
    await tick();
    await hooks.beforeCall?.(sql);
  };
  const db: NodeExpoDb = {
    raw,
    async execAsync(sql) {
      await before(sql);
      raw.exec(sql);
    },
    async runAsync(sql, params = []) {
      await before(sql);
      const r = raw.prepare(sql).run(...(params as SqlValue[]));
      return { lastInsertRowId: Number(r.lastInsertRowid), changes: Number(r.changes) };
    },
    async getFirstAsync<T>(sql: string, params: unknown[] = []) {
      await before(sql);
      return (raw.prepare(sql).get(...(params as SqlValue[])) as T | undefined) ?? null;
    },
    async getAllAsync<T>(sql: string, params: unknown[] = []) {
      await before(sql);
      return raw.prepare(sql).all(...(params as SqlValue[])) as T[];
    },
    async withTransactionAsync(task) {
      try {
        await db.execAsync('BEGIN');
        await task();
        await db.execAsync('COMMIT');
      } catch (e) {
        await db.execAsync('ROLLBACK');
        throw e;
      }
    },
  };
  return db as unknown as ExpoDbStandIn;
}

/** The v2 phone schema as every shipped binary created it (db.ts at 35aa39e0),
 *  before this change added the outbox's organization_id / user_id. */
export const V2_CACHE_DDL = `
  create table warehouses (id text primary key, name text not null);
  create table items (
    id text primary key, sku text not null, name text not null, barcode text,
    quantity_on_hand real not null default 0, unit_cost real not null default 0,
    warehouse_id text, item_type text, last_synced_at integer not null
  );
  create index items_barcode_idx on items(barcode);
  create index items_sku_idx on items(sku);
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
  );
`;

/** pending_actions exactly as v2 (every shipped binary) created it. */
export const V2_OUTBOX_DDL = `
  create table pending_actions (
    id integer primary key autoincrement, kind text not null,
    idempotency_key text not null unique, payload_json text not null,
    created_at integer not null, attempts integer not null default 0,
    last_attempt_at integer, last_error text, status text not null default 'pending'
  );
  create index pending_actions_status_idx on pending_actions(status);
  create index pending_actions_kind_idx on pending_actions(kind);
`;

/** pending_actions as v1 (before 2026-05-10) created it: no last_attempt_at. */
export const V1_OUTBOX_DDL = `
  create table pending_actions (
    id integer primary key autoincrement, kind text not null,
    idempotency_key text not null unique, payload_json text not null,
    created_at integer not null, attempts integer not null default 0,
    last_error text, status text not null default 'pending'
  );
  create index pending_actions_status_idx on pending_actions(status);
`;

/** Three queued rows, the way an older binary wrote them (no org, no user). */
export const THREE_QUEUED_ROWS = `
  insert into pending_actions (kind, idempotency_key, payload_json, created_at)
    values ('record_count', 'k1', '{"cycleCountId":"c1","lineId":"l1","countedQuantity":7}', 1);
  insert into pending_actions (kind, idempotency_key, payload_json, created_at)
    values ('receive_po_line', 'k2', '{"poId":"p1","lineId":"pl1","quantity":2}', 2);
  insert into pending_actions (kind, idempotency_key, payload_json, created_at)
    values ('distribute_bundle', 'k3', '{"bundleId":"b1","quantity":1}', 3);
`;
