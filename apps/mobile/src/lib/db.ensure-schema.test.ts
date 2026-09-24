import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it, vi } from 'vitest';

import {
  nodeExpoDb,
  THREE_QUEUED_ROWS,
  V1_OUTBOX_DDL,
  V2_CACHE_DDL,
  V2_OUTBOX_DDL,
} from './__fixtures__/expo-sqlite-node';
import { ensureSchema } from './db';

// db.ts imports expo-sqlite (native); ensureSchema is driven directly here.
vi.mock('expo-sqlite', () => ({ openDatabaseAsync: vi.fn() }));

/**
 * The outbox survives every schema version the phone can meet (S4c).
 *
 * ensureSchema used to compare `current !== SCHEMA_VERSION` and, on ANY
 * difference, start by dropping pending_actions. Run against the real db.ts,
 * a phone at stored v2 kept 3 of 3 queued rows, while stored v1 (older) and
 * stored v3 (an older bundle launched on a newer database: an expo-updates
 * rollback or an emergency launch of the embedded bundle) each kept 0 of 3.
 * No device is exposed today only because the value has been 2 since
 * 2026-05-10; the first bump would have wiped every outbox on update.
 */

function phoneAt(version: number | null, opts: { outbox?: 'v1' | 'v2'; cachedItem?: boolean } = {}): DatabaseSync {
  const raw = new DatabaseSync(':memory:');
  raw.exec('create table meta (key text primary key, value text);');
  if (version !== null) {
    raw.prepare('insert into meta (key, value) values (?, ?)').run('schema_version', String(version));
  }
  raw.exec(V2_CACHE_DDL);
  raw.exec(opts.outbox === 'v1' ? V1_OUTBOX_DDL : V2_OUTBOX_DDL);
  raw.exec(THREE_QUEUED_ROWS);
  if (opts.cachedItem) {
    raw.exec(`insert into items (id, sku, name, last_synced_at) values ('i1', 'SKU-1', 'Chair', 1);`);
  }
  return raw;
}

const queued = (raw: DatabaseSync) =>
  raw.prepare('select kind, idempotency_key, status from pending_actions order by id').all();

const THE_THREE = [
  { kind: 'record_count', idempotency_key: 'k1', status: 'pending' },
  { kind: 'receive_po_line', idempotency_key: 'k2', status: 'pending' },
  { kind: 'distribute_bundle', idempotency_key: 'k3', status: 'pending' },
];

const columns = (raw: DatabaseSync, table: string) =>
  (raw.prepare(`pragma table_info(${table})`).all() as { name: string }[]).map((c) => c.name);

const storedVersion = (raw: DatabaseSync) =>
  (raw.prepare("select value from meta where key = 'schema_version'").get() as { value: string } | undefined)?.value;

describe('ensureSchema keeps every queued row, whatever version the phone is at', () => {
  it.each([
    [1, 'v1' as const, 'older: the cache is rebuilt'],
    [2, 'v2' as const, 'current: nothing is rebuilt'],
    [3, 'v2' as const, 'NEWER (an older bundle on a migrated database)'],
  ])('stored schema_version %i (%s, %s): all 3 queued rows survive', async (version, outbox, _why) => {
    const raw = phoneAt(version, { outbox });

    await ensureSchema(nodeExpoDb(raw));

    expect(queued(raw)).toEqual(THE_THREE);
    // The drains read last_attempt_at; a v1 outbox gains it in place.
    expect(columns(raw, 'pending_actions')).toContain('last_attempt_at');
  });

  it('an OLDER schema rebuilds the cache tables, and only those', async () => {
    const raw = phoneAt(1, { outbox: 'v1', cachedItem: true });

    await ensureSchema(nodeExpoDb(raw));

    expect(raw.prepare('select count(*) as n from items').get()).toEqual({ n: 0 });
    expect(storedVersion(raw)).toBe('2');
    expect(queued(raw)).toEqual(THE_THREE);
  });

  it('a NEWER schema is left alone: an older bundle never rebuilds it', async () => {
    const raw = phoneAt(3, { cachedItem: true });

    await ensureSchema(nodeExpoDb(raw));

    // Neither dropped nor re-stamped down to this bundle's version.
    expect(storedVersion(raw)).toBe('3');
    expect(raw.prepare('select id from items').all()).toEqual([{ id: 'i1' }]);
    expect(queued(raw)).toEqual(THE_THREE);
  });

  it('a fresh install gets every table, the outbox included, at version 2', async () => {
    const raw = new DatabaseSync(':memory:');

    await ensureSchema(nodeExpoDb(raw));

    const tables = (raw.prepare("select name from sqlite_master where type = 'table'").all() as { name: string }[]).map(
      (t) => t.name,
    );
    expect(tables).toEqual(
      expect.arrayContaining([
        'meta',
        'warehouses',
        'items',
        'purchase_orders',
        'po_lines',
        'cycle_counts',
        'cycle_count_lines',
        'bundles',
        'bundle_components',
        'pending_actions',
      ]),
    );
    const indexes = (raw.prepare("select name from sqlite_master where type = 'index'").all() as { name: string }[]).map(
      (i) => i.name,
    );
    expect(indexes).toEqual(expect.arrayContaining(['pending_actions_status_idx', 'pending_actions_kind_idx']));
    expect(storedVersion(raw)).toBe('2');
  });

  it('keeps the stored version at 2, so an older bundle (which compares with !==) never drops the outbox', async () => {
    // Every binary and bundle shipped before this change runs
    // `if (current !== 2) { drop table if exists pending_actions; ... }`.
    // A rollback to one of them is safe only while this bundle leaves the
    // stored version exactly where they expect it.
    for (const raw of [phoneAt(2), new DatabaseSync(':memory:')]) {
      await ensureSchema(nodeExpoDb(raw));
      const olderBundleWouldDrop = Number(storedVersion(raw)) !== 2;
      expect(olderBundleWouldDrop).toBe(false);
    }
  });

  it('is safe to run on every launch', async () => {
    const raw = phoneAt(2, { cachedItem: true });

    await ensureSchema(nodeExpoDb(raw));
    await ensureSchema(nodeExpoDb(raw));

    expect(queued(raw)).toEqual(THE_THREE);
    expect(raw.prepare('select count(*) as n from items').get()).toEqual({ n: 1 });
  });
});
