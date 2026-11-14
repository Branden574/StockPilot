import { DatabaseSync } from 'node:sqlite';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { nodeExpoDb } from './__fixtures__/expo-sqlite-node';

/**
 * A COUNT IS QUEUED ONLY FOR A LINE STILL ON THE PHONE WHEN IT IS WRITTEN.
 *
 * updateLocalLine looks the line up, then waits for whose edit it is, then
 * writes the count and its outbox row in one queued transaction. A wipe or a
 * pull that removes the line can run in between. The line is now looked up
 * again inside the transaction: when it is gone, nothing is written or
 * queued, and null comes back, so the count screen says "Count not saved"
 * (count-line-gone.test.ts) instead of marking a number saved that no line
 * holds. Against the real schema (db.ts ensureSchema on node:sqlite).
 */

const sqlite = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('expo-sqlite', () => ({ openDatabaseAsync: sqlite.open }));
vi.mock('./supabase', () => ({
  supabase: { auth: { getSession: async () => ({ data: { session: null }, error: null }) } },
  readDeviceAuthSession: async () => ({ present: true, userId: 'u1' }),
}));
// Whose edit it is: held until the test lets it answer.
const scope = vi.hoisted(() => ({ gate: Promise.resolve() as Promise<void> }));
vi.mock('./session-scope', () => ({
  outboxWriteScope: async () => {
    await scope.gate;
    return { orgId: 'org-a', userId: 'u1' };
  },
  liveOutboxScope: async () => ({ orgId: 'org-a', userId: 'u1' }),
}));

type Cache = typeof import('./cycle-count-cache');
let raw: DatabaseSync;
let cache: Cache;

const queued = () =>
  raw.prepare('select count(*) as n from pending_actions').get() as { n: number };

beforeEach(async () => {
  raw = new DatabaseSync(':memory:');
  const handle = nodeExpoDb(raw);
  sqlite.open.mockReset().mockImplementation(async () => handle);
  vi.resetModules();
  cache = await import('./cycle-count-cache');
  await (await import('./db')).getDb();
  raw
    .prepare(
      `insert into cycle_count_lines (id, count_id, item_id, expected, counted, local_dirty)
       values ('l1', 'cc1', 'i1', 10, null, 0)`,
    )
    .run();
});

describe('updateLocalLine', () => {
  it('a line still on the phone: the count is written and queued, as before', async () => {
    const res = await cache.updateLocalLine('l1', 7);
    expect(res).not.toBeNull();
    expect(queued().n).toBe(1);
  });

  it('a line removed after it was looked up: nothing is queued, and null comes back', async () => {
    let release!: () => void;
    scope.gate = new Promise<void>((r) => {
      release = r;
    });
    const saving = cache.updateLocalLine('l1', 7);
    // The line goes while the edit waits to be written (a wipe, a pull).
    await new Promise((r) => setTimeout(r, 5));
    raw.prepare("delete from cycle_count_lines where id = 'l1'").run();
    release();
    expect(await saving).toBeNull();
    expect(queued().n).toBe(0);
    scope.gate = Promise.resolve();
  });

  it('a clear of a line removed the same way: nothing is queued either', async () => {
    raw.prepare("update cycle_count_lines set counted = 4 where id = 'l1'").run();
    let release!: () => void;
    scope.gate = new Promise<void>((r) => {
      release = r;
    });
    const clearing = cache.clearLocalLine('l1');
    await new Promise((r) => setTimeout(r, 5));
    raw.prepare("delete from cycle_count_lines where id = 'l1'").run();
    release();
    expect(await clearing).toBeNull();
    expect(queued().n).toBe(0);
    scope.gate = Promise.resolve();
  });
});
