import { readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it, vi } from 'vitest';

import { withDbTransaction } from './db';

// db.ts pulls in expo-sqlite (native): mocked wholesale, vitest runs in node.
// The mock is never exercised; these tests drive withDbTransaction against
// a real SQLite connection wrapped in expo-sqlite's own transaction code.
vi.mock('expo-sqlite', () => ({ openDatabaseAsync: vi.fn() }));

/**
 * One real SQLite connection behind expo-sqlite's async surface. Every call
 * yields first, as the native bridge does, and withTransactionAsync is
 * expo-sqlite 57's implementation line for line (SQLiteDatabase.ts):
 * BEGIN, task, COMMIT, and ROLLBACK on any throw.
 */
function expoLikeConnection() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('create table t (v text not null)');
  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  const conn = {
    async execAsync(sql: string) {
      await tick();
      raw.exec(sql);
    },
    async runAsync(sql: string, params: string[]) {
      await tick();
      raw.prepare(sql).run(...params);
    },
    async withTransactionAsync(task: () => Promise<void>) {
      try {
        await conn.execAsync('BEGIN');
        await task();
        await conn.execAsync('COMMIT');
      } catch (e) {
        await conn.execAsync('ROLLBACK');
        throw e;
      }
    },
    rows: () => (raw.prepare('select v from t order by rowid').all() as { v: string }[]).map((r) => r.v),
  };
  return conn;
}

type Conn = ReturnType<typeof expoLikeConnection>;

/** A snapshot-pull-shaped transaction: several statements with awaits between. */
const pull = (conn: Conn) => async () => {
  for (const v of ['pull-1', 'pull-2', 'pull-3']) await conn.runAsync('insert into t (v) values (?)', [v]);
};
/** A screen caching what it fetched, started while the pull is mid-way. */
const cache = (conn: Conn) => async () => {
  await conn.runAsync('insert into t (v) values (?)', ['cache-1']);
};

describe('two overlapping transactions on one connection', () => {
  it('without the queue: the second BEGIN fails and its ROLLBACK undoes the first transaction (the simulator log)', async () => {
    const conn = expoLikeConnection();
    const results = await Promise.allSettled([
      conn.withTransactionAsync(pull(conn)),
      conn.withTransactionAsync(cache(conn)),
    ]);
    const errors = results.map((r) => (r.status === 'rejected' ? String((r.reason as Error).message) : 'ok'));
    expect(errors[1]).toMatch(/cannot start a transaction within a transaction/);
    expect(errors[0]).toMatch(/no transaction is active/);
    // pull-1 was rolled back by the other caller; the rest autocommitted.
    expect(conn.rows()).toEqual(['pull-2', 'pull-3']);
  });

  it('with withDbTransaction: both commit, whole and in call order', async () => {
    const conn = expoLikeConnection();
    await Promise.all([withDbTransaction(conn, pull(conn)), withDbTransaction(conn, cache(conn))]);
    expect(conn.rows()).toEqual(['pull-1', 'pull-2', 'pull-3', 'cache-1']);
  });

  it('a failed transaction rolls back only itself and does not block the next one', async () => {
    const conn = expoLikeConnection();
    const failing = withDbTransaction(conn, async () => {
      await conn.runAsync('insert into t (v) values (?)', ['doomed']);
      throw new Error('boom');
    });
    const next = withDbTransaction(conn, cache(conn));
    await expect(failing).rejects.toThrow('boom');
    await next;
    expect(conn.rows()).toEqual(['cache-1']);
  });
});

describe('every transaction in the app goes through the queue', () => {
  const root = path.join(__dirname, '../..');
  const sources = (dir: string): string[] =>
    readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((e) => {
      const rel = path.join(dir, e.name);
      // __fixtures__ is test support (the node:sqlite stand-in for expo-sqlite
      // implements withTransactionAsync itself), never shipped app code.
      if (e.isDirectory()) return e.name === 'node_modules' || e.name === '__fixtures__' ? [] : sources(rel);
      return /\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [rel] : [];
    });

  it('only db.ts calls withTransactionAsync, and nothing opens a transaction by hand', () => {
    const offenders = [...sources('src'), ...sources('app')].filter((f) => {
      const src = readFileSync(path.join(root, f), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
      const direct = /\.with(Exclusive)?Transaction(Async|Sync)\(/.test(src) && f !== path.join('src', 'lib', 'db.ts');
      const manual = /['"`]\s*BEGIN\b/i.test(src);
      return direct || manual;
    });
    expect(offenders).toEqual([]);
  });
});

describe('the cache wipes wait their turn', () => {
  const db = readFileSync(path.join(__dirname, 'db.ts'), 'utf8');
  const body = (name: string) => db.slice(db.indexOf(`export async function ${name}`)).split('\n}\n')[0] ?? '';

  it('deleteOrgData (workspace switch), wipeForSignOut and wipeForEviction run through the queue', () => {
    // A wipe interleaving with a snapshot pull mid-write would let the old
    // workspace's rows land after it (sync.ts checks the workspace inside its
    // own queued transaction).
    expect(body('deleteOrgData')).toContain('await withDbTransaction(db, () => clearOrgScopedTables(db));');
    // Sign-out clears the cache and KEEPS the outbox, held for its account (S4b).
    expect(body('wipeForSignOut')).toContain('await withDbTransaction(db, () => clearOrgScopedTables(db));');
    expect(body('wipeForSignOut')).not.toContain('pending_actions');
    // Only the eviction of a disabled account drops what is left unsent.
    expect(body('wipeForEviction')).toMatch(/await withDbTransaction\(db, async \(\) => \{\s+await clearOrgScopedTables\(db\);[\s\S]*delete from pending_actions/);
  });

  it('every wipe bumps the cache generation first, before it waits in the queue', () => {
    // sync.ts discards a snapshot whose generation moved; the bump must come
    // before the queue so a pull that is mid-write stops at its next row.
    expect(body('deleteOrgData')).toMatch(/^export async function deleteOrgData\(\): Promise<void> \{\s+cacheGeneration \+= 1;/);
    expect(body('wipeForSignOut')).toMatch(/^export async function wipeForSignOut\(\): Promise<void> \{\s+cacheGeneration \+= 1;/);
    expect(body('wipeForEviction')).toMatch(/^export async function wipeForEviction\(evictedUserId: string \| null\): Promise<void> \{\s+cacheGeneration \+= 1;/);
  });
});

describe('every outbox write commits on its own (queued), never inside someone else’s transaction', () => {
  /**
   * A plain runAsync issued while another flow's transaction is open executes
   * INSIDE it on expo-sqlite's single connection, and that flow's ROLLBACK
   * undoes it (outbox-owner.sqlite.test.ts executes the case). So every
   * exported function that writes pending_actions must go through the queue:
   * queuedWrite(...) or its own withDbTransaction(...). The one exception is
   * markRejectedWithin, which exists to be called from INSIDE a transaction.
   */
  const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  const functions = (file: string) => {
    const src = strip(readFileSync(path.join(__dirname, file), 'utf8'));
    return src
      .split(/\n(?=export async function )/)
      .filter((chunk) => chunk.startsWith('export async function '))
      .map((chunk) => ({
        name: /export async function (\w+)/.exec(chunk)?.[1] ?? '?',
        body: chunk,
      }));
  };
  const writesOutbox = (body: string) =>
    /(insert into|update|delete from)\s+pending_actions/.test(body);

  it.each(['queue.ts', 'cycle-count-cache.ts', 'db.ts'])('%s', (file) => {
    const writers = functions(file).filter((f) => writesOutbox(f.body));
    expect(writers.length).toBeGreaterThan(0);
    const unqueued = writers
      .filter((f) => f.name !== 'markRejectedWithin')
      .filter((f) => !/queuedWrite\(|withDbTransaction\(db/.test(f.body))
      .map((f) => f.name);
    expect(unqueued).toEqual([]);
  });
});
