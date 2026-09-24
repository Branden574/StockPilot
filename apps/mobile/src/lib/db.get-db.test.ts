import { DatabaseSync } from 'node:sqlite';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  nodeExpoDb,
  THREE_QUEUED_ROWS,
  V2_CACHE_DDL,
  V2_OUTBOX_DDL,
  type NodeExpoDbHooks,
} from './__fixtures__/expo-sqlite-node';

/**
 * getDb() hands out ONE database, and only once its schema is complete (S4d).
 *
 * The old getDb stored the connection before `await ensureSchema(...)` and did
 * not memoize the open, so (reproduced against the real db.ts):
 *   - a caller arriving mid-migration got the database without the column the
 *     migration was adding ("no such column: count_number");
 *   - two cold callers both opened it and both ran ensureSchema ("table
 *     warehouses already exists" on a fresh install).
 * Both effects become hard failures once the outbox names organization_id /
 * user_id, because an early enqueue or drain would name a column that is not
 * there yet.
 *
 * Runs the REAL db.ts over a real SQLite: expo-sqlite's openDatabaseAsync is
 * replaced by one that returns the same node:sqlite-backed handle every time,
 * as iOS does for a second open of the same file.
 */

const sqlite = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('expo-sqlite', () => ({ openDatabaseAsync: sqlite.open }));

type DbModule = typeof import('./db');

/** A fresh db.ts module: getDb's memo is module state. */
async function freshDbModule(): Promise<DbModule> {
  vi.resetModules();
  return import('./db');
}

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function openReturns(raw: DatabaseSync, hooks: NodeExpoDbHooks = {}) {
  const handle = nodeExpoDb(raw, hooks);
  sqlite.open.mockReset().mockImplementation(async () => handle);
  return handle;
}

/** A phone that last ran a pre-0358 bundle: v2 tables without count_number. */
function pre0358Phone(): DatabaseSync {
  const raw = new DatabaseSync(':memory:');
  raw.exec(`create table meta (key text primary key, value text);
            insert into meta values ('schema_version', '2');`);
  raw.exec(V2_CACHE_DDL);
  raw.exec(V2_OUTBOX_DDL);
  raw.exec(THREE_QUEUED_ROWS);
  raw.exec(`insert into cycle_counts (id, status, last_synced_at, cached_at)
            values ('c1', 'in_progress', 1, 1);`);
  return raw;
}

beforeEach(() => {
  sqlite.open.mockReset();
});

describe('getDb — one open, handed out only when the schema is complete', () => {
  it('two concurrent cold callers open the database ONCE and both get it', async () => {
    const raw = new DatabaseSync(':memory:');
    const handle = openReturns(raw);
    const { getDb } = await freshDbModule();

    const [a, b] = await Promise.all([getDb(), getDb()]);

    expect(sqlite.open).toHaveBeenCalledTimes(1);
    expect(a).toBe(handle);
    expect(b).toBe(handle);
    // The schema was built once, whole.
    const tables = (
      raw.prepare("select name from sqlite_master where type = 'table'").all() as { name: string }[]
    ).map((t) => t.name);
    expect(tables).toEqual(
      expect.arrayContaining(['meta', 'warehouses', 'items', 'cycle_counts', 'pending_actions']),
    );
  });

  it('a caller arriving mid-migration waits for it, then sees the new column', async () => {
    const raw = pre0358Phone();
    const gate = deferred();
    const reached = deferred();
    openReturns(raw, {
      beforeCall: async (sql) => {
        if (sql === 'pragma table_info(cycle_counts)') {
          reached.resolve();
          await gate.promise;
        }
      },
    });
    const { getDb } = await freshDbModule();

    const first = getDb();
    await reached.promise; // ensureSchema is now about to add count_number
    const second = getDb();

    const early = await Promise.race([
      second.then(async (db) => {
        try {
          await db.getAllAsync('select count_number from cycle_counts');
          return 'query ran';
        } catch (e) {
          return `query failed: ${(e as Error).message}`;
        }
      }),
      sleep(30).then(() => 'still waiting'),
    ]);
    // The old getDb returned the connection here, before the ALTER ran.
    expect(early).toBe('still waiting');

    gate.resolve();
    const db = await second;
    expect(await first).toBe(db);
    expect(await db.getAllAsync('select id, count_number from cycle_counts')).toEqual([
      { id: 'c1', count_number: null },
    ]);
    expect(sqlite.open).toHaveBeenCalledTimes(1);
  });

  it('a failed open is forgotten: the next caller opens again instead of inheriting the failure', async () => {
    const raw = new DatabaseSync(':memory:');
    const handle = nodeExpoDb(raw);
    sqlite.open
      .mockReset()
      .mockRejectedValueOnce(new Error('unable to open database file'))
      .mockImplementation(async () => handle);
    const { getDb } = await freshDbModule();

    await expect(getDb()).rejects.toThrow('unable to open database file');
    await expect(getDb()).resolves.toBe(handle);
    expect(sqlite.open).toHaveBeenCalledTimes(2);
  });

  it('a failed migration is forgotten too, and the retry completes it', async () => {
    const raw = pre0358Phone();
    let failures = 1;
    openReturns(raw, {
      beforeCall: (sql) => {
        if (/alter table pending_actions add column/i.test(sql) && failures > 0) {
          failures -= 1;
          throw new Error('database or disk is full');
        }
      },
    });
    const { getDb } = await freshDbModule();

    // The outbox columns are REQUIRED: their failure fails the open loudly.
    await expect(getDb()).rejects.toThrow('database or disk is full');
    const db = await getDb();
    const cols = (await db.getAllAsync<{ name: string }>('pragma table_info(pending_actions)')).map(
      (c) => c.name,
    );
    expect(cols).toEqual(expect.arrayContaining(['organization_id', 'user_id']));
    expect(raw.prepare('select count(*) as n from pending_actions').get()).toEqual({ n: 3 });
  });
});
