import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it, vi } from 'vitest';

// db.ts imports expo-sqlite (native); only the pure addColumnIfMissing is used.
vi.mock('expo-sqlite', () => ({ openDatabaseAsync: vi.fn() }));

import { addColumnIfMissing } from './db';

/**
 * The phone gains cycle_counts.count_number IN PLACE. A SCHEMA_VERSION bump
 * would drop every table, pending_actions (the offline outbox) included, so a
 * counter's unsynced work would vanish on update. This runs the real
 * migration call against a real SQLite holding a pre-0358 cache with queued
 * work, and checks nothing is lost.
 */
function adapter(db: DatabaseSync) {
  return {
    getAllAsync: async (sql: string) => db.prepare(sql).all(),
    execAsync: async (sql: string) => {
      db.exec(sql);
    },
  };
}

function preMigrationDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  // The pre-0358 shapes, verbatim from db.ts.
  db.exec(`
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
    create table pending_actions (
      id integer primary key autoincrement, kind text not null,
      idempotency_key text not null unique, payload_json text not null,
      created_at integer not null, attempts integer not null default 0,
      last_attempt_at integer, last_error text, status text not null default 'pending'
    );
    insert into cycle_counts (id, status, warehouse_name, started_at, notes, last_synced_at, cached_at)
      values ('c1', 'in_progress', 'DC4', '2026-09-01T00:00:00Z', 'Aisle 4', 1, 123);
    insert into cycle_count_lines (id, count_id, item_id, expected, counted, local_dirty)
      values ('l1', 'c1', 'i1', 10, 7, 1);
    insert into pending_actions (kind, idempotency_key, payload_json, created_at)
      values ('record_count', 'k1', '{"cycleCountId":"c1","lineId":"l1","countedQuantity":7}', 1);
  `);
  return db;
}

describe('adding count_number to an existing phone cache', () => {
  it('adds the column and keeps every cached count, line and queued action', async () => {
    const db = preMigrationDb();
    await addColumnIfMissing(adapter(db) as never, 'cycle_counts', 'count_number', 'integer');

    const cols = (db.prepare('pragma table_info(cycle_counts)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain('count_number');
    expect(db.prepare('select * from cycle_counts').all()).toEqual([
      expect.objectContaining({ id: 'c1', cached_at: 123, notes: 'Aisle 4', count_number: null }),
    ]);
    expect(db.prepare('select counted, local_dirty from cycle_count_lines').get()).toEqual({
      counted: 7,
      local_dirty: 1,
    });
    expect(db.prepare('select kind, idempotency_key, status from pending_actions').all()).toEqual([
      { kind: 'record_count', idempotency_key: 'k1', status: 'pending' },
    ]);
  });

  it('is safe to run on every launch', async () => {
    const db = preMigrationDb();
    await addColumnIfMissing(adapter(db) as never, 'cycle_counts', 'count_number', 'integer');
    await addColumnIfMissing(adapter(db) as never, 'cycle_counts', 'count_number', 'integer');
    const cols = (db.prepare('pragma table_info(cycle_counts)').all() as { name: string }[]).map((c) => c.name);
    expect(cols.filter((c) => c === 'count_number')).toHaveLength(1);
    expect(db.prepare('select count(*) as n from pending_actions').get()).toEqual({ n: 1 });
  });
});
